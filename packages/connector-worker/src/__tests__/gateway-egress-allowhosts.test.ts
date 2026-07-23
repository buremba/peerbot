import { describe, expect, test } from 'bun:test';
import type { Env } from '@lobu/connector-sdk';
import type { PollResponse } from '../daemon/client.js';
import { resolveEffectiveEnv } from '../daemon/executor.js';

/**
 * The operator's DB egress allow-host list rides the SAME gateway-authoritative
 * channel as `db_egress_policy`. It must REPLACE any worker-local list, never
 * union with it — unioning would let a compromised or misconfigured fleet worker
 * widen its own egress boundary, which is exactly the downgrade the policy
 * ratchet exists to prevent.
 */
describe('resolveEffectiveEnv — allow-host list is gateway-authoritative', () => {
  const job = (allow?: string): PollResponse =>
    ({
      run_id: 1,
      run_type: 'sync',
      connector_key: 'postgres',
      db_egress_policy: 'block-private',
      db_egress_allow_hosts: allow,
    }) as PollResponse;

  test("the gateway's list is installed into the child env", () => {
    const out = resolveEffectiveEnv({} as Env, job('100.127.177.56'));
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('100.127.177.56');
  });

  test('a worker-local list is DISCARDED when the gateway ships none', () => {
    const workerEnv = { LOBU_DB_EGRESS_ALLOW_HOSTS: '10.0.0.5' } as unknown as Env;
    const out = resolveEffectiveEnv(workerEnv, job(undefined));
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('');
  });

  test('a worker cannot ADD entries to the gateway list', () => {
    const workerEnv = { LOBU_DB_EGRESS_ALLOW_HOSTS: '169.254.169.254,10.0.0.5' } as unknown as Env;
    const out = resolveEffectiveEnv(workerEnv, job('100.127.177.56'));
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('100.127.177.56');
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).not.toContain('10.0.0.5');
  });

  test('the policy ratchet still applies alongside the list', () => {
    const out = resolveEffectiveEnv({} as Env, job('100.127.177.56'));
    expect(out.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });
});

/**
 * End-to-end of the CLOUD path: the worker's own env whitelist
 * (`buildConnectorWorkerEnv`) deliberately does NOT carry an allow-host list —
 * the gateway is the only source. These assert the full fold: poll response →
 * effective env → authoritative child config, with tenant config unable to win.
 */
describe('cloud path — gateway list reaches the connector config', () => {
  test('worker env whitelist carries no allow-host list of its own', async () => {
    const { buildConnectorWorkerEnv } = await import('../env.js');
    const env = buildConnectorWorkerEnv() as Record<string, unknown>;
    expect(env.LOBU_DB_EGRESS_ALLOW_HOSTS).toBeUndefined();
  });

  test('tenant config cannot override the gateway allow-host list', async () => {
    const { buildConnectorConfig } = await import('../executor/child-runner.js');
    const gatewayJob = {
      run_id: 1,
      run_type: 'sync',
      connector_key: 'postgres',
      db_egress_policy: 'block-private',
      db_egress_allow_hosts: '100.127.177.56',
    } as PollResponse;
    const effective = resolveEffectiveEnv({} as Env, gatewayJob);
    const config = buildConnectorConfig({
      config: {
        // A malicious tenant trying to widen its own boundary.
        LOBU_DB_EGRESS_ALLOW_HOSTS: '169.254.169.254',
        LOBU_DB_EGRESS_POLICY: 'allow-private',
      },
      env: effective as unknown as Record<string, string | undefined>,
    });
    expect(config.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('100.127.177.56');
    expect(config.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });
});
