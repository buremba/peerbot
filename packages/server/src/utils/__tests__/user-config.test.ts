import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUserServerConfigToEnv, loadUserServerConfig } from '../user-config';

const tempDirs: string[] = [];

function writeConfig(payload: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'lobu-user-config-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.config', 'lobu'), { recursive: true });
  const path = join(root, '.config', 'lobu', 'config.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

const ENV_KEYS = ['PORT', 'HOST', 'LOBU_CONTEXT'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('loadUserServerConfig', () => {
  it('returns undefined when the file is missing', () => {
    expect(loadUserServerConfig(join(tmpdir(), 'does-not-exist.json'))).toBeUndefined();
  });

  it('returns undefined when the JSON is malformed', () => {
    const path = writeConfig('not json');
    writeFileSync(path, '{not json');
    expect(loadUserServerConfig(path)).toBeUndefined();
  });

  it('returns the current managed context settings', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          url: 'http://localhost:8787/api/v1',
          lifecycle: 'managed',
          cwd: '/tmp/lobu-worktree',
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      lifecycle: 'managed',
      cwd: '/tmp/lobu-worktree',
      port: 8787,
      host: 'localhost',
    });
  });

  it('falls back to "lobu" when currentContext is missing', () => {
    const path = writeConfig({
      contexts: {
        lobu: {
          url: 'http://localhost:8788/api/v1',
          lifecycle: 'managed',
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      lifecycle: 'managed',
      port: 8788,
      host: 'localhost',
    });
  });

  it('honors the context override', () => {
    const path = writeConfig({
      currentContext: 'prod',
      contexts: {
        prod: { url: 'https://app.lobu.ai/api/v1', lifecycle: 'external' },
        local: {
          url: 'http://localhost:8789/api/v1',
          lifecycle: 'managed',
        },
      },
    });
    expect(loadUserServerConfig(path, 'local')).toEqual({
      lifecycle: 'managed',
      port: 8789,
      host: 'localhost',
    });
  });

  it('returns undefined when the context is external', () => {
    const path = writeConfig({
      currentContext: 'prod',
      contexts: { prod: { url: 'https://app.lobu.ai/api/v1', lifecycle: 'external' } },
    });
    expect(loadUserServerConfig(path)).toBeUndefined();
  });

  it('returns undefined when the context has no lifecycle marker', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: { local: { url: 'http://localhost:8787/api/v1' } },
    });
    expect(loadUserServerConfig(path)).toBeUndefined();
  });

  it('derives the default port for a scheme-only https URL', () => {
    const path = writeConfig({
      currentContext: 'prod',
      contexts: {
        prod: {
          url: 'https://example.com/api/v1',
          lifecycle: 'managed',
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      lifecycle: 'managed',
      port: 443,
      host: 'example.com',
    });
  });

  it('derives the default port for a scheme-only http URL', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          url: 'http://localhost/api/v1',
          lifecycle: 'managed',
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      lifecycle: 'managed',
      port: 80,
      host: 'localhost',
    });
  });

  it('strips IPv6 brackets from the derived host', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          url: 'http://[::1]:8787/api/v1',
          lifecycle: 'managed',
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      lifecycle: 'managed',
      port: 8787,
      host: '::1',
    });
  });

  it('reads legacy apiUrl + server lifecycle/cwd', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          apiUrl: 'http://localhost:8790/api/v1',
          server: { lifecycle: 'managed', cwd: '/tmp/legacy' },
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      lifecycle: 'managed',
      cwd: '/tmp/legacy',
      port: 8790,
      host: 'localhost',
    });
  });
});

describe('applyUserServerConfigToEnv', () => {
  it('fills missing env vars and leaves existing ones alone', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          url: 'http://cfg-host:9000/api/v1',
          lifecycle: 'managed',
        },
      },
    });

    process.env.HOST = 'env-host';

    applyUserServerConfigToEnv(path);

    expect(process.env.PORT).toBe('9000');
    expect(process.env.HOST).toBe('env-host');
  });

  it('no-ops when no config file is present', () => {
    applyUserServerConfigToEnv(join(tmpdir(), 'missing.json'));
    expect(process.env.PORT).toBeUndefined();
  });
});
