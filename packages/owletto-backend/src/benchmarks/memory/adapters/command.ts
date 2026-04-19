import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type {
  BenchmarkAdapter,
  CommandSystemConfig,
  RetrievalResult,
  RetrieveContext,
  ScenarioContext,
  TrialContext,
} from '../types';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  action: string;
}

interface ProtocolMessage {
  id?: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Long-lived subprocess adapter.
 *
 * Spawns the Python adapter once and frames each op as a single line of JSON
 * over stdin: {"id": N, "action": "...", "payload": {...}}. The adapter
 * replies with a matching {"id": N, "ok": ..., "result": ...} line on stdout.
 *
 * This avoids the ~250ms fork+exec cost per op that the previous one-shot
 * implementation paid — a 50-question LoCoMo run does ~1000 ops per system.
 */
export class CommandBenchmarkAdapter implements BenchmarkAdapter {
  readonly id: string;
  readonly label: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private stderrBuf = '';
  private requestCounter = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private exitError: Error | null = null;

  constructor(private readonly config: CommandSystemConfig) {
    this.id = config.id;
    this.label = config.label;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.exitError) throw this.exitError;

    const [bin, ...argv] = this.config.argv;
    if (!bin) {
      throw new Error(`Command adapter '${this.id}' has empty argv`);
    }

    const child = spawn(bin, argv, {
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
        // Force unbuffered stdout so responses arrive as soon as the adapter writes them.
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuf += chunk;
      this.drainStdout();
    });

    child.stderr.on('data', (chunk: string) => {
      this.stderrBuf += chunk;
      // Cap stderr buffer so a chatty adapter doesn't grow unbounded.
      if (this.stderrBuf.length > 64 * 1024) {
        this.stderrBuf = this.stderrBuf.slice(-32 * 1024);
      }
    });

    child.on('error', (err) => {
      this.failPending(err);
    });

    child.on('exit', (code, signal) => {
      const stderr = this.stderrBuf.trim();
      const detail = stderr ? `: ${stderr}` : '';
      const err = new Error(
        `Command adapter '${this.id}' exited (code=${code}, signal=${signal})${detail}`
      );
      this.exitError = err;
      this.child = null;
      this.failPending(err);
    });

    this.child = child;
    return child;
  }

  private drainStdout(): void {
    while (true) {
      const newline = this.stdoutBuf.indexOf('\n');
      if (newline === -1) return;
      const line = this.stdoutBuf.slice(0, newline).trim();
      this.stdoutBuf = this.stdoutBuf.slice(newline + 1);
      if (!line) continue;

      let message: ProtocolMessage;
      try {
        message = JSON.parse(line) as ProtocolMessage;
      } catch (_err) {
        // Non-JSON line on stdout — treat as fatal so the user sees it.
        const fatal = new Error(
          `Command adapter '${this.id}' wrote non-JSON line on stdout: ${line.slice(0, 200)}`
        );
        this.failPending(fatal);
        return;
      }

      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id === undefined) {
        // Unsolicited message — surface the error if any, otherwise ignore.
        if (!message.ok && message.error) {
          this.failPending(new Error(`Command adapter '${this.id}': ${message.error}`));
        }
        continue;
      }

      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(
          new Error(
            `Command adapter '${this.id}' action '${pending.action}' failed: ${message.error ?? 'unknown error'}`
          )
        );
      }
    }
  }

  private failPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private runCommand<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const child = this.ensureChild();
    const id = ++this.requestCounter;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        action,
      });
      const line = `${JSON.stringify({ id, action, payload })}\n`;
      const ok = child.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      if (!ok) {
        // Backpressure — wait for drain. Not an error, just tracked here for clarity.
        child.stdin.once('drain', () => {});
      }
    });
  }

  async reset(ctx: TrialContext): Promise<void> {
    await this.runCommand('reset', ctx as unknown as Record<string, unknown>);
  }

  async setup(ctx: TrialContext): Promise<void> {
    await this.runCommand('setup', ctx as unknown as Record<string, unknown>);
  }

  async ingestScenario(ctx: ScenarioContext): Promise<void> {
    await this.runCommand('ingest', ctx as unknown as Record<string, unknown>);
  }

  async retrieve(ctx: RetrieveContext): Promise<RetrievalResult> {
    return await this.runCommand<RetrievalResult>(
      'retrieve',
      ctx as unknown as Record<string, unknown>
    );
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    this.child = null;
  }
}
