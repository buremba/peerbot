import { describe, expect, test } from 'bun:test';
import type { Env } from '@lobu/connector-sdk';
import type { PollResponse } from '../daemon/client.js';
import { resolveEffectiveEnv } from '../daemon/executor.js';

/**
 * The gateway authoritatively decides the DB egress boundary from ITS cloud
 * mode and ships it on the poll response's `db_egress_policy`. The out-of-process
 * connector-worker must fold that decision into `job.env.LOBU_DB_EGRESS_POLICY`
 * taking the STRICTER of gateway-vs-worker, so:
 *   - a fleet worker missing LOBU_CLOUD_MODE (env-derived allow-private) STILL
 *     enforces block-private when the gateway said so — the SSRF guard cannot be
 *     silently OFF (this is the gap the PR closes);
 *   - a stale/misconfigured gateway can never DOWNGRADE a worker that already
 *     decided block-private.
 */
describe('resolveEffectiveEnv — gateway egress policy is non-downgradable', () => {
  const jobWith = (policy?: PollResponse['db_egress_policy']): PollResponse => ({
    run_id: 1,
    run_type: 'sync',
    connector_key: 'postgres',
    db_egress_policy: policy,
  });

  test('gateway block-private wins even when the worker env is allow-private (missing LOBU_CLOUD_MODE)', () => {
    // Reproduces the SSRF gap: worker process has no LOBU_CLOUD_MODE, so its
    // own env-derived policy is allow-private. Without the gateway fold this
    // would leave the private-IP guard OFF for a cloud tenant's postgres URL.
    const workerEnv: Env = { LOBU_DB_EGRESS_POLICY: 'allow-private' };
    const effective = resolveEffectiveEnv(workerEnv, jobWith('block-private'));
    expect(effective.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });

  test('gateway allow-private cannot downgrade a worker that decided block-private', () => {
    const workerEnv: Env = { LOBU_DB_EGRESS_POLICY: 'block-private' };
    const effective = resolveEffectiveEnv(workerEnv, jobWith('allow-private'));
    expect(effective.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });

  test('both allow-private stays allow-private (self-hosted, non-cloud gateway)', () => {
    const workerEnv: Env = { LOBU_DB_EGRESS_POLICY: 'allow-private' };
    const effective = resolveEffectiveEnv(workerEnv, jobWith('allow-private'));
    expect(effective.LOBU_DB_EGRESS_POLICY).toBe('allow-private');
  });

  test('legacy gateway response (no db_egress_policy) falls back to the worker env-derived default', () => {
    const workerEnv: Env = { LOBU_DB_EGRESS_POLICY: 'block-private' };
    const effective = resolveEffectiveEnv(workerEnv, jobWith(undefined));
    expect(effective.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });

  test('gateway block-private applies even when the worker env omits the policy entirely', () => {
    const workerEnv: Env = {};
    const effective = resolveEffectiveEnv(workerEnv, jobWith('block-private'));
    expect(effective.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });

  test('preserves other env keys untouched', () => {
    const workerEnv: Env = { WORKER_API_TOKEN: 't', LOBU_DB_EGRESS_POLICY: 'allow-private' };
    const effective = resolveEffectiveEnv(workerEnv, jobWith('block-private'));
    expect(effective.WORKER_API_TOKEN).toBe('t');
  });
});
