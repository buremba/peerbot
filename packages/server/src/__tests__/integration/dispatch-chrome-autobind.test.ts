/**
 * resolveOnlineChromeConnection — integration test against real Postgres.
 *
 * The generic `chrome` action connection (used by server-side connectors like
 * Revolut/LinkedIn to dispatch a browser scrape) must reach an extension that is
 * ONLINE in the org, regardless of which worker — if any — it's currently pinned
 * to. Re-pairing mints a new device worker and leaves the chrome connection
 * pinned to the old (offline) one or NULL, which used to make dispatch fail with
 * "no online paired extension". The resolver self-heals the pin to the online
 * worker.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  preferredBrowserWorkerForConnection,
  resolveOnlineChromeConnection,
} from '../../worker-api/dispatch-chrome-action';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();
const DEBUGGER_CAPS = ['browser.tabs', 'browser.scripting', 'browser.debugger'];

async function seedChromeConn(
  orgId: string,
  userId: string,
  deviceWorkerId: string | null
): Promise<number> {
  const slug = `chrome-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, device_worker_id, created_at, updated_at
    ) VALUES (
      ${orgId}, 'chrome', ${slug}, 'Chrome', 'active',
      ${userId}, 'private', ${deviceWorkerId}::uuid, NOW(), NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedExtWorker(
  userId: string,
  orgId: string,
  opts: { online: boolean; capabilities?: string[] }
): Promise<string> {
  const workerId = `ext-${Math.random().toString(36).slice(2, 10)}`;
  const lastSeen = opts.online
    ? new Date()
    : new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago → offline
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
    ) VALUES (
      ${userId}, ${workerId}, 'chrome-extension',
      ${sql.json(opts.capabilities ?? DEBUGGER_CAPS)}, 'Test Ext', ${orgId}, ${lastSeen}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function pinOf(connectionId: number): Promise<string | null> {
  const [row] = (await sql`
    SELECT device_worker_id FROM connections WHERE id = ${connectionId}
  `) as unknown as Array<{ device_worker_id: string | null }>;
  return row.device_worker_id;
}

describe('resolveOnlineChromeConnection — self-healing chrome pin', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Chrome Autobind Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'chrome-autobind@test.com' });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('binds an unpinned (NULL) chrome connection to the online extension worker', async () => {
    const connId = await seedChromeConn(orgId, userId, null);
    const workerId = await seedExtWorker(userId, orgId, { online: true });

    const res = await resolveOnlineChromeConnection(orgId, sql);

    expect(res).not.toBeNull();
    expect(res?.connectionId).toBe(connId);
    expect(res?.deviceWorkerId).toBe(workerId);
    // The connection is now pinned to the online worker (so the poll can claim).
    expect(await pinOf(connId)).toBe(workerId);
  });

  it('repins a connection stuck on an offline worker (the re-pair case)', async () => {
    const stale = await seedExtWorker(userId, orgId, { online: false });
    const connId = await seedChromeConn(orgId, userId, stale);
    const fresh = await seedExtWorker(userId, orgId, { online: true });

    const res = await resolveOnlineChromeConnection(orgId, sql);

    expect(res?.deviceWorkerId).toBe(fresh);
    expect(await pinOf(connId)).toBe(fresh); // repinned away from the stale worker
  });

  it('returns null and leaves the pin untouched when no extension is online', async () => {
    const connId = await seedChromeConn(orgId, userId, null);
    await seedExtWorker(userId, orgId, { online: false }); // only an offline worker

    const res = await resolveOnlineChromeConnection(orgId, sql);

    expect(res).toBeNull();
    expect(await pinOf(connId)).toBeNull();
  });

  it('ignores an online extension that lacks the browser.debugger capability', async () => {
    const connId = await seedChromeConn(orgId, userId, null);
    await seedExtWorker(userId, orgId, {
      online: true,
      capabilities: ['browser.tabs', 'browser.scripting'], // no debugger
    });

    const res = await resolveOnlineChromeConnection(orgId, sql);

    expect(res).toBeNull();
    expect(await pinOf(connId)).toBeNull();
  });

  it('keeps a still-online deliberate pin (does not jump to a fresher extension)', async () => {
    // Older but still online pin (Mac mini) vs a more recently seen MacBook
    // extension — multi-Chrome orgs must not steal scrapes to last_seen DESC.
    const pinned = await seedExtWorker(userId, orgId, { online: true });
    // Age the pinned worker's last_seen slightly so the fresher one would win
    // under the old ORDER BY last_seen_at DESC rule.
    await sql`
      UPDATE device_workers
      SET last_seen_at = now() - interval '2 minutes'
      WHERE id = ${pinned}::uuid
    `;
    const fresher = await seedExtWorker(userId, orgId, { online: true });
    const connId = await seedChromeConn(orgId, userId, pinned);

    const res = await resolveOnlineChromeConnection(orgId, sql);

    expect(res?.deviceWorkerId).toBe(pinned);
    expect(res?.deviceWorkerId).not.toBe(fresher);
    expect(await pinOf(connId)).toBe(pinned);
  });

  it('honors preferredDeviceWorkerId over last_seen when that extension is online', async () => {
    // Data connection (LinkedIn) pin → chrome-extension means browser affinity.
    const preferred = await seedExtWorker(userId, orgId, { online: true });
    await sql`
      UPDATE device_workers
      SET last_seen_at = now() - interval '3 minutes'
      WHERE id = ${preferred}::uuid
    `;
    const fresher = await seedExtWorker(userId, orgId, { online: true });
    // Org chrome connection may be stuck on the fresher (or null).
    const chromeConnId = await seedChromeConn(orgId, userId, fresher);

    const res = await resolveOnlineChromeConnection(orgId, sql, {
      preferredDeviceWorkerId: preferred,
    });

    expect(res?.deviceWorkerId).toBe(preferred);
    expect(res?.deviceWorkerId).not.toBe(fresher);
    // Chrome connection is re-pinned so the action run can be claimed.
    expect(await pinOf(chromeConnId)).toBe(preferred);
  });

  it('returns null when preferred extension is offline (fail-closed, no last_seen steal)', async () => {
    const preferredOffline = await seedExtWorker(userId, orgId, { online: false });
    await seedExtWorker(userId, orgId, { online: true }); // would otherwise win
    await seedChromeConn(orgId, userId, null);

    const res = await resolveOnlineChromeConnection(orgId, sql, {
      preferredDeviceWorkerId: preferredOffline,
      failIfPreferredOffline: true,
    });

    expect(res).toBeNull();
  });

  it('preferredBrowserWorkerForConnection only returns chrome-extension pins', async () => {
    const ext = await seedExtWorker(userId, orgId, { online: true });
    const slug = `li-${Math.random().toString(36).slice(2, 8)}`;
    const [li] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${orgId}, 'linkedin', ${slug}, 'LinkedIn', 'active',
        ${userId}, 'private', ${ext}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    expect(await preferredBrowserWorkerForConnection(li.id, sql)).toBe(ext);
    expect(await preferredBrowserWorkerForConnection(null, sql)).toBeNull();
  });
});
