import { execFileSync, spawn } from 'node:child_process';
import { CliError, DependencyError } from './errors.ts';

export function checkBinary(name: string): string {
  try {
    return execFileSync('which', [name], { encoding: 'utf-8' }).trim();
  } catch {
    throw new DependencyError(name);
  }
}

export interface RunOptions {
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** If true, inherits stdio directly (interactive mode) */
  stdio?: 'inherit' | 'pipe';
}

export function run(
  binary: string,
  opts: RunOptions
): Promise<{ code: number; stdout: string; stderr: string }> {
  const binPath = checkBinary(binary);

  return new Promise((resolve, reject) => {
    const child = spawn(binPath, opts.args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: opts.stdio || 'inherit',
    });

    let stdout = '';
    let stderr = '';

    if (opts.stdio === 'pipe') {
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
    }

    // Forward signals to child
    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);

    child.on('close', (code, signal) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);

      if (signal) {
        reject(new CliError(`${binary} killed by signal ${signal}`, 128));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.on('error', (err) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      reject(new CliError(`Failed to start ${binary}: ${err.message}`));
    });
  });
}
