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
import type { ExecutionHooks, FeedSyncResult, SyncContext, SyncExecutor } from './interface.js';
import { StreamRedactor, redactOutput } from './redact.js';

/**
 * exit_reason values surfaced to the runs table:
 *  - ok: successful 'result' IPC.
 *  - error_message: child sent {type:'error',...} via IPC.
 *  - timeout: parent killed the child with SIGKILL after timeoutMs.
 *  - oom: code !== 0 and output tail mentions a JS heap OOM.
 *  - crash: any other non-zero exit / unexpected signal.
 */
export type SubprocessExitReason = 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';

/** Diagnostic fields attached to errors thrown by the executor. */
export interface SubprocessDiagnostics {
  exitCode: number | null;
  exitSignal: string | null;
  outputTail: string;
  exitReason: SubprocessExitReason;
}

export class SubprocessError extends Error implements SubprocessDiagnostics {
  exitCode: number | null;
  exitSignal: string | null;
  outputTail: string;
  exitReason: SubprocessExitReason;

  constructor(
    message: string,
    diagnostics: SubprocessDiagnostics,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SubprocessError';
    this.exitCode = diagnostics.exitCode;
    this.exitSignal = diagnostics.exitSignal;
    this.outputTail = diagnostics.outputTail;
    this.exitReason = diagnostics.exitReason;
  }
}

/** Per-stream ring buffer that preserves the most recent bytes. */
class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const front = this.chunks[0];
      const overflow = this.size - this.cap;
      if (front.length <= overflow) {
        this.size -= front.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = front.slice(overflow);
        this.size -= overflow;
      }
    }
  }

  toString(): string {
    return this.chunks.join('');
  }
}

const STREAM_TAIL_CAP_BYTES = 16 * 1024;

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
      const isBun = typeof (process.versions as { bun?: string }).bun === 'string';
      if (!existsSync(childRunnerPath) && existsSync(childRunnerTsPath)) {
        childRunnerPath = childRunnerTsPath;
        // Bun runs .ts natively. Loading tsx as an ESM hook on Bun fails
        // with "Cannot find module './cjs/index.cjs' from ''" because tsx's
        // loader.mjs invokes module.register('./cjs/index.cjs') with a parent
        // URL that Bun's resolver treats as empty. Skip --import tsx on Bun.
        if (!isBun) execArgv.unshift('--import', 'tsx');
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
      let timedOut = false;
      let latestCheckpoint = context.checkpoint;
      let finalMetadata: Record<string, any> | undefined;
      let finalAuthUpdate: Record<string, any> | undefined;
      let finalAuthResult: FeedSyncResult['auth_result'] | undefined;
      const collectedContents: FeedSyncResult['contents'] = [];
      const collectContents = hooks?.collectContents !== false;
      let processingChain = Promise.resolve();

      // Per-stream ring buffers — preserve the *tail* (most recent bytes),
      // which is where the failure cause lands. Cap each at 16 KiB so a
      // chatty connector can't grow the worker's memory.
      const stdoutTail = new RingBuffer(STREAM_TAIL_CAP_BYTES);
      const stderrTail = new RingBuffer(STREAM_TAIL_CAP_BYTES);

      // Set timeout - kill child if it takes too long. timeoutMs <= 0 disables
      // the timer (used for interactive auth runs that wait on human input).
      const timeout =
        this.options.timeoutMs > 0
          ? setTimeout(() => {
              if (!resolved) {
                console.error(
                  `[SubprocessExecutor] Killing child process after ${this.options.timeoutMs}ms timeout`
                );
                timedOut = true;
                child.kill('SIGKILL');
              }
            }, this.options.timeoutMs)
          : null;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        // Flush any trailing partial line from each stream so the live tee
        // matches what the persisted tail saw.
        stdoutRedactor.flush((clean) => process.stdout.write(`[subprocess] ${clean}`));
        stderrRedactor.flush((clean) => process.stderr.write(`[subprocess] ${clean}`));
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

      const combinedTail = (): string => {
        const out = stdoutTail.toString();
        const err = stderrTail.toString();
        if (!out && !err) return '';
        if (!out) return `[stderr]\n${err}`;
        if (!err) return `[stdout]\n${out}`;
        return `[stdout]\n${out}\n[stderr]\n${err}`;
      };

      const computeExitReason = (tail: string): SubprocessExitReason => {
        if (timedOut) return 'timeout';
        if (/javascript heap out of memory/i.test(tail)) return 'oom';
        return 'crash';
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
          const tail = redactOutput(combinedTail());
          const diagnostics: SubprocessDiagnostics = {
            exitCode: null,
            exitSignal: null,
            outputTail: tail,
            exitReason: 'error_message',
          };
          // Connector code is allowed to throw with the offending value
          // embedded — `throw new Error('failed with api_key=sk_live_…')`.
          // Redact the message and stack the same way the persisted tail
          // is redacted so secrets don't leak through the error path
          // (which is also written to gateway logs by upstream callers).
          const rawMessage = msg.error?.message ?? 'Subprocess reported error';
          const error = new SubprocessError(redactOutput(rawMessage), diagnostics);
          error.name = msg.error?.name ?? 'SubprocessError';
          if (msg.error?.stack) error.stack = redactOutput(msg.error.stack);
          settle(() => reject(error));
          return;
        }
      };

      // Handle child errors
      const onError = (err: Error) => {
        const tail = redactOutput(combinedTail());
        const diagnostics: SubprocessDiagnostics = {
          exitCode: null,
          exitSignal: null,
          outputTail: tail,
          exitReason: 'crash',
        };
        const wrapped = new SubprocessError(`Subprocess error: ${err.message}`, diagnostics, {
          cause: err,
        });
        settle(() => reject(wrapped));
      };

      // Handle child exit (single handler for both timeout cleanup and unexpected exits)
      const onExit = (code: number | null, signal: string | null) => {
        if (terminalMessageReceived) {
          return;
        }
        settle(() => {
          const tail = redactOutput(combinedTail());
          const reason = computeExitReason(tail);
          const prefix =
            reason === 'timeout'
              ? `Feed execution timed out after ${this.options.timeoutMs}ms`
              : reason === 'oom'
                ? `Subprocess out of memory (code ${code}, signal ${signal})`
                : `Subprocess exited with code ${code}, signal ${signal}`;
          const message = tail ? `${prefix}\n${tail}` : prefix;
          const diagnostics: SubprocessDiagnostics = {
            exitCode: code,
            exitSignal: signal,
            outputTail: tail,
            exitReason: reason,
          };
          reject(new SubprocessError(message, diagnostics));
        });
      };

      // Forward child stdout to parent stdout for live tailing AND tap into
      // the ring buffer so we can surface the tail on failure. Without this
      // listener, stdio: 'pipe' fills the OS pipe buffer (~16-64 KB) and the
      // child blocks on its next console.log until SIGKILL.
      // Stream redactors buffer up to the last newline so secrets split
      // across chunk boundaries still match. Persisted tails already
      // redact the full ring-buffer string and are unaffected.
      const stdoutRedactor = new StreamRedactor();
      const stderrRedactor = new StreamRedactor();

      const onStdout = (data: Buffer) => {
        const text = data.toString();
        stdoutTail.append(text);
        stdoutRedactor.process(text, (clean) => process.stdout.write(`[subprocess] ${clean}`));
      };

      // Forward child stderr to parent stderr for logging + ring buffer.
      const onStderr = (data: Buffer) => {
        const text = data.toString();
        stderrTail.append(text);
        stderrRedactor.process(text, (clean) => process.stderr.write(`[subprocess] ${clean}`));
      };

      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);
      child.stdout?.on('data', onStdout);
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
