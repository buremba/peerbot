import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { getProfile } from '../globals.ts';
import { isJson, printContextHeader, printJson, printText } from '../lib/output.ts';
import { checkBinary, run } from '../lib/process-runner.ts';

const COMPOSE_FILE = 'docker-compose.dev.yml';
const WATCH_PIDFILE = '.tmp/docker-compose-watch.pid';
const WATCH_LOG = '.tmp/docker-compose-watch.log';

function composeArgs(args: string[]): string[] {
  return ['compose', '-f', COMPOSE_FILE, ...args];
}

function readWatchPid(): number | null {
  try {
    const value = readFileSync(resolve(process.cwd(), WATCH_PIDFILE), 'utf-8').trim();
    if (!value) return null;
    const pid = Number.parseInt(value, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function stopWatchProcess() {
  const pid = readWatchPid();
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore stale pid
  }
}

function startWatchDetached() {
  mkdirSync(resolve(process.cwd(), '.tmp'), { recursive: true });
  const logFd = openSync(resolve(process.cwd(), WATCH_LOG), 'a');
  const child = spawn(checkBinary('docker'), composeArgs(['watch', '--no-up']), {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  writeFileSync(resolve(process.cwd(), WATCH_PIDFILE), String(child.pid));
  printText(`Started docker compose watch (PID ${child.pid})`);
}

const up = defineCommand({
  meta: { name: 'up', description: 'Start all development services' },
  args: {
    detach: { type: 'boolean', alias: 'd', description: 'Run watch in background' },
  },
  async run({ args }) {
    const profile = getProfile();
    printContextHeader(profile.name, 'dev up');

    await run('docker', { args: composeArgs(['up', '-d', '--build']) });

    stopWatchProcess();
    if (args.detach) {
      startWatchDetached();
      return;
    }

    const result = await run('docker', { args: composeArgs(['watch', '--no-up']) });
    process.exitCode = result.code;
  },
});

const down = defineCommand({
  meta: { name: 'down', description: 'Stop all development services' },
  async run() {
    const profile = getProfile();
    printContextHeader(profile.name, 'dev down');

    stopWatchProcess();
    const result = await run('docker', { args: composeArgs(['down', '--remove-orphans']) });
    process.exitCode = result.code;
  },
});

const status = defineCommand({
  meta: { name: 'status', description: 'Show status of development services' },
  async run() {
    const profile = getProfile();
    printContextHeader(profile.name, 'dev status');

    const result = await run('docker', {
      args: composeArgs(['ps', '--format', 'json']),
      stdio: isJson() ? 'pipe' : 'inherit',
    });

    if (isJson() && result.stdout) {
      try {
        const trimmed = result.stdout.trim();
        const data = trimmed.startsWith('[')
          ? JSON.parse(trimmed)
          : trimmed
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .map((line) => JSON.parse(line));
        printJson({ services: data }, profile);
      } catch {
        printJson({ raw: result.stdout }, profile);
      }
    }

    process.exitCode = result.code;
  },
});

const logs = defineCommand({
  meta: { name: 'logs', description: 'Tail logs from development services' },
  args: {
    process: { type: 'positional', description: 'Service name to tail (optional)' },
  },
  async run({ args }) {
    const profile = getProfile();
    printContextHeader(profile.name, 'dev logs');

    const pcArgs = composeArgs(['logs', '-f']);
    if (args.process) {
      pcArgs.push(args.process);
    }

    const result = await run('docker', { args: pcArgs });
    process.exitCode = result.code;
  },
});

export default defineCommand({
  meta: {
    name: 'dev',
    description: 'Manage local development services (powered by docker compose)',
  },
  subCommands: { up, down, status, logs },
});
