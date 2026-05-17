/**
 * Child Runner - Entry point for forked subprocess
 *
 * Receives compiled connector code + context via IPC,
 * dynamically imports the ConnectorRuntime class, and executes sync()/execute().
 * Streams normalized content chunks and checkpoint updates back via IPC.
 */

import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SyncResult } from '@lobu/connector-sdk';
import type { FeedSyncResult } from './interface.js';
import { normalizeEventEnvelope } from './runtime.js';

const CONTENT_CHUNK_SIZE = 100;

interface ChildMessage {
  compiledCode: string;
  context: {
    options: Record<string, any>;
    checkpoint: any;
    env: Record<string, string | undefined>;
    sessionState?: Record<string, any> | null;
    apiType: 'api' | 'browser';
  };
}

function stripInternalOptions(options: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!key.startsWith('__')) {
      result[key] = value;
    }
  }
  return result;
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

async function executeConnectorRuntime(instance: any, context: ChildMessage['context']) {
  const isAction = typeof context.options?.__action_key === 'string';
  const isAuth = context.options?.__auth_mode === true;
  const credentials = context.sessionState?.oauth ?? null;
  const publicConfig = stripInternalOptions(context.options ?? {});
  const runtimeConfig = {
    ...(context.env ?? {}),
    ...publicConfig,
  };

  if (isAuth) {
    const authResult = await instance.authenticate({
      config: (context.options?.__auth_config ?? {}) as Record<string, unknown>,
      previousCredentials: (context.options?.__auth_previous_credentials ?? null) as Record<
        string,
        unknown
      > | null,
      emit: async (artifact: Record<string, unknown>) => {
        await sendIPC({ type: 'auth_artifact', artifact });
      },
      awaitSignal: awaitAuthSignal,
      signal: authAbortController.signal,
    });

    if (!authResult?.credentials) {
      throw new Error('authenticate() returned no credentials');
    }

    const result: FeedSyncResult = {
      contents: [],
      checkpoint: null,
      auth_result: {
        credentials: authResult.credentials,
        metadata: authResult.metadata,
      },
    };
    return result;
  }

  if (isAction) {
    const actionKey = context.options.__action_key;
    const actionInput = (context.options.__action_input ?? {}) as Record<string, unknown>;
    const actionResult = await instance.execute({
      actionKey,
      input: actionInput,
      credentials,
      config: runtimeConfig,
    });

    if (!actionResult?.success) {
      throw new Error(actionResult?.error || `Action '${actionKey}' failed`);
    }

    const result: FeedSyncResult = {
      contents: [
        {
          origin_id: `action-${actionKey}-${Date.now()}`,
          payload_text: '',
          source_url: '',
          occurred_at: new Date(),
          score: 0,
          metadata: actionResult.output ?? {},
        },
      ],
      checkpoint: context.checkpoint ?? null,
      metadata: {
        items_found: 0,
        items_skipped: 0,
      },
    };
    return result;
  }

  const emitEvents = async (events: unknown[]) => {
    const normalized = events.map((event: any) => normalizeEventEnvelope(event));
    for (let index = 0; index < normalized.length; index += CONTENT_CHUNK_SIZE) {
      await sendIPC({
        type: 'content_chunk',
        items: normalized.slice(index, index + CONTENT_CHUNK_SIZE),
      });
    }
  };

  const updateCheckpoint = async (checkpoint: Record<string, unknown> | null) => {
    await sendIPC({ type: 'checkpoint_update', checkpoint: checkpoint ?? null });
  };

  const syncResult = (await instance.sync({
    feedKey: context.options?.__feed_key,
    config: runtimeConfig,
    checkpoint: context.checkpoint ?? null,
    credentials,
    entityIds: (context.options?.__entity_ids as number[] | undefined) ?? [],
    sessionState: context.sessionState ?? null,
    emitEvents,
    updateCheckpoint,
  })) as SyncResult;

  const events = Array.isArray(syncResult?.events) ? syncResult.events : [];
  await emitEvents(events);
  const result: FeedSyncResult = {
    contents: [],
    checkpoint: (syncResult?.checkpoint ?? null) as any,
    auth_update: syncResult?.auth_update ?? undefined,
    metadata: {
      items_found:
        typeof syncResult?.metadata?.items_found === 'number'
          ? syncResult.metadata.items_found
          : events.length,
      items_skipped:
        typeof syncResult?.metadata?.items_skipped === 'number'
          ? syncResult.metadata.items_skipped
          : 0,
      ...(syncResult?.metadata ?? {}),
    },
  };
  return result;
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
      const { compiledCode, context } = msg as ChildMessage;

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
      const result = await executeConnectorRuntime(instance, context);

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
