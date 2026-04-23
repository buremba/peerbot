/**
 * Subprocess Executor
 *
 * Executes compiled connector code in a forked child process.
 * Provides process isolation between the worker and connector code.
 * This is not a hardened security sandbox.
 */

import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionHooks, FeedSyncResult, SyncContext, SyncExecutor } from './interface';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Only pass system env vars that child processes need for module resolution and basic operation. */
const SYSTEM_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TZ',
  'NODE_ENV',
  'NODE_PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
];
function pickSystemEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of SYSTEM_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

interface SubprocessExecutorOptions {
  /** Maximum execution time in ms (default: 600000 = 10 minutes) */
  timeoutMs: number;
  /** Max old space size for the child process in MB (default: 512) */
  maxOldSpaceSize: number;
}

const DEFAULT_OPTIONS: SubprocessExecutorOptions = {
  timeoutMs: 600000,
  maxOldSpaceSize: 512,
};

export class SubprocessExecutor implements SyncExecutor {
  private options: SubprocessExecutorOptions;

  constructor(options?: Partial<SubprocessExecutorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute(
    compiledCode: string,
    context: SyncContext,
    hooks?: ExecutionHooks
  ): Promise<FeedSyncResult> {
    return new Promise<FeedSyncResult>((resolve, reject) => {
      let childRunnerPath = join(__dirname, 'child-runner.js');
      const childRunnerTsPath = join(__dirname, 'child-runner.ts');

      const execArgv = [`--max-old-space-size=${this.options.maxOldSpaceSize}`];
      if (!existsSync(childRunnerPath) && existsSync(childRunnerTsPath)) {
        childRunnerPath = childRunnerTsPath;
        execArgv.unshift('--import', 'tsx');
      }

      // Node subprocess execution is process isolation, not a security sandbox.
      // Keep permission flags disabled unless the connector runtime is made compatible.
      try {
        const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
        if (nodeVersion >= 20) {
          // Uncomment only when the connector runtime is compatible with Node permissions:
          // execArgv.push('--experimental-permission');
          // execArgv.push(`--allow-fs-read=/tmp/*,${__dirname}/*`);
          // execArgv.push('--allow-fs-write=/tmp/*');
        }
      } catch {
        // Ignore - permissions are best-effort
      }

      const child = fork(childRunnerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv,
        env: { ...pickSystemEnv(), ...context.env } as NodeJS.ProcessEnv,
      });

      let resolved = false;
      let terminalMessageReceived = false;
      let latestCheckpoint = context.checkpoint;
      let finalMetadata: Record<string, any> | undefined;
      let finalAuthUpdate: Record<string, any> | undefined;
      let finalAuthResult: FeedSyncResult['auth_result'] | undefined;
      const collectedContents: FeedSyncResult['contents'] = [];
      const collectContents = hooks?.collectContents !== false;
      let processingChain = Promise.resolve();

      // Set timeout - kill child if it takes too long. timeoutMs <= 0 disables
      // the timer (used for interactive auth runs that wait on human input).
      const timeout =
        this.options.timeoutMs > 0
          ? setTimeout(() => {
              if (!resolved) {
                console.error(
                  `[SubprocessExecutor] Killing child process after ${this.options.timeoutMs}ms timeout`
                );
                child.kill('SIGKILL');
              }
            }, this.options.timeoutMs)
          : null;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.stderr?.removeListener('data', onStderr);
      };

      const settle = (fn: () => void) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          fn();
        }
      };

      const queueTask = (task: () => Promise<void> | void) => {
        processingChain = processingChain.then(async () => {
          await task();
        });
        processingChain.catch((err) => {
          settle(() => {
            child.kill('SIGKILL');
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        });
      };

      // Handle messages from child
      const onMessage = (msg: any) => {
        if (msg.type === 'content_chunk') {
          const items = Array.isArray(msg.items) ? msg.items : [];
          queueTask(async () => {
            if (collectContents) {
              collectedContents.push(...items);
            }
            await hooks?.onContentChunk?.(items);
          });
          return;
        }

        if (msg.type === 'checkpoint_update') {
          latestCheckpoint = msg.checkpoint ?? null;
          queueTask(async () => {
            await hooks?.onCheckpointUpdate?.(latestCheckpoint);
          });
          return;
        }

        if (msg.type === 'auth_artifact') {
          queueTask(async () => {
            await hooks?.onAuthArtifact?.(msg.artifact ?? {});
          });
          return;
        }

        if (msg.type === 'await_signal_request') {
          const requestId = msg.requestId;
          const name = msg.name;
          const timeoutMs: number | null = msg.timeoutMs ?? null;
          queueTask(async () => {
            if (!hooks?.onAwaitAuthSignal) {
              try {
                child.send({
                  type: 'await_signal_response',
                  requestId,
                  error: 'awaitSignal is not supported in this context',
                });
              } catch {
                /* ignore */
              }
              return;
            }
            try {
              const signal = await hooks.onAwaitAuthSignal(name, {
                timeoutMs: timeoutMs ?? undefined,
              });
              child.send({ type: 'await_signal_response', requestId, signal });
            } catch (err) {
              child.send({
                type: 'await_signal_response',
                requestId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
          return;
        }

        if (msg.type === 'result') {
          terminalMessageReceived = true;
          const result = msg.result as FeedSyncResult;
          queueTask(async () => {
            finalMetadata = result.metadata;
            finalAuthUpdate = result.auth_update;
            finalAuthResult = result.auth_result;
            latestCheckpoint = result.checkpoint;

            if (Array.isArray(result.contents) && result.contents.length > 0) {
              if (collectContents) {
                collectedContents.push(...result.contents);
              }
              await hooks?.onContentChunk?.(result.contents);
            }

            settle(() =>
              resolve({
                contents: collectedContents,
                checkpoint: latestCheckpoint,
                metadata: finalMetadata,
                auth_update: finalAuthUpdate,
                auth_result: finalAuthResult,
              })
            );
          });
          return;
        }

        if (msg.type === 'error') {
          terminalMessageReceived = true;
          const error = new Error(msg.error.message);
          error.name = msg.error.name;
          error.stack = msg.error.stack;
          settle(() => reject(error));
          return;
        }
      };

      // Handle child errors
      const onError = (err: Error) => {
        settle(() => reject(new Error(`Subprocess error: ${err.message}`)));
      };

      // Handle child exit (single handler for both timeout cleanup and unexpected exits)
      const onExit = (code: number | null, signal: string | null) => {
        if (terminalMessageReceived) {
          return;
        }
        settle(() => {
          if (signal === 'SIGKILL') {
            reject(new Error(`Feed execution timed out after ${this.options.timeoutMs}ms`));
          } else {
            reject(new Error(`Subprocess exited with code ${code}, signal ${signal}`));
          }
        });
      };

      // Forward child stderr to parent stderr for logging
      const onStderr = (data: Buffer) => {
        process.stderr.write(`[subprocess] ${data.toString()}`);
      };

      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);
      child.stderr?.on('data', onStderr);

      // Send the compiled code and context to the child
      child.send({
        compiledCode,
        context: {
          options: context.options,
          checkpoint: context.checkpoint,
          env: context.env,
          sessionState: context.sessionState,
          apiType: context.apiType,
        },
      });
    });
  }
}
