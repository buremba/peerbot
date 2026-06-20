/**
 * Child Runner - Entry point for forked subprocess
 *
 * Receives compiled connector code + an ExecutorJob via IPC, dynamically
 * imports the ConnectorRuntime class, and dispatches to sync() / execute() /
 * authenticate() using the V1 SDK shapes directly — no magic-key adapter.
 */

import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventEnvelope, SyncResult } from '@lobu/connector-sdk';
import type { ExecutorJob, ExecutorResult } from './interface.js';

const EVENT_CHUNK_SIZE = 100;

interface ChildMessage {
  compiledCode: string;
  job: ExecutorJob;
}

function findRuntimeClass(mod: Record<string, unknown>) {
  const isConnectorRuntimeClass = (val: unknown): val is new () => any =>
    typeof val === 'function' &&
    !!(val as any).prototype?.sync &&
    !!(val as any).prototype?.execute;

  const connector = Object.values(mod).find(isConnectorRuntimeClass);
  if (connector) return connector;

  if (isConnectorRuntimeClass((mod as any).default)) return (mod as any).default;

  return null;
}

// ---------------------------------------------------------------------------
// Auth-mode reverse channel: the parent process owns HTTP calls; the child
// talks to it via IPC. Each awaitSignal() call gets a unique request id.
// ---------------------------------------------------------------------------

let nextSignalRequestId = 1;
const pendingSignalWaiters = new Map<
  number,
  { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
>();
const authAbortController = new AbortController();

// ---------------------------------------------------------------------------
// Chrome-action dispatch reverse channel: connectors call
// `ctx.sessionState.chrome_dispatcher.dispatch(action_key, input)` from inside
// `sync()`; the call is routed over IPC to the parent (connector-worker
// daemon), which posts to the gateway's
// /api/workers/dispatch-chrome-action endpoint. The endpoint inserts a chrome
// connector action run, waits for the paired Owletto extension to claim +
// complete it, and returns the action_output back along the chain.
//
// One IPC request id per call. Resolves with the observation; rejects with
// the gateway-side error_message on failure.
// ---------------------------------------------------------------------------

let nextDispatchRequestId = 1;
const pendingDispatchWaiters = new Map<
  number,
  { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
>();

// Hard ceiling per dispatch. The gateway bridge itself caps at
// QUEUE_BUDGET_MS (60s) + POST_CLAIM_BUDGET_MS (120s) = 180s, plus a small
// buffer for HTTP round-trip. We give the child 240s before forcibly
// rejecting so a wedged daemon/IPC channel can't leave sync() hanging
// indefinitely. Caught by pi review of #1132.
const CHROME_DISPATCH_HARD_TIMEOUT_MS = 240_000;

function dispatchChromeAction(
  actionKey: string,
  actionInput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const requestId = nextDispatchRequestId++;
    const timer = setTimeout(() => {
      if (pendingDispatchWaiters.delete(requestId)) {
        reject(
          new Error(
            `chrome_dispatcher.dispatch('${actionKey}') exceeded ${CHROME_DISPATCH_HARD_TIMEOUT_MS}ms; IPC may be wedged`
          )
        );
      }
    }, CHROME_DISPATCH_HARD_TIMEOUT_MS);
    pendingDispatchWaiters.set(requestId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    sendIPC({
      type: 'chrome_dispatch_request',
      requestId,
      actionKey,
      actionInput,
    }).catch((err: unknown) => {
      if (pendingDispatchWaiters.delete(requestId)) {
        clearTimeout(timer);
        reject(
          new Error(
            `chrome_dispatcher.dispatch('${actionKey}') IPC send failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });
  });
}

function awaitAuthSignal(
  name: string,
  options?: { timeoutMs?: number }
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const requestId = nextSignalRequestId++;
    let timer: NodeJS.Timeout | undefined;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };

    pendingSignalWaiters.set(requestId, {
      resolve: (v) => {
        clearTimer();
        resolve(v);
      },
      reject: (e) => {
        clearTimer();
        reject(e);
      },
    });

    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        pendingSignalWaiters.delete(requestId);
        reject(new Error(`awaitSignal('${name}') timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    void sendIPC({
      type: 'await_signal_request',
      requestId,
      name,
      timeoutMs: options?.timeoutMs ?? null,
    });
  });
}

async function executeConnectorRuntime(
  instance: any,
  job: ExecutorJob
): Promise<ExecutorResult> {
  if (job.mode === 'authenticate') {
    const authResult = await instance.authenticate({
      config: job.config,
      previousCredentials: job.previousCredentials,
      emit: async (artifact: Record<string, unknown>) => {
        await sendIPC({ type: 'auth_artifact', artifact });
      },
      awaitSignal: awaitAuthSignal,
      signal: authAbortController.signal,
    });

    if (!authResult?.credentials) {
      throw new Error('authenticate() returned no credentials');
    }

    return {
      mode: 'authenticate',
      auth: { credentials: authResult.credentials, metadata: authResult.metadata },
    };
  }

  if (job.mode === 'action') {
    // Splice the same live `chrome_dispatcher` onto the action context that
    // syncs get, so on-demand actions can drive the paired Owletto extension
    // (e.g. scrape a page the agent picked at runtime). Re-created in the child
    // every run — it closes over the IPC channel and can't travel the wire.
    const sessionStateForAction = {
      ...(job.sessionState ?? {}),
      chrome_dispatcher: {
        dispatch: (actionKey: string, actionInput: Record<string, unknown>) =>
          dispatchChromeAction(actionKey, actionInput),
      },
    } as Record<string, unknown>;

    const actionResult = await instance.execute({
      actionKey: job.actionKey,
      input: job.actionInput,
      sessionState: sessionStateForAction,
      credentials: job.credentials,
      config: { ...job.env, ...job.config },
    });

    if (!actionResult?.success) {
      throw new Error(actionResult?.error || `Action '${job.actionKey}' failed`);
    }

    return { mode: 'action', output: actionResult.output ?? {} };
  }

  if (job.mode === 'webhook_register') {
    const registration = await instance.registerWebhook({
      config: { ...job.env, ...job.config },
      credentials: job.credentials,
      sessionState: job.sessionState,
      callbackUrl: job.callbackUrl,
    });
    if (!registration?.externalId) {
      throw new Error('registerWebhook() returned no externalId');
    }
    return { mode: 'webhook_register', registration };
  }

  if (job.mode === 'webhook_unregister') {
    await instance.unregisterWebhook({
      config: { ...job.env, ...job.config },
      credentials: job.credentials,
      sessionState: job.sessionState,
      externalId: job.externalId,
    });
    return { mode: 'webhook_unregister' };
  }

  if (job.mode === 'query') {
    // Live read: returns rows to the caller, persists nothing (like an action).
    const queryResult = await instance.query({
      feedKey: job.feedKey ?? undefined,
      query: job.query,
      config: { ...job.env, ...job.config },
      credentials: job.credentials,
      sessionState: job.sessionState,
      limit: job.limit,
      offset: job.offset,
      sort: job.sort,
    });
    return {
      mode: 'query',
      rows: queryResult.rows ?? [],
      columns: queryResult.columns,
      total: queryResult.total,
    };
  }

  // mode === 'sync'
  const emitEvents = async (events: EventEnvelope[]) => {
    for (let index = 0; index < events.length; index += EVENT_CHUNK_SIZE) {
      await sendIPC({
        type: 'event_chunk',
        events: events.slice(index, index + EVENT_CHUNK_SIZE),
      });
    }
  };

  const updateCheckpoint = async (checkpoint: Record<string, unknown> | null) => {
    await sendIPC({ type: 'checkpoint_update', checkpoint: checkpoint ?? null });
  };

  // Always splice a live `chrome_dispatcher` handle onto sessionState. The
  // dispatcher is a JS object that closes over the IPC channel — it can't
  // travel through the wire, so we re-create it in the child every run.
  // Connectors that don't need it simply ignore the field; calling
  // .dispatch() with no online paired Owletto extension surfaces a clean
  // error from the gateway-side bridge.
  const sessionStateForSync = {
    ...(job.sessionState ?? {}),
    chrome_dispatcher: {
      dispatch: (actionKey: string, actionInput: Record<string, unknown>) =>
        dispatchChromeAction(actionKey, actionInput),
    },
  } as Record<string, unknown>;

  const syncResult = (await instance.sync({
    feedKey: job.feedKey,
    feedId: job.feedId,
    config: { ...job.env, ...job.config },
    checkpoint: job.checkpoint,
    credentials: job.credentials,
    entityIds: job.entityIds,
    sessionState: sessionStateForSync,
    emitEvents,
    updateCheckpoint,
  })) as SyncResult;

  // Sync is streaming-only on the executor boundary: connectors that build
  // the full list before returning still arrive here as `syncResult.events`,
  // we just forward them through the same `emitEvents` IPC channel so the
  // parent sees one uniform stream regardless of whether the connector
  // streamed incrementally or returned in one shot.
  const trailingEvents = Array.isArray(syncResult?.events) ? syncResult.events : [];
  await emitEvents(trailingEvents);

  return {
    mode: 'sync',
    checkpoint: (syncResult?.checkpoint ?? null) as Record<string, unknown> | null,
    auth_update: syncResult?.auth_update ?? null,
    metadata: {
      items_found:
        typeof syncResult?.metadata?.items_found === 'number'
          ? syncResult.metadata.items_found
          : trailingEvents.length,
      items_skipped:
        typeof syncResult?.metadata?.items_skipped === 'number'
          ? syncResult.metadata.items_skipped
          : 0,
      ...(syncResult?.metadata ?? {}),
    },
  };
}

/** Send an IPC message and wait for it to be flushed to the parent. */
function sendIPC(msg: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.send!(msg, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Best-effort handlers for top-level errors that previously escaped the
 * runner's try/catch and surfaced as the bare wrapper string in the parent.
 * These do NOT catch SIGKILL, native crashes, OOM, or sync `process.exit()`;
 * those are surfaced via `exit_reason` in the parent SubprocessExecutor.
 */
function installUncaughtHandlers(): void {
  let handled = false;
  const safeStringify = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  };
  const handle = async (err: unknown) => {
    if (handled) return;
    handled = true;
    const e =
      err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeStringify(err));
    try {
      await sendIPC({
        type: 'error',
        error: {
          message: e.message,
          stack: e.stack,
          name: e.name,
        },
      });
    } catch {
      // If IPC is dead, the parent's exit-handler path will still produce
      // diagnostics from the output tail.
    } finally {
      process.exit(1);
    }
  };

  process.on('uncaughtException', (err) => {
    void handle(err);
  });
  process.on('unhandledRejection', (reason) => {
    void handle(reason);
  });
}

/**
 * If the parent dies without sending SIGKILL, the IPC channel disconnects
 * but the child keeps running connector code (especially a chatty HTTP loop
 * or a Playwright session) — leaving zombie subprocesses behind that nothing
 * cleans up until OOM. Exit promptly on parent disconnect so the OS reaps us.
 */
function installParentDeathHandlers(): void {
  // Best-effort: don't bother flushing IPC, the channel is already gone.
  // Exit code 143 = 128 + SIGTERM, conventional for "killed externally".
  process.on('disconnect', () => process.exit(143));
}

async function main() {
  installUncaughtHandlers();
  installParentDeathHandlers();
  let started = false;
  // Wait for message from parent
  process.on('message', async (msg: any) => {
    // Chrome-dispatch reverse channel: parent ships the
    // /dispatch-chrome-action observation (or error) back to us.
    if (msg?.type === 'chrome_dispatch_response') {
      const waiter = pendingDispatchWaiters.get(msg.requestId);
      if (waiter) {
        pendingDispatchWaiters.delete(msg.requestId);
        if (msg.error) {
          waiter.reject(new Error(String(msg.error)));
        } else {
          waiter.resolve((msg.output ?? {}) as Record<string, unknown>);
        }
      }
      return;
    }
    // Auth-mode reverse channel: parent sends signal payloads + abort.
    if (msg?.type === 'await_signal_response') {
      const waiter = pendingSignalWaiters.get(msg.requestId);
      if (waiter) {
        pendingSignalWaiters.delete(msg.requestId);
        if (msg.error) {
          waiter.reject(new Error(String(msg.error)));
        } else {
          waiter.resolve((msg.signal ?? {}) as Record<string, unknown>);
        }
      }
      return;
    }
    if (msg?.type === 'abort_auth') {
      authAbortController.abort();
      for (const [id, waiter] of pendingSignalWaiters.entries()) {
        waiter.reject(new Error('Auth run aborted'));
        pendingSignalWaiters.delete(id);
      }
      return;
    }

    if (started) return;
    started = true;

    // Keep temp module under cwd so bare imports (e.g. lobu) resolve via local node_modules.
    // Use a cryptographically random suffix (not pid+Date.now()) so a co-tenant
    // can't pre-create or guess the path. Combined with the `wx` open flag below
    // this prevents both symlink-swap (pointing tmpFile at another file the
    // worker can write) and pre-creation of a malicious .mjs that the worker
    // would otherwise overwrite then import.
    const tmpFile = join(
      process.cwd(),
      `.connector-child-${process.pid}-${randomBytes(16).toString('hex')}.mjs`
    );

    try {
      const { compiledCode, job } = msg as ChildMessage;

      // Write compiled code to temp file for dynamic import.
      // - `flag: 'wx'` fails if the file already exists (no symlink follow,
      //   no clobber of an attacker-planted file under cwd).
      // - `mode: 0o600` keeps the compiled bundle (which can contain
      //   connector-baked secrets and the freshly-decrypted credentials in
      //   process memory referenced by the bundle) unreadable by other
      //   local users on shared hosts. Umask cannot widen this.
      await writeFile(tmpFile, compiledCode, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });

      // Import the compiled module
      const mod = await import(pathToFileURL(tmpFile).href);

      const RuntimeClass = findRuntimeClass(mod);
      if (!RuntimeClass) {
        throw new Error(
          'No ConnectorRuntime class found. Expected a class with sync() and execute() methods.'
        );
      }

      const instance = new (RuntimeClass as new () => any)();
      const result = await executeConnectorRuntime(instance, job);

      // Send result back to parent (wait for IPC flush before exiting)
      await sendIPC({ type: 'result', result });
    } catch (error: any) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        const pkgMatch = error.message.match(/Cannot find package '([^']+)'/);
        const pkg = pkgMatch?.[1] ?? 'unknown';
        error.message =
          `Connector requires '${pkg}' but it's not installed in the runtime image. ` +
          `'${pkg}' is declared as an external dependency in EXTERNAL_RUNTIME_DEPS ` +
          `(packages/connector-worker/src/runtime-deps.ts). ` +
          `Add it to packages/connector-worker/package.json and rebuild the runtime image.`;
      }
      await sendIPC({
        type: 'error',
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });
    } finally {
      // Clean up temp file
      try {
        await rm(tmpFile, { force: true });
      } catch {
        // Ignore cleanup errors
      }

      // Exit after sending result
      process.exit(0);
    }
  });
}

main();
