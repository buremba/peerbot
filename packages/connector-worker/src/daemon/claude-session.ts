import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CLAUDE_SESSIONS_DIR = path.join(homedir(), '.claude', 'sessions');

interface RegistryRecord {
  pid?: unknown;
  sessionId?: unknown;
  procStart?: unknown;
  peerProtocol?: unknown;
  kind?: unknown;
  messagingSocketPath?: unknown;
}

interface KeyRecord {
  peerToken?: unknown;
  procStart?: unknown;
}

export interface ResolvedClaudeSession {
  sessionId: string;
  pid: number;
  procStart: string;
  socketPath: string;
  peerToken: string;
}

export interface ClaudeSessionResolverOptions {
  sessionsDir?: string;
  uid?: number;
  processStart?: (pid: number) => string | null;
  spawnProcess?: typeof spawnSync;
  socketStat?: (socketPath: string) => { isSocket: () => boolean; uid: number };
}

function currentUid(explicit: number | undefined): number {
  if (explicit != null) return explicit;
  if (typeof process.getuid !== 'function') {
    throw new Error('attached Claude Automation routing requires a POSIX user and Unix sockets');
  }
  return process.getuid();
}

function readRegularJson(file: string): { value: unknown; uid: number } {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(file, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    return { value: JSON.parse(readFileSync(fd, 'utf8')), uid: stat.uid };
  } finally {
    closeSync(fd);
  }
}

function normalizeProcStart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function systemProcessStart(pid: number, spawnProcess = spawnSync): string | null {
  const result = spawnProcess('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const value = normalizeProcStart(result.stdout ?? '');
  return value === '' ? null : value;
}

function findRegistryRecord(
  sessionId: string,
  sessionsDir: string
): { file: string; record: RegistryRecord; uid: number } {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir).filter((entry) => entry.endsWith('.json'));
  } catch (error) {
    throw new Error(
      `Claude session registry is unavailable (${sessionsDir}): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const matches: Array<{ file: string; record: RegistryRecord; uid: number }> = [];
  for (const entry of entries) {
    const file = path.join(sessionsDir, entry);
    try {
      const decoded = readRegularJson(file);
      if (
        decoded.value != null &&
        typeof decoded.value === 'object' &&
        (decoded.value as RegistryRecord).sessionId === sessionId
      ) {
        matches.push({ file, record: decoded.value as RegistryRecord, uid: decoded.uid });
      }
    } catch {
      // Stale or partially-written records for other sessions do not make the
      // exact requested session unusable.
    }
  }
  if (matches.length === 0) {
    throw new Error(`Claude session '${sessionId}' is offline: no exact registry entry`);
  }
  if (matches.length !== 1) {
    throw new Error(`Claude session '${sessionId}' is unavailable: duplicate registry entries`);
  }
  return matches[0]!;
}

export function resolveClaudeSession(
  requestedSessionId: string,
  options: ClaudeSessionResolverOptions = {}
): ResolvedClaudeSession {
  const sessionId = requestedSessionId.trim();
  if (sessionId === '') throw new Error('Claude session id must not be empty');
  const sessionsDir = options.sessionsDir ?? DEFAULT_CLAUDE_SESSIONS_DIR;
  const uid = currentUid(options.uid);
  const match = findRegistryRecord(sessionId, sessionsDir);
  const record = match.record;

  if (match.uid !== uid) {
    throw new Error(
      `Claude session '${sessionId}' is unavailable: registry file ownership mismatch`
    );
  }
  if (record.kind !== 'interactive') {
    throw new Error(`Claude session '${sessionId}' is unavailable: kind is not interactive`);
  }
  if (record.peerProtocol !== 1) {
    throw new Error(`Claude session '${sessionId}' uses an unsupported local messaging protocol`);
  }
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
    throw new Error(`Claude session '${sessionId}' has an invalid process id`);
  }
  const pid = record.pid as number;
  if (path.basename(match.file) !== `${pid}.json`) {
    throw new Error(
      `Claude session '${sessionId}' registry filename does not match its process id`
    );
  }
  if (typeof record.procStart !== 'string' || record.procStart.trim() === '') {
    throw new Error(`Claude session '${sessionId}' has no process start identity`);
  }
  const procStart = normalizeProcStart(record.procStart);
  const liveProcStart = options.processStart
    ? options.processStart(pid)
    : systemProcessStart(pid, options.spawnProcess);
  if (liveProcStart == null || normalizeProcStart(liveProcStart) !== procStart) {
    throw new Error(`Claude session '${sessionId}' is offline: process identity no longer matches`);
  }
  if (
    typeof record.messagingSocketPath !== 'string' ||
    record.messagingSocketPath.includes('\0') ||
    !path.isAbsolute(record.messagingSocketPath)
  ) {
    throw new Error(`Claude session '${sessionId}' has a non-local messaging socket path`);
  }
  const socketPath = record.messagingSocketPath;
  let socketStat;
  try {
    socketStat = options.socketStat?.(socketPath) ?? lstatSync(socketPath);
  } catch {
    throw new Error(`Claude session '${sessionId}' is offline: messaging socket is missing`);
  }
  if (!socketStat.isSocket()) {
    throw new Error(
      `Claude session '${sessionId}' is unavailable: messaging path is not a Unix socket`
    );
  }
  if (socketStat.uid !== uid) {
    throw new Error(`Claude session '${sessionId}' is unavailable: socket ownership mismatch`);
  }

  const keyPattern = new RegExp(`^${pid}\\.[^.]+\\.key$`);
  const keys: string[] = [];
  for (const entry of readdirSync(sessionsDir)) {
    if (!keyPattern.test(entry)) continue;
    try {
      const decoded = readRegularJson(path.join(sessionsDir, entry));
      if (decoded.uid !== uid || decoded.value == null || typeof decoded.value !== 'object') {
        continue;
      }
      const key = decoded.value as KeyRecord;
      if (
        typeof key.peerToken === 'string' &&
        key.peerToken !== '' &&
        typeof key.procStart === 'string' &&
        normalizeProcStart(key.procStart) === procStart
      ) {
        keys.push(key.peerToken);
      }
    } catch {
      // A stale key cannot authenticate the exact live process and is ignored.
    }
  }
  if (keys.length === 0) {
    throw new Error(`Claude session '${sessionId}' is unavailable: no matching authenticated key`);
  }
  if (keys.length !== 1) {
    throw new Error(
      `Claude session '${sessionId}' is unavailable: multiple matching authenticated keys`
    );
  }

  return {
    sessionId,
    pid,
    procStart,
    socketPath,
    peerToken: keys[0]!,
  };
}

export async function sendClaudeSessionMessage(
  session: ResolvedClaudeSession,
  content: string,
  timeoutMs = 5000,
  connect: (socketPath: string) => net.Socket = net.createConnection
): Promise<void> {
  const frames = [
    JSON.stringify({ type: 'auth', token: session.peerToken }),
    JSON.stringify({ type: 'user', message: { role: 'user', content } }),
  ];
  await new Promise<void>((resolve, reject) => {
    const socket = connect(session.socketPath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    socket.setTimeout(timeoutMs, () => {
      finish(new Error(`Claude session '${session.sessionId}' socket write timed out`));
    });
    socket.once('error', (error) => {
      finish(
        new Error(
          `Claude session '${session.sessionId}' socket injection failed: ${error.message}`
        )
      );
    });
    socket.once('connect', () => {
      socket.write(`${frames[0]}\n`, (authError) => {
        if (authError) return finish(authError);
        socket.write(`${frames[1]}\n`, (messageError) => {
          if (messageError) return finish(messageError);
          socket.end(() => finish());
        });
      });
    });
  });
}
