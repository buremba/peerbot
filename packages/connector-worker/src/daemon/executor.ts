/**
 * Run Executor
 *
 * Executes sync and action runs via subprocess execution with compiled connector code.
 * Generates embeddings and streams results.
 */

import type { Checkpoint, Content } from '@lobu/connector-sdk';
import { generateEmbedding } from '../embeddings.js';
import {
  executeCompiledConnector,
  getActionOutput,
  normalizeEventEnvelope,
} from '../executor/runtime.js';
import { SubprocessExecutor } from '../executor/subprocess.js';
import type { Env } from '../types.js';
import type { ContentItem, ExecutorClient, PollResponse } from './client.js';

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
  if (job.run_type === 'action') {
    return executeActionRun(client, job, env, cfg);
  }
  if (job.run_type === 'watcher') {
    // Watcher reactions now execute inline in the API process (complete_window).
    // If a legacy pending watcher run is polled, mark it as completed to clean up.
    // Note: stuck runs older than the poll interval will be picked up here automatically.
    console.error(
      `[executor] Cleaning up legacy watcher run ${job.run_id} — reactions now execute inline`
    );
    await client.complete({
      run_id: job.run_id!,
      worker_id: client.id,
      status: 'success',
      items_collected: 0,
    });
    return { itemsCollected: 0 };
  }
  if (job.run_type === 'embed_backfill') {
    return executeEmbedBackfillRun(client, job, env);
  }
  if (job.run_type === 'auth') {
    return executeAuthRun(client, job, env, cfg);
  }
  return executeSyncRun(client, job, env, cfg);
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
    compiled_code,
  } = job;

  if (!run_id || !connector_key) {
    throw new Error('Invalid run: missing run_id or connector_key');
  }

  if (!compiled_code) {
    throw new Error(
      `Run ${run_id} (${connector_key}): No compiled code available. ` +
        'Ensure the connector has a compiled version.'
    );
  }

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
      mode: 'sync',
      compiledCode: compiled_code,
      config: (feedConfig ?? {}) as Record<string, unknown>,
      checkpoint: checkpoint as unknown as Checkpoint | null,
      env,
      connectionCredentials: ((job.connection_credentials as Record<string, string>) ??
        null) as Record<string, string | undefined> | null,
      sessionState: (job.session_state ?? null) as Record<string, unknown> | null,
      credentials,
      feedKey: feed_key,
      entityIds: job.entity_ids ?? [],
      apiType: 'api',
      executor: subprocessExecutor,
      hooks: {
        collectContents: false,
        onCheckpointUpdate: async (nextCheckpoint) => {
          lastCheckpoint = nextCheckpoint as Record<string, unknown> | null;
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
        onContentChunk: async (items) => {
          for (const item of items) {
            const contentItem = await processContent(item, cfg.generateEmbeddings);
            batch.push(contentItem);
            itemsCollectedSoFar++;

            if (batch.length >= cfg.batchSize) {
              await flushBatch();
            }
          }
        },
      },
    });

    lastCheckpoint = result.checkpoint as unknown as Record<string, unknown> | null;

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
  const { run_id, connector_key, action_key, action_input, credentials, compiled_code } = job;

  if (!run_id || !connector_key || !action_key) {
    throw new Error('Invalid action run: missing run_id, connector_key, or action_key');
  }

  if (!compiled_code) {
    throw new Error(`Action run ${run_id}: No compiled code available.`);
  }

  console.error(`[executor] Starting action run ${run_id} (${connector_key}/${action_key})`);

  try {
    const result = await executeCompiledConnector({
      mode: 'action',
      compiledCode: compiled_code,
      actionKey: action_key,
      actionInput: (action_input ?? {}) as Record<string, unknown>,
      env,
      connectionCredentials: ((job.connection_credentials as Record<string, string>) ??
        null) as Record<string, string | undefined> | null,
      credentials,
      apiType: 'api',
      executor: subprocessExecutor,
    });

    // For actions, the "contents" array may contain a single result envelope
    const actionOutput = getActionOutput(result);

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
  const { run_id, connector_key, compiled_code, previous_credentials } = job;

  if (!run_id || !connector_key) {
    throw new Error('Invalid auth run: missing run_id or connector_key');
  }
  if (!compiled_code) {
    throw new Error(`Auth run ${run_id}: No compiled code available.`);
  }

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
      mode: 'authenticate',
      compiledCode: compiled_code,
      previousCredentials: previous_credentials ?? null,
      env,
      executor: subprocessExecutor,
      apiType: 'api',
      hooks: {
        collectContents: false,
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

    if (!result.auth_result?.credentials) {
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
      credentials: result.auth_result.credentials,
      metadata: result.auth_result.metadata,
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
  _env: Env
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
      console.error(`[executor] Embed backfill run ${run_id}: invalid action_input JSON:`, msg);
      await client.complete({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: `Invalid action_input JSON: ${msg}`,
      });
      return { itemsCollected: 0, error: `Invalid action_input JSON: ${msg}` };
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

    // Generate embeddings for each event
    const results: Array<{ event_id: number; embedding: number[] }> = [];
    for (const event of events) {
      try {
        const textForEmbedding = [event.title, event.content].filter(Boolean).join(' ').trim();
        if (textForEmbedding) {
          const embedding = await generateEmbedding(textForEmbedding);
          if (embedding) {
            results.push({ event_id: event.id, embedding });
          }
        }
      } catch (err) {
        console.error(`[executor] Embedding failed for event ${event.id}:`, err);
      }
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
  }
}

/**
 * Process a content item - convert to ContentItem and optionally generate embedding
 */
async function processContent(item: Content, generateEmbeddings: boolean): Promise<ContentItem> {
  const normalized = normalizeEventEnvelope(item as Record<string, any>);
  const contentItem: ContentItem = {
    id: normalized.origin_id,
    title: normalized.title,
    payload_text: normalized.payload_text,
    author_name: normalized.author_name,
    occurred_at:
      normalized.occurred_at instanceof Date
        ? normalized.occurred_at.toISOString()
        : (normalized.occurred_at as unknown as string),
    source_url: normalized.source_url,
    score: normalized.score,
    metadata: normalized.metadata,
    origin_parent_id: normalized.origin_parent_id || undefined,
    origin_type: normalized.origin_type,
    semantic_type: normalized.semantic_type,
  };

  if (generateEmbeddings) {
    try {
      const textForEmbedding = [normalized.title, normalized.payload_text]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (textForEmbedding) {
        contentItem.embedding = await generateEmbedding(textForEmbedding);
      }
    } catch (err) {
      console.error(`[executor] Embedding generation failed for ${normalized.origin_id}:`, err);
    }
  }

  return contentItem;
}
