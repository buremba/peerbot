/**
 * Subprocess Executor
 *
 * Executes compiled connector code in a forked child process.
 * Provides process isolation between the worker and connector code.
 * This is not a hardened security sandbox.
 */

import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@lobu/connector-sdk';
import type { ExecutionHooks, ExecutorJob, ExecutorResult, SyncExecutor } from './interface.js';
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

function jobEnv(job: ExecutorJob): Record<string, string | undefined> {
  return job.env;
}

export class SubprocessExecutor implements SyncExecutor {
  private options: SubprocessExecutorOptions;

  constructor(options?: Partial<SubprocessExecutorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks
  ): Promise<ExecutorResult> {
    return new Promise<ExecutorResult>((resolve, reject) => {
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
      } else if (!existsSync(childRunnerPath)) {
        // Bundled runtime: this module is bundled into another package's
        // dist (e.g. packages/server/dist/server.bundle.mjs), so __dirname
        // is the bundle's directory rather than the sibling executor dir.
        // child-runner.js lives in connector-worker's own dist — resolve it
        // through Node's module resolver instead of by path arithmetic.
        try {
          const requireFromHere = createRequire(import.meta.url);
          childRunnerPath = requireFromHere.resolve(
            '@lobu/connector-worker/executor/child-runner'
          );
        } catch {
          // Fall through with the original join() path; fork() will surface
          // the missing-file error on the next tick.
        }
      }

      // Node subprocess execution is process isolation, not a security sandbox.
      // Node --experimental-permission flags intentionally NOT enabled — the
      // connector runtime isn't compatible. Revisit if that changes.
      const child = fork(childRunnerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv,
        env: { ...pickSystemEnv(), ...jobEnv(job) } as NodeJS.ProcessEnv,
      });

      let resolved = false;
      let terminalMessageReceived = false;
      let timedOut = false;
      let latestCheckpoint =
        job.mode === 'sync' ? job.checkpoint : null;
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
        const parts: string[] = [];
        if (out) parts.push(`[stdout]\n${out}`);
        if (err) parts.push(`[stderr]\n${err}`);
        return parts.join('\n');
      };

      const computeExitReason = (tail: string): SubprocessExitReason => {
        if (timedOut) return 'timeout';
        if (/javascript heap out of memory/i.test(tail)) return 'oom';
        return 'crash';
      };

      // Handle messages from child. The child runs untrusted connector code,
      // so validate shape at this trust boundary before dereferencing fields.
      const onMessage = (msg: any) => {
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        if (msg.type === 'event_chunk') {
          const events: EventEnvelope[] = Array.isArray(msg.events) ? msg.events : [];
          queueTask(async () => {
            await hooks?.onEventChunk?.(events);
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
              try {
                child.send({ type: 'await_signal_response', requestId, signal });
              } catch {
                /* IPC closed — child already exited. */
              }
            } catch (err) {
              try {
                child.send({
                  type: 'await_signal_response',
                  requestId,
                  error: err instanceof Error ? err.message : String(err),
                });
              } catch {
                /* IPC closed — child already exited. */
              }
            }
          });
          return;
        }

        if (msg.type === 'result') {
          terminalMessageReceived = true;
          const result = msg.result as ExecutorResult;
          queueTask(async () => {
            // For sync results, surface the trailing checkpoint to callers
            // through the result; in-flight `checkpoint_update` messages have
            // already been forwarded via the hook.
            if (result.mode === 'sync') {
              latestCheckpoint = result.checkpoint;
            }
            settle(() => resolve(result));
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
          // Redact `name` too — connector code can throw `class Err extends Error { name = '<secret>' }`
          // and Error.toString() / log formatters print `${name}: ${message}`.
          error.name = msg.error?.name ? redactOutput(String(msg.error.name)) : 'SubprocessError';
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

      // Hint to keep linter quiet when latestCheckpoint isn't consumed in
      // non-sync modes; it's the parent-side mirror of the sync checkpoint
      // stream and only relevant when hooks.onCheckpointUpdate is wired.
      void latestCheckpoint;

      // Send the compiled code and job descriptor to the child. Use the
      // callback form so a failed send (e.g. child died before IPC handshake,
      // or fork resolved to a non-existent file) rejects the executor promise
      // instead of going unhandled on the IPC channel.
      child.send(
        {
          compiledCode,
          job,
        },
        (err) => {
          if (err) {
            const tail = redactOutput(combinedTail());
            const diagnostics: SubprocessDiagnostics = {
              exitCode: null,
              exitSignal: null,
              outputTail: tail,
              exitReason: 'crash',
            };
            settle(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                /* already dead */
              }
              reject(
                new SubprocessError(`Subprocess IPC send failed: ${err.message}`, diagnostics, {
                  cause: err,
                })
              );
            });
          }
        }
      );
    });
  }
}
