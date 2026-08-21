import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
export const DEFAULT_CLAUDE_ATTACHMENTS_FILE = path.join(
  homedir(),
  '.config',
  'lobu',
  'claude-automation-attachments.json'
);

interface StoredAttachments {
  version: typeof STORE_VERSION;
  attachments: Record<string, string>;
}

export interface ClaudeAutomationAttachment {
  automationId: string;
  sessionId: string;
}

function normalizeAutomationId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric) || String(numeric) !== normalized) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function normalizeSessionId(value: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error('Claude session id must not be empty');
  return normalized;
}

function decodeStore(raw: string, file: string): StoredAttachments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Claude Automation attachment file is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== STORE_VERSION ||
    (parsed as Record<string, unknown>).attachments == null ||
    typeof (parsed as Record<string, unknown>).attachments !== 'object' ||
    Array.isArray((parsed as Record<string, unknown>).attachments)
  ) {
    throw new Error(`Claude Automation attachment file has an unsupported shape (${file})`);
  }

  const attachments = Object.create(null) as Record<string, string>;
  for (const [automationId, sessionId] of Object.entries(
    (parsed as StoredAttachments).attachments
  )) {
    normalizeAutomationId(automationId, 'Stored Automation id');
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error(`Claude Automation attachment file has an invalid entry (${file})`);
    }
    attachments[automationId] = sessionId;
  }
  return { version: STORE_VERSION, attachments };
}

async function readStore(file: string): Promise<StoredAttachments> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(file, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        version: STORE_VERSION,
        attachments: Object.create(null) as Record<string, string>,
      };
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Claude Automation attachment path is not a file (${file})`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`Claude Automation attachment file ownership mismatch (${file})`);
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`Claude Automation attachment file must have mode 0600 (${file})`);
    }
    return decodeStore(await handle.readFile('utf8'), file);
  } finally {
    await handle.close();
  }
}

async function writeStore(file: string, store: StoredAttachments): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.claude-automation-attachments.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getClaudeAutomationAttachment(
  automationId: string,
  file = DEFAULT_CLAUDE_ATTACHMENTS_FILE
): Promise<string | null> {
  const id = normalizeAutomationId(automationId, 'Automation id');
  return (await readStore(file)).attachments[id] ?? null;
}

export async function listClaudeAutomationAttachments(
  file = DEFAULT_CLAUDE_ATTACHMENTS_FILE
): Promise<ClaudeAutomationAttachment[]> {
  const store = await readStore(file);
  return Object.entries(store.attachments)
    .map(([automationId, sessionId]) => ({ automationId, sessionId }))
    .sort((a, b) => a.automationId.localeCompare(b.automationId, undefined, { numeric: true }));
}

export async function attachClaudeAutomation(
  automationId: string,
  sessionId: string,
  file = DEFAULT_CLAUDE_ATTACHMENTS_FILE
): Promise<void> {
  const id = normalizeAutomationId(automationId, 'Automation id');
  const session = normalizeSessionId(sessionId);
  const store = await readStore(file);
  store.attachments[id] = session;
  await writeStore(file, store);
}

export async function detachClaudeAutomation(
  automationId: string,
  file = DEFAULT_CLAUDE_ATTACHMENTS_FILE
): Promise<boolean> {
  const id = normalizeAutomationId(automationId, 'Automation id');
  const store = await readStore(file);
  if (!Object.hasOwn(store.attachments, id)) return false;
  delete store.attachments[id];
  await writeStore(file, store);
  return true;
}
