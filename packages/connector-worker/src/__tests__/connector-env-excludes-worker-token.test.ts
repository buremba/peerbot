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
 * runs. Everything it returns reaches connector code two ways —
 * `subprocess.ts` spreads `job.env` into the child process environment, and
 * `buildConnectorConfig()` merges `job.env` into the connector's own config
 * object — so exclusion here is what keeps it unreachable.
 *
 * The daemon still authenticates: both callers pass the token explicitly as
 * `DaemonConfig.workerApiToken`, which never enters `Env`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { buildConnectorWorkerEnv } from '../env.js';

const original = process.env.WORKER_API_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.WORKER_API_TOKEN;
  else process.env.WORKER_API_TOKEN = original;
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
});
