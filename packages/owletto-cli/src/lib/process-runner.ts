import { execFileSync, spawn } from 'node:child_process';
import { CliError, DependencyError } from './errors.ts';

export function checkBinary(name: string): string {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], { encoding: 'utf-8', timeout: 5000 }).trim();
    const first = out.split('\n')[0]?.trim();
    if (!first) throw new DependencyError(name);
    return first;
  } catch {
    throw new DependencyError(name);
  }
}

interface RunOptions {
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

    // Forward signals to child so Ctrl+C / terminal hangup propagate correctly.
    const forwardedSignals: NodeJS.Signals[] =
      process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    for (const sig of forwardedSignals) {
      process.on(sig, forwardSignal);
    }
    const removeSignalHandlers = () => {
      for (const sig of forwardedSignals) {
        process.off(sig, forwardSignal);
      }
    };

    child.on('close', (code, signal) => {
      removeSignalHandlers();
      if (signal) {
        reject(new CliError(`${binary} killed by signal ${signal}`, 128));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.on('error', (err) => {
      removeSignalHandlers();
      reject(new CliError(`Failed to start ${binary}: ${err.message}`));
    });
  });
}
