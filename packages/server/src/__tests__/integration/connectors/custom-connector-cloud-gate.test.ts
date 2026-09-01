/**
 * Cloud admission for organization-supplied connector code, at both layers.
 *
 * The property under test is that queue admission (`createSyncRun`) and worker
 * dispatch (`pollWorkerJob`) reach the SAME verdict for the same artifact row.
 * They read the row through different queries, and three hand-written copies of
 * the provenance derivation previously disagreed — admitting at one layer what
 * the other rejected, and rejecting the ordinary bundled row at both. Both
 * layers now classify through `custom-connector-cloud-gate`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentToolingDeclaration } from '../../../gateway/agent-tooling/resolver';
import type { Env } from '../../../index';
import { createSyncRun } from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { post } from '../../setup/test-helpers';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../setup/test-fixtures';

/** `postgres` ships in the image, so the key itself is always attested. */
const CONNECTOR_KEY = 'postgres';
const CONNECTOR_VERSION = '1.0.0';

async function setupFeed(): Promise<{ feedId: number; connId: number; orgId: string }> {
  const sql = getTestDb();
  const org = await createTestOrganization();
  await createTestConnectorDefinition({
    key: CONNECTOR_KEY,
    name: 'PostgreSQL',
    version: CONNECTOR_VERSION,
    organization_id: org.id,
  });
  const conn = await createTestConnection({
    organization_id: org.id,
    connector_key: CONNECTOR_KEY,
  });
  const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${conn.id}`;
  return { feedId: Number((feed as { id: number }).id), connId: conn.id, orgId: org.id };
}

/**
 * Re-scope the fixture's shared artifact row to the org and give it source
 * bytes — the shape `install_connector` used to produce before the install
 * gate closed, and the one Cloud must never execute.
 */
async function makeArtifactOrgSupplied(orgId: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE connector_versions
    SET organization_id = ${orgId},
        source_code = ${'export default { sync: async () => ({ items: [] }) }'}
    WHERE connector_key = ${CONNECTOR_KEY} AND version = ${CONNECTOR_VERSION}
  `;
}

/** A pending run inserted directly, so worker dispatch is what's under test. */
async function insertPendingRun(
  orgId: string,
  feedId: number,
  connId: number
): Promise<number> {
  const sql = getTestDb();
  const [run] = await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id, connector_key, connector_version,
      status, approval_status, created_at
    ) VALUES (
      ${orgId}, 'sync', ${feedId}, ${connId}, ${CONNECTOR_KEY}, ${CONNECTOR_VERSION},
      'pending', 'auto', current_timestamp
    )
    RETURNING id
  `;
  return Number((run as { id: number }).id);
}

describe('organization-supplied connector code under LOBU_CLOUD_MODE', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    delete process.env.LOBU_CLOUD_MODE;
  });

  it('queue admission refuses to create a sync run for org-supplied code', async () => {
    const sql = getTestDb();
    const { feedId, orgId } = await setupFeed();
    await makeArtifactOrgSupplied(orgId);

    process.env.LOBU_CLOUD_MODE = '1';
    const created = await createSyncRun(feedId, {} as Env, sql);

    expect(created.ok).toBe(false);
    expect(created.ok ? null : created.reason).toBe('cloud_restricted');
    const runs = await sql`SELECT id FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(0);
  });

  it('the same org-supplied row is self-hostable — the gate is cloud mode, not the row', async () => {
    const sql = getTestDb();
    const { feedId, orgId } = await setupFeed();
    await makeArtifactOrgSupplied(orgId);

    delete process.env.LOBU_CLOUD_MODE;
    const created = await createSyncRun(feedId, {} as Env, sql);

    expect(created.ok).toBe(true);
    const runs = await sql`SELECT id FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(1);
  });

  it('worker dispatch fails an already-claimed run rather than shipping org code', async () => {
    const sql = getTestDb();
    const { feedId, connId, orgId } = await setupFeed();
    const runId = await insertPendingRun(orgId, feedId, connId);
    await makeArtifactOrgSupplied(orgId);

    process.env.LOBU_CLOUD_MODE = '1';
    const res = await post('/api/workers/poll', {
      body: { worker_id: 'cloud-artifact-worker', capabilities: { db_egress_hardening: true } },
      token: 'test-fleet-token',
      env: { WORKER_API_TOKEN: 'test-fleet-token' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
      error?: string;
    };
    expect(body.run_id).toBeUndefined();
    expect(Number(body.skipped_run_id)).toBe(runId);
    expect(body.error).toContain('CUSTOM_CONNECTOR_CLOUD_DISABLED');

    const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect((row as { status: string }).status).toBe('failed');
  });

  /**
   * The wire: what bytes actually leave the gateway, as opposed to whether the
   * run was admitted. A shared row can hold code the image did not produce,
   * and in Cloud the worker must never receive it.
   *
   * Scope note, so this is not read as more than it is. Two redundant
   * mechanisms keep the payload out — poll suppresses shipping stored bytes
   * when the image has the source, and resolveConnectorCode compiles the image
   * file regardless — and disabling either one alone still leaves this green.
   * There is no configuration that isolates one of them, because admission
   * denies first whenever the image lacks the key. So this guards the
   * observable outcome of the composed path, not either mechanism; the
   * discriminating test for the resolver is in connector-stale-artifact.
   * The self-host control below is what makes even that meaningful: it proves
   * the row's bytes really do ship when nothing suppresses them.
   */
  it('withholds non-image bytes from the worker in Cloud, ships them self-hosted', async () => {
    const sql = getTestDb();
    const planted = 'PLANTED_DB_BYTES_MUST_NEVER_REACH_A_WORKER';

    async function pollBodyFor(cloud: boolean, worker: string): Promise<string> {
      const { feedId, connId, orgId } = await setupFeed();
      await sql`
        UPDATE connector_versions
        SET compiled_code = ${`export default class P { m(){ return '${planted}'; } }`}
        WHERE connector_key = ${CONNECTOR_KEY} AND version = ${CONNECTOR_VERSION}
      `;
      await insertPendingRun(orgId, feedId, connId);
      if (cloud) process.env.LOBU_CLOUD_MODE = '1';
      else delete process.env.LOBU_CLOUD_MODE;
      const res = await post('/api/workers/poll', {
        body: { worker_id: worker, capabilities: { db_egress_hardening: true } },
        token: 'test-fleet-token',
        env: { WORKER_API_TOKEN: 'test-fleet-token' },
      });
      expect(res.status).toBe(200);
      return await res.text();
    }

    // CONTROL: self-host ships the stored bytes to the worker.
    expect(await pollBodyFor(false, 'selfhost-wire-worker')).toContain(planted);

    // Cloud withholds them; the worker resolves from its own image copy.
    expect(await pollBodyFor(true, 'cloud-wire-worker')).not.toContain(planted);
  });

  /**
   * The availability half. Both layers must still admit the row every Cloud
   * connector actually has — shared scope, pointing at the image source.
   */
  it('both layers admit the ordinary bundled row', async () => {
    const sql = getTestDb();
    const { feedId } = await setupFeed();
    await sql`
      UPDATE connector_versions
      SET compiled_code = NULL, compile_config_hash = NULL,
          source_path = ${'connectors/postgres.ts'}
      WHERE connector_key = ${CONNECTOR_KEY} AND version = ${CONNECTOR_VERSION}
    `;

    process.env.LOBU_CLOUD_MODE = '1';
    const created = await createSyncRun(feedId, {} as Env, sql);
    expect(created.ok).toBe(true);

    // Dispatch the run queue admission just created — one active sync per feed.
    const runId = created.ok ? created.runId : -1;
    const res = await post('/api/workers/poll', {
      body: { worker_id: 'cloud-bundled-worker', capabilities: { db_egress_hardening: true } },
      token: 'test-fleet-token',
      env: { WORKER_API_TOKEN: 'test-fleet-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number; error?: string };
    expect(body.error).toBeUndefined();
    expect(Number(body.run_id)).toBe(runId);

    const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect((row as { status: string }).status).toBe('running');
  });
});

/**
 * The third admission surface. Queue and dispatch decide whether a run starts;
 * this one decides what an agent's worker is BUILT with — the nix packages on
 * its PATH and the hosts on its deny-by-default egress allowlist.
 *
 * `connector_definitions.agent_tooling` is jsonb written by the install path,
 * so in Cloud it is an org-writable input to a worker's sandbox. The image file
 * is the only declaration Cloud honours, and an artifact the image cannot
 * attest contributes nothing at all rather than falling back to the stored row.
 *
 * The self-host control is what makes this discriminating: it proves the
 * planted declaration really does reach the worker when nothing substitutes it.
 */
describe('Cloud agent tooling comes from the image, not the stored declaration', () => {
  // `github` is the bundled connector that declares agentTooling, so the image
  // has something concrete to substitute in.
  const TOOLING_KEY = 'github';
  const TOOLING_VERSION = '1.3.0';
  const IMAGE_PACKAGE = 'gh';
  const IMAGE_DOMAIN = 'api.github.com';
  // A binary and an egress host no bundled connector declares.
  const PLANTED_PACKAGE = 'curl';
  const PLANTED_DOMAIN = 'planted.example.com';

  async function setupToolingConnection(): Promise<string> {
    const sql = getTestDb();
    const org = await createTestOrganization();
    await createTestConnectorDefinition({
      key: TOOLING_KEY,
      name: 'GitHub',
      version: TOOLING_VERSION,
      organization_id: org.id,
    });
    await sql`
      UPDATE connector_definitions
      SET agent_tooling = ${sql.json({
        nix: { packages: [PLANTED_PACKAGE] },
        domains: [PLANTED_DOMAIN],
      })}
      WHERE key = ${TOOLING_KEY} AND organization_id = ${org.id}
    `;
    await createTestConnection({
      organization_id: org.id,
      connector_key: TOOLING_KEY,
    });
    return org.id;
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    delete process.env.LOBU_CLOUD_MODE;
  });

  it('CONTROL — self-host builds the worker from the stored declaration', async () => {
    const orgId = await setupToolingConnection();

    delete process.env.LOBU_CLOUD_MODE;
    const declared = await resolveAgentToolingDeclaration({ organizationId: orgId });

    expect(declared.packages).toContain(PLANTED_PACKAGE);
    expect(declared.domains).toContain(PLANTED_DOMAIN);
  });

  it('Cloud substitutes the image declaration and drops the stored one', async () => {
    const orgId = await setupToolingConnection();

    process.env.LOBU_CLOUD_MODE = '1';
    const declared = await resolveAgentToolingDeclaration({ organizationId: orgId });

    expect(declared.packages).not.toContain(PLANTED_PACKAGE);
    expect(declared.domains).not.toContain(PLANTED_DOMAIN);
    // Positively the image's own declaration, not merely an empty result.
    expect(declared.packages).toContain(IMAGE_PACKAGE);
    expect(declared.domains).toContain(IMAGE_DOMAIN);
  });

  it('Cloud contributes nothing for an org-scoped artifact', async () => {
    const sql = getTestDb();
    const orgId = await setupToolingConnection();
    await sql`
      UPDATE connector_versions
      SET organization_id = ${orgId},
          source_code = ${'export default { sync: async () => ({ items: [] }) }'}
      WHERE connector_key = ${TOOLING_KEY} AND version = ${TOOLING_VERSION}
    `;

    process.env.LOBU_CLOUD_MODE = '1';
    const declared = await resolveAgentToolingDeclaration({ organizationId: orgId });

    // Not the planted declaration, and not the image's either — an artifact
    // Cloud cannot attest gets no tooling at all.
    expect(declared.packages).toEqual([]);
    expect(declared.domains).toEqual([]);
  });
});
