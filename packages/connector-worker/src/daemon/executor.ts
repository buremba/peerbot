/**
 * Run Executor
 *
 * Executes sync and action runs via subprocess execution with compiled connector code.
 * Generates embeddings and streams results.
 */

import type { Env, EventEnvelope } from '@lobu/connector-sdk';
import { compileConnectorFromFile, findBundledConnectorFile } from '../compile-connector.js';
import { batchGenerateEmbeddings } from '../embeddings.js';
import { executeCompiledConnector } from '../executor/runtime.js';
import { SubprocessExecutor } from '../executor/subprocess.js';
import type { ContentItem, ExecutorClient, PollResponse } from './client.js';

/**
 * Resolve the executable compiled code for a job.
 *
 * The gateway prefers omitting `compiled_code` for fleet workers and
 * relying on this side to find + compile the source locally from
 * `connector_key`. This saves the ~13 MB inline blob in poll responses
 * (lobu#771 postmortem trail; lobu#772 perf fix). Device workers and
 * DB-only user-uploaded connectors still receive `compiled_code`
 * directly — they don't have the connector source on disk.
 *
 * Gateway and worker images have different paths to the bundled source,
 * so the gateway sends only `connector_key` and each side resolves it
 * against its own filesystem.
 *
 * Returns `{ code }` on success or `{ error }` on failure. Callers must
 * surface the error to the gateway via `client.complete*` rather than
 * throwing — the daemon-level catch only logs, leaving runs stuck
 * `running` until stale-run reaping.
 */
type JobCodeResult = { ok: true; code: string } | { ok: false; error: string };

async function resolveJobCode(job: PollResponse): Promise<JobCodeResult> {
  if (job.compiled_code) return { ok: true, code: job.compiled_code };
  if (!job.connector_key) {
    return { ok: false, error: 'No compiled_code and no connector_key — gateway sent neither.' };
  }
  const localPath = findBundledConnectorFile(job.connector_key);
  if (!localPath) {
    return {
      ok: false,
      error:
        `connector_key '${job.connector_key}' did not resolve to a local source file. ` +
        `Either the connector isn't bundled in this worker image, or the key is malformed.`,
    };
  }
  try {
    const code = await compileConnectorFromFile(localPath);
    return { ok: true, code };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `esbuild failed for '${job.connector_key}' (${localPath}): ${msg}` };
  }
}

export interface ExecutorConfig {
  batchSize: number;
  heartbeatIntervalMs: number;
  generateEmbeddings: boolean;
  timeoutMs: number;
  maxOldSpaceSize: number;
}

const DEFAULT_CONFIG: ExecutorConfig = {
  batchSize: 10,
  heartbeatIntervalMs: 30000,
  generateEmbeddings: true,
  timeoutMs: 600000,
  maxOldSpaceSize: 1024,
};

/**
 * Execute a run (sync, action, or watcher).
 *
 * Dispatches to sync, action, or watcher execution based on run_type.
 */
export async function executeRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  config: Partial<ExecutorConfig> = {}
): Promise<{ itemsCollected: number; error?: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  switch (job.run_type) {
    case 'action':
      return executeActionRun(client, job, env, cfg);
    case 'watcher':
      // Watcher reactions execute inline in the API process (complete_window) and
      // the poll endpoint's run_type allowlist should never hand a watcher run to
      // this daemon. If one slips through (deploy skew, regression), do NOT mark
      // it success — that would stomp a live watcher run and prevent any retry.
      console.error(
        `[executor] Refusing to handle watcher run ${job.run_id} — watcher runs must not reach the connector-worker daemon`
      );
      return { itemsCollected: 0, error: 'watcher run not handled by daemon' };
    case 'embed_backfill':
      return executeEmbedBackfillRun(client, job, env, cfg);
    case 'auth':
      return executeAuthRun(client, job, env, cfg);
    default:
      return executeSyncRun(client, job, env, cfg);
  }
}

/**
 * Execute a sync run (feed data ingestion)
 */
async function executeSyncRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const subprocessExecutor = new SubprocessExecutor({
    timeoutMs: cfg.timeoutMs,
    maxOldSpaceSize: cfg.maxOldSpaceSize,
  });
  const {
    run_id,
    connector_key,
    feed_key,
    config: feedConfig,
    checkpoint,
    credentials,
  } = job;

  if (!run_id || !connector_key) {
    throw new Error('Invalid run: missing run_id or connector_key');
  }

  const codeResult = await resolveJobCode(job);
  if (!codeResult.ok) {
    const errorMessage = `Run ${run_id} (${connector_key}): ${codeResult.error}`;
    console.error('[executor]', errorMessage);
    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
      items_collected: 0,
    });
    return { itemsCollected: 0, error: errorMessage };
  }
  const compiled_code = codeResult.code;

  console.error(`[executor] Starting sync run ${run_id} (${connector_key}/${feed_key})`);

  // Set up heartbeat interval
  let heartbeatInterval: NodeJS.Timeout | undefined;
  let itemsCollectedSoFar = 0;

  const startHeartbeat = () => {
    heartbeatInterval = setInterval(async () => {
      try {
        await client.heartbeat(run_id, {
          items_collected_so_far: itemsCollectedSoFar,
        });
      } catch (err) {
        console.error('[executor] Heartbeat failed:', err);
      }
    }, cfg.heartbeatIntervalMs);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
  };

  startHeartbeat();

  try {
    let batch: ContentItem[] = [];
    let lastCheckpoint = checkpoint as unknown as Record<string, unknown> | null;

    const flushBatch = async () => {
      if (batch.length === 0) return;

      try {
        await client.stream({
          type: 'batch',
          run_id,
          items: batch,
          checkpoint: lastCheckpoint ?? undefined,
        });
      } catch (streamErr) {
        const batchIds = batch.map((b) => b.id);
        console.error(
          `[executor] Stream batch failed for run ${run_id} (${batchIds.length} items lost: ${batchIds.join(', ')}):`,
          streamErr
        );
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        throw new Error(
          `Stream batch failed: ${msg} (lost ${batchIds.length} items: ${batchIds.join(', ')})`
        );
      }

      batch = [];
    };

    const result = await executeCompiledConnector({
      compiledCode: compiled_code,
      nixPackages: job.nix_packages,
      executor: subprocessExecutor,
      job: {
        mode: 'sync',
        config: mergeEnv(env, job.connection_credentials, feedConfig),
        checkpoint: checkpoint as Record<string, unknown> | null,
        env,
        sessionState: (job.session_state ?? null) as Record<string, unknown> | null,
        credentials: credentials ?? null,
        feedKey: feed_key,
        entityIds: job.entity_ids ?? [],
      },
      hooks: {
        onCheckpointUpdate: async (nextCheckpoint) => {
          lastCheckpoint = nextCheckpoint;
          if (!lastCheckpoint) return;
          try {
            await client.stream({
              type: 'batch',
              run_id,
              items: [],
              checkpoint: lastCheckpoint,
            });
          } catch (err) {
            console.error('[executor] Checkpoint flush failed:', err);
          }
        },
        onEventChunk: async (events) => {
          const contentItems = await processEventChunk(events, cfg.generateEmbeddings);
          for (const contentItem of contentItems) {
            batch.push(contentItem);
            itemsCollectedSoFar++;

            if (batch.length >= cfg.batchSize) {
              await flushBatch();
            }
          }
        },
      },
    });

    if (result.mode !== 'sync') {
      throw new Error(`Expected sync result, got mode=${result.mode}`);
    }
    lastCheckpoint = result.checkpoint;

    await flushBatch();

    stopHeartbeat();

    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'success',
      items_collected: itemsCollectedSoFar,
      checkpoint: lastCheckpoint ?? undefined,
      auth_update: result.auth_update ?? undefined,
    });

    console.error(`[executor] Sync run ${run_id} completed: ${itemsCollectedSoFar} items`);
    return { itemsCollected: itemsCollectedSoFar };
  } catch (error) {
    stopHeartbeat();

    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[executor] Sync run ${run_id} failed:`, errorMessage);

    const diag = extractSubprocessDiagnostics(error);

    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      items_collected: itemsCollectedSoFar,
      error_message: errorMessage,
      ...(diag ?? {}),
    });

    return { itemsCollected: itemsCollectedSoFar, error: errorMessage };
  }
}

/**
 * Pull diagnostic fields off a SubprocessError-shaped error so the worker
 * can persist them on the failed run row. Returns `undefined` when the
 * thrown value isn't a subprocess failure (e.g. a stream/HTTP error).
 */
function extractSubprocessDiagnostics(error: unknown):
  | {
      output_tail?: string;
      exit_code?: number | null;
      exit_signal?: string | null;
      exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
    }
  | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    exitReason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
    exitCode?: number | null;
    exitSignal?: string | null;
    outputTail?: string;
  };
  if (!e.exitReason && e.exitCode === undefined && !e.outputTail) return undefined;
  return {
    output_tail: e.outputTail || undefined,
    exit_code: e.exitCode ?? null,
    exit_signal: e.exitSignal ?? null,
    exit_reason: e.exitReason,
  };
}

/**
 * Execute an action run (async action with approval)
 */
async function executeActionRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const subprocessExecutor = new SubprocessExecutor({
    timeoutMs: cfg.timeoutMs,
    maxOldSpaceSize: cfg.maxOldSpaceSize,
  });
  const { run_id, connector_key, action_key, action_input, credentials } = job;

  if (!run_id || !connector_key || !action_key) {
    throw new Error('Invalid action run: missing run_id, connector_key, or action_key');
  }

  const codeResult = await resolveJobCode(job);
  if (!codeResult.ok) {
    const errorMessage = `Action run ${run_id} (${connector_key}): ${codeResult.error}`;
    console.error('[executor]', errorMessage);
    await client.completeAction({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });
    return { itemsCollected: 0, error: errorMessage };
  }
  const compiled_code = codeResult.code;

  console.error(`[executor] Starting action run ${run_id} (${connector_key}/${action_key})`);

  // Heartbeat so the gateway's stale-run reaper doesn't write us off
  // mid-action. Action runs can legitimately take minutes (LLM calls,
  // long Playwright sessions, third-party API rate-limit waits); the
  // reaper's default threshold is 120s, so a 30s heartbeat gives ~3
  // ticks of grace. Without this the row sits "running" until the worker
  // process dies, and the lane was previously excluded from the reaper
  // (lobu#859) because the heartbeat was missing.
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (err) {
      console.error('[executor] Action heartbeat failed:', err);
    }
  }, cfg.heartbeatIntervalMs);

  try {
    const result = await executeCompiledConnector({
      compiledCode: compiled_code,
      nixPackages: job.nix_packages,
      executor: subprocessExecutor,
      job: {
        mode: 'action',
        actionKey: action_key,
        actionInput: (action_input ?? {}) as Record<string, unknown>,
        config: mergeEnv(env, job.connection_credentials, null),
        env,
        sessionState: null,
        credentials: credentials ?? null,
      },
    });

    if (result.mode !== 'action') {
      throw new Error(`Expected action result, got mode=${result.mode}`);
    }
    const actionOutput = result.output;

    await client.completeAction({
      run_id,
      worker_id: client.id,
      status: 'success',
      action_output: actionOutput,
    });

    console.error(`[executor] Action run ${run_id} completed`);
    return { itemsCollected: 0 };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[executor] Action run ${run_id} failed:`, errorMessage);

    await client.completeAction({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });

    return { itemsCollected: 0, error: errorMessage };
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Execute an 'auth' run: drive connector.authenticate() and stream artifacts
 * to the UI via the API. On success, credentials land on the auth profile.
 */
async function executeAuthRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  // Interactive auth runs wait on human input (QR scans, OTP entry, OAuth
  // redirects) — a fixed subprocess timeout would kill the pairing mid-flow.
  // Terminate via the UI cancel signal instead.
  const subprocessExecutor = new SubprocessExecutor({
    timeoutMs: 0,
    maxOldSpaceSize: cfg.maxOldSpaceSize,
  });
  const { run_id, connector_key, previous_credentials } = job;

  if (!run_id || !connector_key) {
    throw new Error('Invalid auth run: missing run_id or connector_key');
  }
  const codeResult = await resolveJobCode(job);
  if (!codeResult.ok) {
    const errorMessage = `Auth run ${run_id} (${connector_key}): ${codeResult.error}`;
    console.error('[executor]', errorMessage);
    await client.completeAuth({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });
    return { itemsCollected: 0, error: errorMessage };
  }
  const compiled_code = codeResult.code;

  console.error(`[executor] Starting auth run ${run_id} (${connector_key})`);

  // Heartbeat so the API doesn't time us out while the user is scanning.
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (err) {
      console.error('[executor] Auth heartbeat failed:', err);
    }
  }, cfg.heartbeatIntervalMs);

  try {
    const result = await executeCompiledConnector({
      compiledCode: compiled_code,
      nixPackages: job.nix_packages,
      executor: subprocessExecutor,
      job: {
        mode: 'authenticate',
        config: {},
        previousCredentials: previous_credentials ?? null,
        env,
      },
      hooks: {
        onAuthArtifact: async (artifact) => {
          try {
            await client.emitAuthArtifact({
              run_id,
              worker_id: client.id,
              artifact,
            });
          } catch (err) {
            console.error('[executor] emitAuthArtifact failed:', err);
          }
        },
        onAwaitAuthSignal: async (name, opts) => {
          const deadline = opts?.timeoutMs ? Date.now() + opts.timeoutMs : null;
          while (true) {
            if (deadline !== null && Date.now() > deadline) {
              throw new Error(`awaitSignal('${name}') timed out`);
            }
            const resp = await client.pollAuthSignal({
              run_id,
              worker_id: client.id,
              signal_name: name,
            });
            if (resp.signal) return resp.signal;
            await delay(1500);
          }
        },
      },
    });

    clearInterval(heartbeatInterval);

    if (result.mode !== 'authenticate' || !result.auth?.credentials) {
      await client.completeAuth({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: 'authenticate() returned no credentials',
      });
      return { itemsCollected: 0, error: 'no credentials' };
    }

    await client.completeAuth({
      run_id,
      worker_id: client.id,
      status: 'success',
      credentials: result.auth.credentials,
      metadata: result.auth.metadata,
    });

    console.error(`[executor] Auth run ${run_id} completed`);
    return { itemsCollected: 0 };
  } catch (error) {
    clearInterval(heartbeatInterval);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[executor] Auth run ${run_id} failed:`, errorMessage);

    const diag = extractSubprocessDiagnostics(error);

    try {
      await client.completeAuth({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: errorMessage,
        ...(diag ?? {}),
      });
    } catch (completeErr) {
      console.error('[executor] completeAuth after failure errored:', completeErr);
    }
    return { itemsCollected: 0, error: errorMessage };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an embed_backfill run (generate embeddings for events missing them)
 */
async function executeEmbedBackfillRun(
  client: ExecutorClient,
  job: PollResponse,
  _env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const { run_id, action_input } = job;

  if (!run_id) {
    throw new Error('Invalid embed_backfill run: missing run_id');
  }

  // Parse event_ids from action_input
  let input: Record<string, unknown> | null | undefined;
  if (typeof action_input === 'string') {
    try {
      input = JSON.parse(action_input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMessage = `Invalid action_input JSON: ${msg}`;
      console.error(`[executor] Embed backfill run ${run_id}: invalid action_input JSON:`, msg);
      await client.complete({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: errorMessage,
      });
      return { itemsCollected: 0, error: errorMessage };
    }
  } else {
    input = action_input;
  }
  const eventIds: number[] = (input?.event_ids as number[]) ?? [];

  if (eventIds.length === 0) {
    console.error(`[executor] Embed backfill run ${run_id}: no event_ids`);
    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: 'No event_ids in action_input',
    });
    return { itemsCollected: 0, error: 'No event_ids' };
  }

  console.error(`[executor] Starting embed_backfill run ${run_id} for ${eventIds.length} events`);

  // Heartbeat so the gateway's stale-run reaper doesn't time us out.
  // Embed backfills can run for minutes on large batches (each embedding
  // call is a network round-trip + GPU/CPU work); the reaper threshold
  // is 120s, so a 30s heartbeat gives ~3 ticks of grace. This lane was
  // excluded from the reaper in lobu#859 because the heartbeat was
  // missing — now folded back in.
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (err) {
      console.error('[executor] Embed backfill heartbeat failed:', err);
    }
  }, cfg.heartbeatIntervalMs);

  try {
    // Fetch event content from the API
    const events = await client.fetchEventsForEmbedding(eventIds);

    if (events.length === 0) {
      console.error(`[executor] Embed backfill run ${run_id}: all events already have embeddings`);
      await client.completeEmbeddings({
        run_id,
        worker_id: client.id,
        embeddings: [],
        error_message: 'All events already have embeddings',
      });
      return { itemsCollected: 0 };
    }

    // Generate embeddings in batch — backfill runs are explicitly the
    // "lots of events" path, so batch through the service / vectorized local
    // pass instead of one round-trip per event.
    const pending = events
      .map((event) => ({
        event_id: event.id,
        text: [event.title, event.content].filter(Boolean).join(' ').trim(),
      }))
      .filter((p) => p.text.length > 0);

    const results: Array<{ event_id: number; embedding: number[]; embedding_model: string }> = [];
    try {
      const { embeddings, model } = await batchGenerateEmbeddings(pending.map((p) => p.text));
      for (let i = 0; i < pending.length; i++) {
        const embedding = embeddings[i];
        if (embedding) {
          results.push({ event_id: pending[i]!.event_id, embedding, embedding_model: model });
        }
      }
    } catch (err) {
      console.error(`[executor] Batch embedding failed for run ${run_id}:`, err);
    }

    // Submit embeddings back to the API
    await client.completeEmbeddings({
      run_id,
      worker_id: client.id,
      embeddings: results,
    });

    console.error(
      `[executor] Embed backfill run ${run_id} completed: ${results.length}/${events.length} embeddings`
    );
    return { itemsCollected: results.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[executor] Embed backfill run ${run_id} failed:`, errorMessage);

    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });

    return { itemsCollected: 0, error: errorMessage };
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Merge the run-level env, the per-connection stored credentials, and the
 * per-feed config into the single `config` object that the connector's
 * `sync()` / `execute()` sees. Connection credentials override env (per-conn
 * trumps fleet-wide); feed config wins last (per-feed trumps connection).
 */
function mergeEnv(
  env: Env,
  connectionCredentials: Record<string, unknown> | undefined | null,
  feedConfig: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    ...((connectionCredentials ?? {}) as Record<string, unknown>),
    ...((feedConfig ?? {}) as Record<string, unknown>),
  };
}

/**
 * Convert a V1 EventEnvelope (the SDK's standard sync output) into the
 * gateway-bound ContentItem shape (without an embedding).
 */
function toContentItem(event: EventEnvelope): ContentItem {
  const occurredAtIso =
    event.occurred_at instanceof Date
      ? event.occurred_at.toISOString()
      : (event.occurred_at as unknown as string);

  return {
    id: event.origin_id,
    title: event.title,
    payload_text: event.payload_text,
    author_name: event.author_name,
    occurred_at: occurredAtIso,
    source_url: event.source_url ?? undefined,
    score: typeof event.score === 'number' ? event.score : 0,
    metadata: event.metadata ?? {},
    origin_parent_id: event.origin_parent_id ?? undefined,
    origin_type: event.origin_type,
    semantic_type: event.semantic_type ?? event.origin_type,
  };
}

/**
 * Convert a chunk of events into ContentItems, generating embeddings for the
 * whole chunk in a single batch call (one HTTP round-trip / vectorized local
 * pass) instead of one per event. Vectors are mapped back to their source
 * event by index; events with empty text get no embedding. A batch failure is
 * logged and the items stream through without embeddings (same fail-open
 * behaviour as the previous per-event path).
 */
async function processEventChunk(
  events: EventEnvelope[],
  generateEmbeddings: boolean
): Promise<ContentItem[]> {
  const contentItems = events.map(toContentItem);

  if (!generateEmbeddings || contentItems.length === 0) {
    return contentItems;
  }

  // Collect the embeddable texts and remember which ContentItem each maps to,
  // so vectors line up after the batch call even though empty-text items are
  // skipped.
  const targets: number[] = [];
  const texts: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const text = [events[i]!.title, events[i]!.payload_text].filter(Boolean).join(' ').trim();
    if (text) {
      targets.push(i);
      texts.push(text);
    }
  }

  if (texts.length === 0) {
    return contentItems;
  }

  try {
    const { embeddings, model } = await batchGenerateEmbeddings(texts);
    for (let j = 0; j < targets.length; j++) {
      const embedding = embeddings[j];
      if (embedding) {
        const item = contentItems[targets[j]!]!;
        item.embedding = embedding;
        item.embedding_model = model;
      }
    }
  } catch (err) {
    console.error('[executor] Batch embedding generation failed for chunk:', err);
  }

  return contentItems;
}
