import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  attachClaudeAutomation,
  detachClaudeAutomation,
  getClaudeAutomationAttachment,
  listClaudeAutomationAttachments,
} from '../daemon/claude-attachments.js';

const roots: string[] = [];

function newFile(): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'lobu-claude-attachments-test-'));
  roots.push(root);
  return { root, file: path.join(root, 'config', 'attachments.json') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Claude Automation attachment storage', () => {
  test('stores exact mappings atomically with private permissions and no credentials', async () => {
    const { root, file } = newFile();
    await attachClaudeAutomation('10', 'session-a', file);
    await attachClaudeAutomation('2', 'session-b', file);

    expect(await getClaudeAutomationAttachment('10', file)).toBe('session-a');
    expect(await listClaudeAutomationAttachments(file)).toEqual([
      { automationId: '2', sessionId: 'session-b' },
      { automationId: '10', sessionId: 'session-a' },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain('peerToken');
    expect(stored).not.toContain('bearer');
    expect(stored).not.toContain('LOBU_API_TOKEN');
    expect(
      readFileSync(file, 'utf8').includes('session-a')
    ).toBe(true);
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(root).toBeTruthy();
  });

  test('replaces one exact route and detaches without disturbing others', async () => {
    const { file } = newFile();
    await attachClaudeAutomation('1', 'one', file);
    await attachClaudeAutomation('2', 'two', file);
    await attachClaudeAutomation('1', 'three', file);
    expect(await getClaudeAutomationAttachment('1', file)).toBe('three');
    expect(await detachClaudeAutomation('1', file)).toBe(true);
    expect(await detachClaudeAutomation('1', file)).toBe(false);
    expect(await getClaudeAutomationAttachment('1', file)).toBeNull();
    expect(await getClaudeAutomationAttachment('2', file)).toBe('two');
  });

  test('rejects non-canonical, unsafe, and prototype-shaped Automation ids', async () => {
    const { file } = newFile();
    for (const id of ['0', '-1', '01', '1.5', '__proto__', '9007199254740992']) {
      await expect(attachClaudeAutomation(id, 'session', file)).rejects.toThrow(
        'positive safe integer'
      );
    }
  });

  test('fails closed on a corrupt attachment file', async () => {
    const { file } = newFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{broken');
    chmodSync(file, 0o600);
    await expect(getClaudeAutomationAttachment('7', file)).rejects.toThrow(
      'not valid JSON'
    );
  });

  test('fails closed when an existing attachment file is not private', async () => {
    const { file } = newFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, attachments: {} }), { mode: 0o644 });
    chmodSync(file, 0o644);
    await expect(getClaudeAutomationAttachment('7', file)).rejects.toThrow('mode 0600');
  });
});
