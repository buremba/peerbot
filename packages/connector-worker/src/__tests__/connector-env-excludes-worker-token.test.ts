/**
 * `WORKER_API_TOKEN` must never reach connector code.
 *
 * The token authenticates the worker to `/api/workers/*`. `poll.ts` treats a
 * request bearing it as a TRUSTED FLEET worker (claim branch 1A), so a leaked
 * token lets its holder claim and complete runs for other tenants — a much
 * wider grant than the connector's own scope.
 *
 * `buildConnectorWorkerEnv()` is the single chokepoint: both the standalone CLI
 * (`bin.ts`) and the in-process embedded worker
 * (`server/src/scheduled/embedded-connector-worker.ts`) build the connector-
 * facing `Env` through it, precisely so gateway secrets stay out of connector
 * runs. Everything it returns reaches connector code, because
 * `buildConnectorConfig()` merges `job.env` into the connector's own config
 * object — so exclusion here is what keeps it unreachable.
 *
 * The daemon still authenticates: both callers pass the token explicitly as
 * `DaemonConfig.workerApiToken`, which never enters `Env`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { WorkerClient } from '../daemon/client.js';
import { buildConnectorWorkerEnv } from '../env.js';

// Snapshot every process-env key these tests write. Restoring only
// WORKER_API_TOKEN would leak GITHUB_TOKEN into whatever runs next in this
// process, which is the same shared-mutable-state hazard the exclusion below
// exists to prevent.
const SNAPSHOT_KEYS = ['WORKER_API_TOKEN', 'GITHUB_TOKEN'] as const;
const original = new Map(SNAPSHOT_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

describe('connector-facing env', () => {
  test('omits WORKER_API_TOKEN even when the worker process holds one', () => {
    process.env.WORKER_API_TOKEN = 'sentinel-worker-token';

    const env = buildConnectorWorkerEnv() as Record<string, unknown>;

    expect(env.WORKER_API_TOKEN).toBeUndefined();
    // Guard the value too: a rename would keep the key assertion green while
    // still handing the secret to connector code under a different name.
    expect(Object.values(env)).not.toContain('sentinel-worker-token');
  });

  test('still carries the env connectors legitimately need', () => {
    // Pins the exclusion as targeted rather than a blanket empty env, which
    // would pass the assertion above while breaking every connector.
    process.env.GITHUB_TOKEN = 'gh-sentinel';
    const env = buildConnectorWorkerEnv() as Record<string, unknown>;

    expect(env.GITHUB_TOKEN).toBe('gh-sentinel');
    expect(env.LOBU_DB_EGRESS_POLICY).toBeDefined();
  });

  test('omits platform master secrets under LOBU_CLOUD_MODE', () => {
    process.env.LOBU_CLOUD_MODE = '1';
    process.env.GITHUB_TOKEN = 'gh-platform-secret';
    process.env.GOOGLE_MAPS_API_KEY = 'maps-secret';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-secret';

    const env = buildConnectorWorkerEnv() as Record<string, unknown>;

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GOOGLE_MAPS_API_KEY).toBeUndefined();
    expect(env.REDDIT_CLIENT_SECRET).toBeUndefined();
    expect(env.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });

  test('the daemon authenticates with the token that Env omits', async () => {
    // Excluding the token from Env is only correct because the daemon still
    // sends it on the wire. Asserting the exclusion alone would stay green if
    // the token stopped reaching `/api/workers/*` entirely, which would break
    // every device worker while looking like a passing security test.
    process.env.WORKER_API_TOKEN = 'owl_pat_sentinel';
    let seen: { url: string; auth: string | null; body: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = {
        url: String(input),
        auth: headers.get('Authorization'),
        body: String(init?.body ?? ''),
      };
      return new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'macos:test-device',
      authToken: process.env.WORKER_API_TOKEN,
      capabilities: { 'os.files': true },
      platform: 'macos',
    });
    await client.poll();

    expect(seen?.url).toBe('https://api.example.com/api/workers/poll');
    expect(seen?.auth).toBe('Bearer owl_pat_sentinel');
    // The device registration fields ride the same authenticated request.
    expect(JSON.parse(seen?.body ?? '{}')).toMatchObject({
      worker_id: 'macos:test-device',
      platform: 'macos',
    });

    // Same process, same token in env — still absent from the connector Env.
    const env = buildConnectorWorkerEnv() as Record<string, unknown>;
    expect(env.WORKER_API_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('owl_pat_sentinel');
  });
});
