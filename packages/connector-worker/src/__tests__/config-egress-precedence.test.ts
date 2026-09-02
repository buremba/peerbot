import { describe, expect, test } from 'bun:test';
import { buildConnectorConfig } from '../executor/connector-config.js';

/**
 * The trusted gateway sets LOBU_DB_EGRESS_POLICY on job.env. A tenant controls
 * job.config (connection/feed config). Config-wins is the norm for ordinary
 * keys, but the egress policy is a security control the tenant must NOT be able
 * to downgrade (block-private → allow-private would disable private-IP blocking,
 * IP pinning, and forced TLS). This is the out-of-process worker path that the
 * in-process feed-sync / pushdown paths already close by injecting last.
 */
describe('buildConnectorConfig — gateway egress policy is authoritative', () => {
  test('tenant config CANNOT override block-private from job.env', () => {
    const merged = buildConnectorConfig({
      env: { LOBU_DB_EGRESS_POLICY: 'block-private', WORKER_API_TOKEN: 't' },
      config: { LOBU_DB_EGRESS_POLICY: 'allow-private', DATABASE_URL: 'postgres://x' },
    });
    expect(merged.LOBU_DB_EGRESS_POLICY).toBe('block-private');
    // Non-authoritative tenant keys still flow through.
    expect(merged.DATABASE_URL).toBe('postgres://x');
  });

  test('ordinary keys keep config-wins precedence', () => {
    const merged = buildConnectorConfig({
      env: { SOME_KEY: 'from-env' },
      config: { SOME_KEY: 'from-config' },
    });
    expect(merged.SOME_KEY).toBe('from-config');
  });

  test('self-hosted allow-private from env also wins over tenant config', () => {
    const merged = buildConnectorConfig({
      env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
      config: { LOBU_DB_EGRESS_POLICY: 'block-private' },
    });
    // The env value is authoritative in either direction — the gateway decides
    // the policy from cloud mode; tenant config never gets a vote.
    expect(merged.LOBU_DB_EGRESS_POLICY).toBe('allow-private');
  });

  test('when env does not set the policy, tenant config value is left intact', () => {
    // In-process paths inject the policy into config (not env); this path must
    // not clobber a legitimately config-carried policy with an env absence.
    const merged = buildConnectorConfig({
      env: {},
      config: { LOBU_DB_EGRESS_POLICY: 'block-private' },
    });
    expect(merged.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });
});
