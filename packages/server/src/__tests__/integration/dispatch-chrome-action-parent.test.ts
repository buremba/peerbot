import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import {
  dispatchChromeAction,
  TARGET_BROWSER_CONNECTION_INPUT_KEY,
} from '../../worker-api/dispatch-chrome-action';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();
const app = new Hono<{ Bindings: Env }>();
app.post('/dispatch', dispatchChromeAction);

describe('dispatchChromeAction parent run authorization', () => {
  beforeEach(cleanupTestDatabase);
  afterAll(cleanupTestDatabase);

  it('accepts a claimed connector action parent', async () => {
    const org = await createTestOrganization({ name: 'Chrome action parent' });
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, status, claimed_by, claimed_at
      ) VALUES (
        ${org.id}, 'action', 'prepare_comment', 'running', 'connector-worker-1', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const response = await app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: Number(run.id),
        worker_id: 'connector-worker-1',
        action_key: 'navigate',
        action_input: { url: 'https://www.linkedin.com/' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('No online paired Owletto'),
    });
  });
});

/**
 * `target_browser_connection_id` lets an interactive action (x.prepare_reply)
 * name the browser its draft must appear in, overriding the parent connection's
 * scrape pin. It is a routing directive with real blast radius: pointed at the
 * wrong connection it stages a draft in someone else's signed-in browser, so it
 * must resolve strictly inside the caller's org and fail rather than fall back.
 */
describe('dispatchChromeAction target browser routing', () => {
  beforeEach(cleanupTestDatabase);
  afterAll(cleanupTestDatabase);

  // The connector declares its own copy of this key (packages/connectors/src/x.ts,
  // pinned in x.test.ts) because a compiled connector cannot import from the
  // server. Pinning the literal on both sides turns drift into a failing test
  // rather than a draft silently routed by the scrape pin again.
  it('uses the wire key the connector stamps', () => {
    expect(TARGET_BROWSER_CONNECTION_INPUT_KEY).toBe(
      'target_browser_connection_id'
    );
  });

  async function seedParentRun(orgId: string): Promise<number> {
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, status, claimed_by, claimed_at
      ) VALUES (
        ${orgId}, 'action', 'prepare_reply', 'running', 'connector-worker-1', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    return Number(run.id);
  }

  async function dispatchWithTarget(
    runId: number,
    target: unknown
  ): Promise<{ status: string; error_message?: string }> {
    const response = await app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: runId,
        worker_id: 'connector-worker-1',
        action_key: 'navigate',
        action_input: {
          url: 'https://x.com/i/web/status/2083959735481716957',
          [TARGET_BROWSER_CONNECTION_INPUT_KEY]: target,
        },
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { status: string; error_message?: string };
  }

  it('rejects a target that is not a connection id instead of picking a browser', async () => {
    const org = await createTestOrganization({ name: 'Target browser garbage' });
    const runId = await seedParentRun(org.id);

    for (const bad of ['macbook', 0, -3, 1.5]) {
      const body = await dispatchWithTarget(runId, bad);
      expect(body.status).toBe('failed');
      expect(body.error_message).toContain(
        'must be a positive integer chrome connection id'
      );
    }
  });

  it('refuses a chrome connection owned by another organization', async () => {
    const other = await createTestOrganization({ name: 'Other org' });
    const user = await createTestUser({ email: 'other-org-chrome@test.com' });
    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${user.id}, 'ext-other-org', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Other Ext',
        ${other.id}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${other.id}, 'chrome', 'chrome-other', 'Chrome', 'active',
        ${user.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const caller = await createTestOrganization({ name: 'Calling org' });
    const runId = await seedParentRun(caller.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    // Not "offline", and above all not a silent fall back to some other
    // browser — the connection is simply not visible from this org.
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });

  it('refuses a same-org connection pinned to another org’s browser', async () => {
    // The connection passes the org check; its pin does not. Without the
    // organization_id equality on the join this resolves to a device worker in
    // a different tenant and stages the draft in that browser.
    const org = await createTestOrganization({ name: 'Caller with foreign pin' });
    const foreign = await createTestOrganization({ name: 'Foreign browser org' });
    const user = await createTestUser({ email: 'foreign-pin@test.com' });
    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${user.id}, 'ext-foreign-pin', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Foreign Ext',
        ${foreign.id}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-foreign-pin', 'Chrome', 'active',
        ${user.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });

  it('refuses a connection id that is not a chrome connection', async () => {
    const org = await createTestOrganization({ name: 'Non-chrome target' });
    const user = await createTestUser({ email: 'non-chrome@test.com' });
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'x', 'x-main', 'X', 'active',
        ${user.id}, 'private', NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });
});
