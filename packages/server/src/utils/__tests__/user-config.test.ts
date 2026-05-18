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

const ENV_KEYS = ['DATABASE_URL', 'PORT', 'HOST', 'LOBU_DATA_DIR', 'LOBU_CONTEXT'];
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

  it('returns the current context server block', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          apiUrl: 'http://localhost:8787/api/v1',
          server: {
            databaseUrl: 'postgres://burakemre@localhost:5432/lobu',
            port: 9000,
            host: '0.0.0.0',
            dataDir: '/tmp/lobu-data',
          },
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({
      databaseUrl: 'postgres://burakemre@localhost:5432/lobu',
      port: 9000,
      host: '0.0.0.0',
      dataDir: '/tmp/lobu-data',
    });
  });

  it('falls back to "lobu" when currentContext is missing', () => {
    const path = writeConfig({
      contexts: {
        lobu: {
          apiUrl: 'https://app.lobu.ai/api/v1',
          server: { databaseUrl: 'postgres://x/y' },
        },
      },
    });
    expect(loadUserServerConfig(path)).toEqual({ databaseUrl: 'postgres://x/y' });
  });

  it('honors the context override', () => {
    const path = writeConfig({
      currentContext: 'prod',
      contexts: {
        prod: { apiUrl: 'https://app.lobu.ai/api/v1', server: { port: 8080 } },
        local: {
          apiUrl: 'http://localhost:8787/api/v1',
          server: { databaseUrl: 'postgres://local/db' },
        },
      },
    });
    expect(loadUserServerConfig(path, 'local')).toEqual({
      databaseUrl: 'postgres://local/db',
    });
  });

  it('returns undefined when the server block is empty / invalid', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: { apiUrl: 'http://localhost:8787/api/v1', server: { port: 'nope' } },
      },
    });
    expect(loadUserServerConfig(path)).toBeUndefined();
  });

  it('returns undefined when the context has no server block', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: { local: { apiUrl: 'http://localhost:8787/api/v1' } },
    });
    expect(loadUserServerConfig(path)).toBeUndefined();
  });
});

describe('applyUserServerConfigToEnv', () => {
  it('fills missing env vars and leaves existing ones alone', () => {
    const path = writeConfig({
      currentContext: 'local',
      contexts: {
        local: {
          apiUrl: 'http://localhost:8787/api/v1',
          server: {
            databaseUrl: 'postgres://from-config/db',
            port: 9000,
            host: 'cfg-host',
            dataDir: '/cfg/data',
          },
        },
      },
    });

    process.env.DATABASE_URL = 'postgres://from-env/db';

    applyUserServerConfigToEnv(path);

    expect(process.env.DATABASE_URL).toBe('postgres://from-env/db');
    expect(process.env.PORT).toBe('9000');
    expect(process.env.HOST).toBe('cfg-host');
    expect(process.env.LOBU_DATA_DIR).toBe('/cfg/data');
  });

  it('no-ops when no config file is present', () => {
    applyUserServerConfigToEnv(join(tmpdir(), 'missing.json'));
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.PORT).toBeUndefined();
  });
});
