/**
 * Device-backed virtual-feed live read — end to end.
 *
 * `whatsapp.local` is a metadata-only device manifest: there is no compiled
 * connector on the server, so the `query()`/`search()` pushdown that serves
 * every other virtual feed cannot serve this one. The read is dispatched to the
 * paired Mac over the existing device action queue and awaited there.
 *
 * What each case pins:
 *
 *   (a) ROUTING — a `runtime`-bearing connector takes the device path, and the
 *       reserved `__lobu_virtual_feed_read` run is claimed by the pinned device
 *       through the ordinary `/api/workers/poll`, carrying the caller's terms
 *       and window. Rows come back through `/api/workers/complete-action`.
 *   (b) NO RETENTION — a live read writes no events and no checkpoint, and the
 *       run row that carried the rows is scrubbed of BOTH the device's output
 *       and the caller's recall terms. The rows transit Postgres (that is the
 *       cross-replica transport); they must not stay there.
 *   (c) The scrub survives every exit: device failure, a malformed device
 *       reply, and an exception thrown by the waiter itself.
 *   (d) OFFLINE — a read against a device that has stopped polling fails fast
 *       with a diagnosis, without parking a run for the 60s queue budget.
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthzScope } from '../../../authz/scope';

// The waiter is swapped through a server-internal slot so two cases can make it
// throw. NOT `vi.mock`: vitest runs this package with `isolate: false` (one
// shared module graph for the whole Postgres-backed run), and under that
// setting a module mock only lands if this file is the first to import
// `connector-pushdown` — these cases passed alone and timed out in a full run.
const { readVirtualFeed } = await import('../../../lib/connector-pushdown');
const { readDeviceVirtualFeed, __setDeviceActionWaiterForTest } = await import(
  '../../../lib/device-virtual-feed'
);
const { DEVICE_VIRTUAL_FEED_ACTION_KEY } = await import(
  '../../../lib/device-virtual-feed-protocol'
);
const { pollWorkerJob } = await import('../../../worker-api/poll');
const { cleanupTestDatabase, getTestDb } = await import('../../setup/test-db');
const { addUserToOrganization, createTestOrganization, createTestUser } = await import(
  '../../setup/test-fixtures'
);
const { post } = await import('../../setup/test-helpers');

const CONNECTOR_KEY = 'whatsapp.local';
const CONNECTOR_VERSION = '0.3.0';
const FEED_KEY = 'messages_live';
const WORKER_ID = 'wk-wa-virtual';

const DEVICE_ROWS = [
  {
    id: 'wa-1',
    occurred_at: '2026-08-18T09:00:00.000Z',
    text: 'invoice 4471 is overdue',
    chat_jid: '15551230000@s.whatsapp.net',
    chat_name: 'Dana Ruiz',
    is_group: false,
    from_me: false,
    sender_phone: '15551230000',
  },
];
const DEVICE_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'occurred_at', type: 'timestamptz' },
  { name: 'text', type: 'text' },
];

let orgId: string;
let userId: string;
let deviceWorkerId: string;
let connectionId: number;
let feedId: number;

const scope = (): AuthzScope => ({ organizationId: orgId, principal: userId });

async function setDeviceLastSeen(interval: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE device_workers SET last_seen_at = now() - ${interval}::interval
    WHERE id = ${deviceWorkerId}::uuid
  `;
}

async function setDeviceCapabilities(capabilities: string[]): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE device_workers SET capabilities = ${sql.json(capabilities)}
    WHERE id = ${deviceWorkerId}::uuid
  `;
}

/** Rows the org has ever persisted from this connection, by any path. */
async function countPersistence(): Promise<{ events: number; checkpointed: number }> {
  const sql = getTestDb();
  const [events] = (await sql`
    SELECT count(*)::int AS n FROM events WHERE organization_id = ${orgId}
  `) as Array<{ n: number }>;
  const [checkpointed] = (await sql`
    SELECT count(*)::int AS n FROM feeds
    WHERE id = ${feedId} AND (checkpoint IS NOT NULL OR next_run_at IS NOT NULL)
  `) as Array<{ n: number }>;
  return { events: events.n, checkpointed: checkpointed.n };
}

async function readRunRows(): Promise<
  Array<{ id: number; status: string; action_key: string; action_input: unknown; action_output: unknown }>
> {
  const sql = getTestDb();
  return (await sql`
    SELECT id, status, action_key, action_input, action_output
    FROM runs
    WHERE organization_id = ${orgId} AND run_type = 'action'
    ORDER BY id
  `) as Array<{
    id: number;
    status: string;
    action_key: string;
    action_input: unknown;
    action_output: unknown;
  }>;
}

/**
 * Stand in for the Mac app: poll until the reserved live-read run is handed
 * over, then answer it. Uses the real worker endpoints, so this also proves
 * poll.ts routes a `run_type='action'` row on a device-pinned connection to the
 * device that owns the pin.
 */
async function respondAsDevice(
  reply: { status: 'success'; action_output: Record<string, unknown> } | { status: 'failed'; error_message: string }
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await post('/api/workers/poll', {
      body: {
        worker_id: WORKER_ID,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Test Mac',
        capabilities: { whatsapp_local: true },
      },
    });
    expect(response.status).toBe(200);
    const job = await response.json();
    if (job?.run_id && job?.operation_key === DEVICE_VIRTUAL_FEED_ACTION_KEY) {
      const completion = await post('/api/workers/complete-action', {
        body: { run_id: job.run_id, worker_id: WORKER_ID, ...reply },
      });
      expect(completion.status).toBe(200);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('device never received the virtual-feed read job');
}

describe('device-backed virtual feed read', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'WA Live' });
    orgId = org.id;
    const user = await createTestUser({ email: 'wa-live@test.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    const sql = getTestDb();
    // Anonymous local device polls adopt the personal-org owner; mark this org
    // as that user's personal org so the poll resolves to them.
    await sql`
      UPDATE "organization"
      SET metadata = ${sql.json({ personal_org_for_user_id: userId })}
      WHERE id = ${orgId}
    `;
    const device = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${userId}, ${WORKER_ID}, 'macos', '9.9.0',
              ${sql.json(['whatsapp_local'])}, 'Test Mac', ${orgId})
      RETURNING id
    `) as Array<{ id: string }>;
    deviceWorkerId = device[0].id;

    // A device-manifest connector: `runtime` set, NO compiled code. That is the
    // whole reason the compiled pushdown cannot serve it.
    await sql`
      INSERT INTO connector_definitions
        (key, name, version, organization_id, status, runtime, required_capability,
         feeds_schema, auth_schema, created_at, updated_at)
      VALUES (${CONNECTOR_KEY}, 'WhatsApp (this Mac)', ${CONNECTOR_VERSION}, ${orgId}, 'active',
              ${sql.json({ platforms: ['macos'] })}, 'whatsapp_local',
              ${sql.json({ [FEED_KEY]: { key: FEED_KEY, virtual: true } })},
              ${sql.json({ methods: [{ type: 'none' }] })}, NOW(), NOW())
    `;
    await sql`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, created_at)
      VALUES (${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, NULL,
              ${`device-manifest://macos/${CONNECTOR_KEY}@${CONNECTOR_VERSION}`}, NOW())
    `;
    const connection = (await sql`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, visibility,
         device_worker_id, created_by, created_at, updated_at)
      VALUES (${orgId}, ${CONNECTOR_KEY}, 'whatsapp-local', 'WhatsApp (this Mac)', 'active', 'private',
              ${deviceWorkerId}::uuid, ${userId}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    connectionId = connection[0].id;
    const feed = (await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, display_name, status, config,
         kind, virtual, next_run_at)
      VALUES (${orgId}, ${connectionId}, ${FEED_KEY}, 'Messages (live)', 'active',
              ${sql.json({ recall: true, chat_filter: 'all' })}, 'virtual', true, NULL)
      RETURNING id
    `) as Array<{ id: number }>;
    feedId = feed[0].id;
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    __setDeviceActionWaiterForTest(null);
    await setDeviceLastSeen('5 seconds');
    await setDeviceCapabilities(['whatsapp_local']);
    await getTestDb()`DELETE FROM runs WHERE organization_id = ${orgId}`;
  });

  it('dispatches to the paired device, returns live rows, and retains nothing', async () => {
    const reading = readVirtualFeed({
      scope: scope(),
      feedId,
      terms: ['invoice'],
      limit: 25,
      offset: 5,
    });
    const job = await respondAsDevice({
      status: 'success',
      action_output: { rows: DEVICE_ROWS, columns: DEVICE_COLUMNS },
    });

    // (a) The device was handed the caller's intent, not a bare "read the feed".
    expect(job.connector_key).toBe(CONNECTOR_KEY);
    expect(job.action_input).toMatchObject({
      feed_key: FEED_KEY,
      terms: ['invoice'],
      limit: 25,
      offset: 5,
    });
    // Feed config rides along so the device can apply the declared filters.
    expect((job.action_input as { config: Record<string, unknown> }).config).toMatchObject({
      chat_filter: 'all',
    });

    const live = await reading;
    expect(live.rows).toEqual(DEVICE_ROWS);
    expect(live.columns).toEqual(DEVICE_COLUMNS);

    // (b) Nothing persisted: no events, no checkpoint, no due time — and the
    // transport row no longer holds the messages or the search terms.
    expect(await countPersistence()).toEqual({ events: 0, checkpointed: 0 });
    const runs = await readRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].action_key).toBe(DEVICE_VIRTUAL_FEED_ACTION_KEY);
    expect(runs[0].action_output).toBeNull();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('invoice 4471');
    expect(JSON.stringify(runs[0])).not.toContain('Dana Ruiz');
  }, 30_000);

  it('surfaces a device-side failure and still scrubs the run', async () => {
    const reading = readVirtualFeed({ scope: scope(), feedId, terms: ['payslip'] });
    await respondAsDevice({ status: 'failed', error_message: 'Full Disk Access denied' });

    await expect(reading).rejects.toThrow(/failed on the paired device: Full Disk Access denied/);
    const runs = await readRunRows();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('payslip');
  }, 30_000);

  it('rejects a malformed device reply rather than reporting an empty result', async () => {
    const reading = readVirtualFeed({ scope: scope(), feedId });
    await respondAsDevice({ status: 'success', action_output: { unexpected: true } });

    await expect(reading).rejects.toThrow(/malformed/);
    const runs = await readRunRows();
    expect(runs[0].action_output).toBeNull();
  }, 30_000);

  // The scrub lives in a `finally` that wraps the WAIT, not just its result:
  // a DB error inside the poll loop throws, and without this the run row would
  // keep the caller's terms (and any rows a device had already posted).
  it('scrubs the run even when the waiter itself throws', async () => {
    __setDeviceActionWaiterForTest(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(
      readVirtualFeed({ scope: scope(), feedId, terms: ['mortgage'] })
    ).rejects.toThrow(/connection terminated unexpectedly/);

    const runs = await readRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('mortgage');
  });

  // Blanking the payload is not enough on the throw path: the run is still
  // `pending`, its claim horizon has not expired, and a device that polls a
  // moment later would claim it and POST a fresh page of messages straight back
  // into the row we just cleared. Closing the run in the same statement is what
  // makes the scrub final.
  it('closes an abandoned run so a late device answer cannot repopulate it', async () => {
    __setDeviceActionWaiterForTest(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(
      readVirtualFeed({ scope: scope(), feedId, terms: ['tenancy deposit'] })
    ).rejects.toThrow(/connection terminated unexpectedly/);

    const [abandoned] = await readRunRows();
    expect(abandoned.status).toBe('timeout');

    // The device comes back and tries to answer the run it was about to claim.
    const claim = await post('/api/workers/poll', {
      body: {
        worker_id: WORKER_ID,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Test Mac',
        capabilities: { whatsapp_local: true },
      },
    });
    expect(claim.status).toBe(200);
    // A terminal run is not claimable, so the poll hands back no job at all.
    expect((await claim.json())?.run_id).toBeUndefined();

    // And a completion posted anyway is refused rather than re-filling the row.
    const late = await post('/api/workers/complete-action', {
      body: {
        run_id: abandoned.id,
        worker_id: WORKER_ID,
        status: 'success',
        action_output: { rows: DEVICE_ROWS, columns: DEVICE_COLUMNS },
      },
    });
    expect(await late.json()).toMatchObject({ success: false, reason: 'already_finalized' });

    const [after] = await readRunRows();
    expect(after.status).toBe('timeout');
    expect(after.action_output).toBeNull();
    expect(after.action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(after)).not.toContain('tenancy deposit');
    expect(JSON.stringify(after)).not.toContain('Dana Ruiz');
  });

  // The pin is read off a row this caller does not necessarily own end to end,
  // and the offline diagnosis quotes the device's label and last-poll time. It
  // must be reached THROUGH the org's own connection, or a corrupt pin reports
  // another tenant's machine back in an error string.
  it('never describes a device the org\'s connection does not actually pin', async () => {
    const sql = getTestDb();
    const foreign = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${userId}, ${'wk-other-tenant'}, 'macos', '9.9.0',
              ${sql.json(['whatsapp_local'])}, 'Acme Corp Mac', ${'org-someone-else'}, now())
      RETURNING id
    `) as Array<{ id: string }>;

    // A pin naming a device this org's connection does not hold: the preflight
    // reaches the device through the connection, so it finds nothing.
    const error = await readDeviceVirtualFeed({
      organizationId: orgId,
      feedId,
      feedKey: FEED_KEY,
      feedConfig: {},
      connectionId,
      connectorKey: CONNECTOR_KEY,
      deviceWorkerId: foreign[0].id,
      requiredCapability: 'whatsapp_local',
    }).then(
      () => new Error('expected the read to be refused'),
      (err: unknown) => err as Error
    );
    expect(error.message).toMatch(/cannot reach/);
    // And nothing about the other tenant's machine reaches this caller.
    expect(error.message).not.toContain('Acme Corp Mac');
    expect(error.message).not.toContain('last polled');
    expect(await readRunRows()).toHaveLength(0);

    await sql`DELETE FROM device_workers WHERE id = ${foreign[0].id}::uuid`;
  });

  it('fails fast with a diagnosis when the paired device is offline', async () => {
    await setDeviceLastSeen('30 minutes');
    await expect(readVirtualFeed({ scope: scope(), feedId })).rejects.toThrow(
      /is unavailable: device "Test Mac" is offline \(last polled 30m ago\)/
    );
    // No run parked for the 60s queue budget — the server already knew.
    expect(await readRunRows()).toHaveLength(0);
  });

  it('fails fast when the device no longer grants the connector capability', async () => {
    await setDeviceCapabilities([]);
    await expect(readVirtualFeed({ scope: scope(), feedId })).rejects.toThrow(
      /no longer grants 'whatsapp_local'/
    );
    expect(await readRunRows()).toHaveLength(0);
  });
});

/**
 * Which org an UNPINNED device-backed virtual feed may be served in.
 *
 * poll.ts branch 1B gates the unpinned claim on `baseOrgScopeIds` — the worker
 * token's bound org plus the owner's personal org. At preflight time no token
 * has been presented, so the bound org is unknowable and only the personal-org
 * half is derivable. The preflight therefore serves exactly that lane and tells
 * a shared workspace to pin instead. Widening it to "any org the owner is a
 * member of" would report servable for runs branch 1B never claims, turning an
 * instant error into a 60-second queue timeout.
 *
 *   (1) PERSONAL org, unpinned, owner's device online — served end to end, even
 *       though `device_workers.organization_id` still points at a different,
 *       stale home org. The token here is genuinely user-scoped and bound to
 *       the personal org, so the real branch-1B SQL is what claims the run.
 *   (2) TEAM org, unpinned, owned by a mere member — refused with the fix ("pin
 *       this connection"), and zero runs enqueued.
 *   (3) That same TEAM connection, once PINNED, is served — the pinned branch
 *       already reaches through the connection and allows a foreign home org.
 */
const PERSONAL_WORKER_ID = 'wk-wa-personal';
const CAPABILITY = 'whatsapp_local';

const PERSONAL_ROWS = [{ id: 'wa-90', occurred_at: '2026-08-18T09:00:00.000Z', text: 'live row' }];
const PERSONAL_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'occurred_at', type: 'timestamptz' },
  { name: 'text', type: 'text' },
];

let personalUserId: string;
let personalOrgId: string;
let staleHomeOrgId: string;
let teamOrgId: string;
let personalDeviceWorkerId: string;
let personalFeedId: number;
let teamFeedId: number;
let teamConnectionId: number;

const scopeIn = (organizationId: string): AuthzScope => ({ organizationId, principal: personalUserId });

/**
 * The real poll handler behind a stub for the auth middleware ONLY — the shape
 * device-management-mint.test.ts uses. Everything that decides whether this
 * device may claim (branch 1B, `baseOrgScopeIds`, the capability allowlist, the
 * device_workers upsert) is production code.
 *
 * `boundOrgId` is what the worker token is bound to, so `workerOrgIds` here is
 * the genuine [bound org, personal org] pair poll.ts computes from a real
 * device_worker:run token.
 */
function personalDeviceApp(boundOrgId: string): Hono {
  const app = new Hono();
  app.post(
    '/api/workers/poll',
    async (c, next) => {
      c.set('workerAuthMode' as never, 'user' as never);
      c.set('workerUserId' as never, personalUserId as never);
      c.set(
        'workerOrgIds' as never,
        Array.from(new Set([boundOrgId, personalOrgId])) as never
      );
      c.set('organizationId' as never, boundOrgId as never);
      c.set('mcpAuthInfo' as never, { scopes: ['device_worker:run'] } as never);
      await next();
    },
    (c) => pollWorkerJob(c as never)
  );
  return app;
}

async function pollPersonalDevice(boundOrgId: string): Promise<Record<string, unknown> | null> {
  const response = await personalDeviceApp(boundOrgId).fetch(
    new Request('http://localhost/api/workers/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: PERSONAL_WORKER_ID,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Personal Mac',
        capabilities: { [CAPABILITY]: true },
      }),
    }),
    {} as never
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown> | null;
}

/** Stand in for the Mac: claim the reserved live-read run and answer it. */
async function respondAsPersonalDevice(boundOrgId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const job = await pollPersonalDevice(boundOrgId);
    if (job?.run_id && job?.operation_key === DEVICE_VIRTUAL_FEED_ACTION_KEY) {
      const completion = await post('/api/workers/complete-action', {
        body: {
          run_id: job.run_id,
          worker_id: PERSONAL_WORKER_ID,
          status: 'success',
          action_output: { rows: PERSONAL_ROWS, columns: PERSONAL_COLUMNS },
        },
      });
      expect(completion.status).toBe(200);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('device never received the virtual-feed read job');
}

async function countRuns(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT count(*)::int AS n FROM runs WHERE organization_id = ${organizationId}
  `) as Array<{ n: number }>;
  return row.n;
}

async function readFails(organizationId: string, feedId: number): Promise<Error> {
  const error = await readVirtualFeed({
    scope: scopeIn(organizationId),
    feedId,
    terms: ['live'],
    limit: 10,
  }).then(
    () => null,
    (err: Error) => err
  );
  if (!error) throw new Error('expected the read to be refused');
  return error;
}

/** A device-manifest connector + an unpinned virtual feed in `organizationId`. */
async function seedPersonalLaneConnection(
  organizationId: string,
  slug: string
): Promise<{ connectionId: number; feedId: number }> {
  const sql = getTestDb();
  await sql`
    INSERT INTO connector_definitions
      (key, name, version, organization_id, status, runtime, required_capability,
       feeds_schema, auth_schema, created_at, updated_at)
    VALUES (${CONNECTOR_KEY}, 'WhatsApp (this Mac)', ${CONNECTOR_VERSION}, ${organizationId}, 'active',
            ${sql.json({ platforms: ['macos'] })}, ${CAPABILITY},
            ${sql.json({ [FEED_KEY]: { key: FEED_KEY, virtual: true } })},
            ${sql.json({ methods: [{ type: 'none' }] })}, NOW(), NOW())
  `;
  const connection = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, slug, display_name, status, visibility,
       device_worker_id, created_by, created_at, updated_at)
    VALUES (${organizationId}, ${CONNECTOR_KEY}, ${slug}, 'WhatsApp (this Mac)',
            'active', 'organization', NULL, ${personalUserId}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  const feed = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, display_name, status, config,
       kind, virtual, next_run_at)
    VALUES (${organizationId}, ${connection[0].id}, ${FEED_KEY}, 'Messages (live)', 'active',
            ${sql.json({ recall: true })}, 'virtual', true, NULL)
    RETURNING id
  `) as Array<{ id: number }>;
  return { connectionId: connection[0].id, feedId: feed[0].id };
}

describe('unpinned device virtual-feed reads are a personal-org lane', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const user = await createTestUser({ email: 'wa-personal@test.com' });
    personalUserId = user.id;

    const personal = await createTestOrganization({ name: 'Personal' });
    personalOrgId = personal.id;
    await addUserToOrganization(personalUserId, personalOrgId, 'owner');
    const staleHome = await createTestOrganization({ name: 'Old Home' });
    staleHomeOrgId = staleHome.id;
    await addUserToOrganization(personalUserId, staleHomeOrgId, 'owner');
    const team = await createTestOrganization({ name: 'Acme Workspace' });
    teamOrgId = team.id;
    await addUserToOrganization(personalUserId, teamOrgId, 'member');

    const sql = getTestDb();
    await sql`
      UPDATE "organization" SET metadata = ${sql.json({ personal_org_for_user_id: personalUserId })}
      WHERE id = ${personalOrgId}
    `;

    // `organization_id` is the device's HOME org, written once at pairing. It
    // points at neither org under test, which is the point: the lane is decided
    // by which org IS this user's personal one, not by this stale column.
    const device = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${personalUserId}, ${PERSONAL_WORKER_ID}, 'macos', '9.9.0',
              ${sql.json([CAPABILITY])}, 'Personal Mac', ${staleHomeOrgId})
      RETURNING id
    `) as Array<{ id: string }>;
    personalDeviceWorkerId = device[0].id;

    await sql`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, created_at)
      VALUES (${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, NULL,
              ${`device-manifest://macos/${CONNECTOR_KEY}@${CONNECTOR_VERSION}`}, NOW())
    `;
    personalFeedId = (await seedPersonalLaneConnection(personalOrgId, 'whatsapp-personal')).feedId;
    const teamSeed = await seedPersonalLaneConnection(teamOrgId, 'whatsapp-team');
    teamConnectionId = teamSeed.connectionId;
    teamFeedId = teamSeed.feedId;
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM runs WHERE organization_id IN (${personalOrgId}, ${teamOrgId})`;
    await sql`
      UPDATE device_workers
      SET last_seen_at = now(), capabilities = ${sql.json([CAPABILITY])}
      WHERE id = ${personalDeviceWorkerId}::uuid
    `;
    await sql`
      UPDATE connections SET device_worker_id = NULL WHERE id = ${teamConnectionId}
    `;
  });

  it('serves an unpinned read in the personal org despite a stale device home org', async () => {
    const sql = getTestDb();
    const [home] = (await sql`
      SELECT organization_id FROM device_workers WHERE id = ${personalDeviceWorkerId}::uuid
    `) as Array<{ organization_id: string }>;
    // The premise: were these equal the case would prove nothing.
    expect(home.organization_id).toBe(staleHomeOrgId);
    expect(home.organization_id).not.toBe(personalOrgId);

    const reading = readVirtualFeed({
      scope: scopeIn(personalOrgId),
      feedId: personalFeedId,
      terms: ['live'],
      limit: 10,
    });
    const job = await respondAsPersonalDevice(personalOrgId);

    expect(job.connector_key).toBe(CONNECTOR_KEY);
    expect(job.operation_key).toBe(DEVICE_VIRTUAL_FEED_ACTION_KEY);
    const live = await reading;
    expect(live.rows).toEqual(PERSONAL_ROWS);

    // The home org is set-once, so serving the personal org did not re-anchor
    // the device — the next read is the same shape.
    const [after] = (await sql`
      SELECT organization_id FROM device_workers WHERE id = ${personalDeviceWorkerId}::uuid
    `) as Array<{ organization_id: string }>;
    expect(after.organization_id).toBe(staleHomeOrgId);
  });

  it('refuses an unpinned read in a team org and says to pin it', async () => {
    const error = await readFails(teamOrgId, teamFeedId);
    expect(error.message).toMatch(/not pinned to a device/);
    // The fix, not just the diagnosis.
    expect(error.message).toMatch(/pin it to the device that should serve it/);
    // Membership in the team org is NOT what makes a device servable: branch 1B
    // gates on the token's bound org, which this preflight cannot see.
    expect(error.message).not.toMatch(/no online device/);
    expect(await countRuns(teamOrgId)).toBe(0);
  });

  it('serves the same team connection once it is pinned to the device', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE connections SET device_worker_id = ${personalDeviceWorkerId}::uuid
      WHERE id = ${teamConnectionId}
    `;

    const reading = readVirtualFeed({
      scope: scopeIn(teamOrgId),
      feedId: teamFeedId,
      terms: ['live'],
      limit: 10,
    });
    const job = await respondAsPersonalDevice(teamOrgId);
    expect(job.operation_key).toBe(DEVICE_VIRTUAL_FEED_ACTION_KEY);
    const live = await reading;
    expect(live.rows).toEqual(PERSONAL_ROWS);
  });
});

/**
 * Lifecycle of the transport run: DEADLINES and ORPHAN sweeping.
 *
 * The read seam's `finally` scrubs on every path the gateway process survives.
 * Two holes remain, and this block is about both:
 *
 *   (1) AMBIENT recall must not inherit the deliberate-read budget. A live feed
 *       opted into `search_memory` is a side dish — it runs on every call — so
 *       one sleeping laptop must not stall a chat turn for the device queue's
 *       60s pre-claim plus 95s post-claim. The deadline ABORTS rather than only
 *       racing: the waiter stops polling and terminalizes its run, and the
 *       cleanup scrubs it, so nothing is left holding a page of messages.
 *   (2) A gateway that DIES mid-read runs no `finally` at all. The retention
 *       promise cannot rest on a process staying alive, so the reaper
 *       re-asserts it set-wise from whichever replica is up.
 */
const LIFECYCLE_WORKER_ID = 'wk-wa-lifecycle';

const { gatherRecall, RECALL_SOURCES } = await import('../../../tools/search');
const { sweepAbandonedVirtualFeedReadRuns } = await import(
  '../../../scheduled/check-stalled-executions'
);
const { manageOperations } = await import('../../../tools/admin/manage_operations');
const { ownerToolContext } = await import('../../setup/test-fixtures');
// manage_operations builds org-scoped view URLs, so the workspace provider has
// to be up. Initialized HERE rather than inherited from whichever suite booted
// the app first — that would make this case pass only in a particular file
// order.
const { initWorkspaceProvider } = await import('../../../workspace');

let lifecycleOrgId: string;
let lifecycleUserId: string;
let lifecycleDeviceId: string;
let lifecycleConnectionId: number;
let lifecycleFeedId: number;

const virtualRecallSource = () => {
  const source = RECALL_SOURCES.find((s) => s.kind === 'virtual');
  if (!source) throw new Error('the virtual recall source is no longer registered');
  return source;
};

/**
 * A second recall source that always succeeds fast. Its facet is how we tell
 * "the virtual feed was skipped" from "recall itself fell over" — the point of
 * a per-source deadline is that the other readers still answer.
 */
const fastStubSource = {
  kind: 'conversation' as const,
  source: 'chat-channel' as never,
  lens: 'recall' as const,
  canRead: () => true,
  read: async () => ({
    conversation_messages: [
      {
        id: 1,
        channel: 'stub',
        text: 'other recall sources still answered',
        author: null,
        occurred_at: null,
      },
    ],
  }),
} as unknown as (typeof RECALL_SOURCES)[number];

function lifecycleRecallContext(): Parameters<typeof gatherRecall>[1] {
  return {
    query: 'invoice',
    contentAgentId: undefined,
    contentLimit: 5,
    env: {} as never,
  };
}

async function lifecycleRuns(): Promise<
  Array<{
    id: number;
    status: string;
    action_key: string;
    action_input: unknown;
    action_output: unknown;
    error_message: string | null;
  }>
> {
  const sql = getTestDb();
  return (await sql`
    SELECT id, status, action_key, action_input, action_output, error_message
    FROM runs
    WHERE organization_id = ${lifecycleOrgId} AND run_type = 'action'
    ORDER BY id
  `) as Array<{
    id: number;
    status: string;
    action_key: string;
    action_input: unknown;
    action_output: unknown;
    error_message: string | null;
  }>;
}

/** Insert a live-read run in an arbitrary state, bypassing the read seam. */
async function seedReservedRun(opts: {
  status: string;
  actionKey?: string;
  completedAtSecondsAgo?: number | null;
  expiresAtSecondsFromNow?: number | null;
  claimedSecondsAgo?: number | null;
  heartbeatSecondsAgo?: number | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, action_output, approval_status, status,
      completed_at, expires_at, claimed_at, last_heartbeat_at, created_at
    ) VALUES (
      ${lifecycleOrgId}, 'action', ${lifecycleConnectionId}, ${CONNECTOR_KEY},
      ${CONNECTOR_VERSION},
      ${opts.actionKey ?? DEVICE_VIRTUAL_FEED_ACTION_KEY},
      ${sql.json({ feed_key: FEED_KEY, terms: ['tenancy deposit'], chat_jids: ['15551230000@s.whatsapp.net'] })},
      ${sql.json({ rows: DEVICE_ROWS })},
      'auto', ${opts.status},
      ${opts.completedAtSecondsAgo == null
        ? null
        : sql`current_timestamp - (${opts.completedAtSecondsAgo}::int * interval '1 second')`},
      ${opts.expiresAtSecondsFromNow == null
        ? null
        : sql`current_timestamp + (${opts.expiresAtSecondsFromNow}::int * interval '1 second')`},
      ${opts.claimedSecondsAgo == null
        ? null
        : sql`current_timestamp - (${opts.claimedSecondsAgo}::int * interval '1 second')`},
      ${opts.heartbeatSecondsAgo == null
        ? null
        : sql`current_timestamp - (${opts.heartbeatSecondsAgo}::int * interval '1 second')`},
      current_timestamp
    )
    RETURNING id
  `) as Array<{ id: number }>;
  return row.id;
}

/**
 * Wait for the transport run to reach its terminal, scrubbed state.
 *
 * The recall deadline returns control to the CALLER first and lets the aborted
 * read finish tearing itself down behind it — that ordering is the point (the
 * caller is not made to wait on cleanup), so the assertion has to follow the
 * cleanup rather than assume it already ran. Bounded: if it never converges the
 * test fails on the assertions after this returns.
 */
async function awaitScrubbedRun(timeoutMs = 5_000): Promise<
  Array<{ id: number; status: string; action_input: unknown; action_output: unknown }>
> {
  const deadline = Date.now() + timeoutMs;
  let runs = await lifecycleRuns();
  while (Date.now() < deadline) {
    if (runs.length > 0 && runs.every((r) => r.status === 'timeout' && r.action_output === null)) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    runs = await lifecycleRuns();
  }
  return runs;
}

async function readRunById(runId: number): Promise<{
  status: string;
  action_input: unknown;
  action_output: unknown;
  error_message: string | null;
}> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, action_input, action_output, error_message FROM runs WHERE id = ${runId}
  `) as Array<{
    status: string;
    action_input: unknown;
    action_output: unknown;
    error_message: string | null;
  }>;
  return row;
}

describe('device virtual-feed read lifecycle — deadlines and orphan sweeping', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'WA Lifecycle' });
    lifecycleOrgId = org.id;
    const user = await createTestUser({ email: 'wa-lifecycle@test.com' });
    lifecycleUserId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    const sql = getTestDb();
    await sql`
      UPDATE "organization" SET metadata = ${sql.json({ personal_org_for_user_id: lifecycleUserId })}
      WHERE id = ${lifecycleOrgId}
    `;
    const device = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${lifecycleUserId}, ${LIFECYCLE_WORKER_ID}, 'macos', '9.9.0',
              ${sql.json([CAPABILITY])}, 'Lifecycle Mac', ${lifecycleOrgId})
      RETURNING id
    `) as Array<{ id: string }>;
    lifecycleDeviceId = device[0].id;

    // No `actions_schema`: the reserved read key is protocol, never a declared
    // operation. The manage_operations case below is what pins that.
    await sql`
      INSERT INTO connector_definitions
        (key, name, version, organization_id, status, runtime, required_capability,
         feeds_schema, auth_schema, created_at, updated_at)
      VALUES (${CONNECTOR_KEY}, 'WhatsApp (this Mac)', ${CONNECTOR_VERSION}, ${lifecycleOrgId},
              'active', ${sql.json({ platforms: ['macos'] })}, ${CAPABILITY},
              ${sql.json({ [FEED_KEY]: { key: FEED_KEY, virtual: true } })},
              ${sql.json({ methods: [{ type: 'none' }] })}, NOW(), NOW())
    `;
    await sql`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, created_at)
      VALUES (${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, NULL,
              ${`device-manifest://macos/${CONNECTOR_KEY}@${CONNECTOR_VERSION}`}, NOW())
    `;
    const connection = (await sql`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, visibility,
         device_worker_id, created_by, created_at, updated_at)
      VALUES (${lifecycleOrgId}, ${CONNECTOR_KEY}, 'whatsapp-lifecycle', 'WhatsApp (this Mac)',
              'active', 'organization', ${lifecycleDeviceId}::uuid, ${lifecycleUserId}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    lifecycleConnectionId = connection[0].id;
    const feed = (await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, display_name, status, config,
         kind, virtual, next_run_at)
      VALUES (${lifecycleOrgId}, ${lifecycleConnectionId}, ${FEED_KEY}, 'Messages (live)', 'active',
              ${sql.json({ recall: true })}, 'virtual', true, NULL)
      RETURNING id
    `) as Array<{ id: number }>;
    lifecycleFeedId = feed[0].id;
  });

  afterAll(async () => {
    __setDeviceActionWaiterForTest(null);
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    __setDeviceActionWaiterForTest(null);
    const sql = getTestDb();
    await sql`DELETE FROM runs WHERE organization_id = ${lifecycleOrgId}`;
    await sql`
      UPDATE device_workers
      SET last_seen_at = now(), capabilities = ${sql.json([CAPABILITY])}
      WHERE id = ${lifecycleDeviceId}::uuid
    `;
  });

  // The abort has to reach the WAITER, not just the caller. A `Promise.race`
  // alone would return control while the run stayed pending for the full 60s
  // queue budget, holding the caller's terms and claimable by a device that
  // would then post a page of messages into it.
  it('an aborted read stops waiting, terminalizes the run, and scrubs it', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);

    const startedAt = Date.now();
    const error = await readDeviceVirtualFeed({
      organizationId: lifecycleOrgId,
      feedId: lifecycleFeedId,
      feedKey: FEED_KEY,
      feedConfig: {},
      connectionId: lifecycleConnectionId,
      connectorKey: CONNECTOR_KEY,
      deviceWorkerId: lifecycleDeviceId,
      requiredCapability: CAPABILITY,
      terms: ['tenancy deposit'],
      signal: controller.signal,
    }).then(
      () => null,
      (err: Error) => err
    );
    const elapsedMs = Date.now() - startedAt;

    if (!error) throw new Error('expected the aborted read to fail');
    // Reported as a caller deadline, NOT as a device timeout: nothing here says
    // the device is unhealthy — it was never given the 60s the other message
    // would quote.
    expect(error.message).toMatch(/cut short by the caller's read deadline/);
    // Nowhere near the 60s pre-claim budget it would otherwise have waited.
    expect(elapsedMs).toBeLessThan(10_000);

    const runs = await lifecycleRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('timeout');
    expect(runs[0].action_output).toBeNull();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('tenancy deposit');
  }, 30_000);

  // The preflight is two DB round-trips. An ambient read on a few seconds'
  // budget can spend it in there, and enqueueing afterwards would create a
  // transport run whose only future is cancellation — a row briefly holding the
  // caller's terms for a read nobody is waiting on.
  it('creates no transport run when the deadline expires during the preflight', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await readDeviceVirtualFeed({
      organizationId: lifecycleOrgId,
      feedId: lifecycleFeedId,
      feedKey: FEED_KEY,
      feedConfig: {},
      connectionId: lifecycleConnectionId,
      connectorKey: CONNECTOR_KEY,
      deviceWorkerId: lifecycleDeviceId,
      requiredCapability: CAPABILITY,
      terms: ['tenancy deposit'],
      signal: controller.signal,
    }).then(
      () => null,
      (err: Error) => err
    );

    if (!error) throw new Error('expected the aborted read to fail');
    expect(error.message).toMatch(/before the request reached the paired device/);
    // Nothing enqueued at all — not enqueued-then-scrubbed.
    expect(await lifecycleRuns()).toHaveLength(0);
  });

  it('bounds ambient recall to the per-feed budget while other sources still answer', async () => {
    const startedAt = Date.now();
    const recalled = await gatherRecall(
      { organizationId: lifecycleOrgId, principal: lifecycleUserId },
      lifecycleRecallContext(),
      [virtualRecallSource(), fastStubSource]
    );
    const elapsedMs = Date.now() - startedAt;

    // The budget bounded it. Without the deadline this is the device queue's
    // 60s pre-claim wait, on every single search_memory call.
    expect(elapsedMs).toBeLessThan(20_000);
    // The live feed contributed nothing — correctly, no device answered.
    expect(recalled.virtual_feeds).toBeUndefined();
    // …and the other reader was untouched by it.
    expect(recalled.conversation_messages).toHaveLength(1);

    // The abandoned transport run was closed and emptied, not left in flight.
    const runs = await awaitScrubbedRun();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('timeout');
    expect(runs[0].action_output).toBeNull();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
  }, 40_000);

  it('still returns live rows when the device answers inside the budget', async () => {
    // A device that answers immediately: the deadline exists to bound the slow
    // case, and must not cost the fast one.
    __setDeviceActionWaiterForTest(async () => ({
      status: 'completed' as const,
      output: { rows: DEVICE_ROWS, columns: DEVICE_COLUMNS },
    }));

    const recalled = await gatherRecall(
      { organizationId: lifecycleOrgId, principal: lifecycleUserId },
      lifecycleRecallContext(),
      [virtualRecallSource(), fastStubSource]
    );

    expect(recalled.virtual_feeds).toHaveLength(1);
    expect(recalled.virtual_feeds?.[0]).toMatchObject({
      feed_id: lifecycleFeedId,
      feed_key: FEED_KEY,
      rows: DEVICE_ROWS,
    });
    expect(recalled.conversation_messages).toHaveLength(1);
  }, 30_000);

  // Everything below is the CRASH path: rows the in-process `finally` never got
  // to, because the process that owned it is gone.
  it('scrubs a completed live-read run the crashed gateway never cleaned up', async () => {
    const runId = await seedReservedRun({ status: 'completed', completedAtSecondsAgo: 120 });

    expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(1);

    const after = await readRunById(runId);
    // The verdict is not the sweep's to rewrite — only the payload is.
    expect(after.status).toBe('completed');
    expect(after.action_output).toBeNull();
    expect(after.action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(after)).not.toContain('tenancy deposit');
    expect(JSON.stringify(after)).not.toContain('15551230000@s.whatsapp.net');
    expect(JSON.stringify(after)).not.toContain('invoice 4471');

    // Idempotent: a second tick has nothing left to do.
    expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(0);
  });

  it('times out AND scrubs an in-flight live-read run whose claim horizon lapsed', async () => {
    const runId = await seedReservedRun({ status: 'pending', expiresAtSecondsFromNow: -30 });

    expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(1);

    const after = await readRunById(runId);
    // Terminal, so a device that wakes up late cannot claim it and post a fresh
    // page of messages into the row we just cleared.
    expect(after.status).toBe('timeout');
    expect(after.action_output).toBeNull();
    expect(after.action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(after.error_message).toMatch(/swept by the run reaper/);
    expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(0);
  });

  // `expires_at` on a device action is the UNCLAIMED claim horizon, not an
  // execution deadline — queue-service stamps it so an unclaimed run cannot sit
  // pending forever, and poll.ts enforces it only against `status = 'pending'`.
  // A device that claimed a WhatsApp query one second before expiry is doing
  // exactly what it was asked to; timing it out here would kill live work on a
  // clock that was never about execution.
  it('leaves a CLAIMED run with a lapsed horizon alone while it is still beating', async () => {
    for (const status of ['claimed', 'running']) {
      const runId = await seedReservedRun({
        status,
        expiresAtSecondsFromNow: -30,
        claimedSecondsAgo: 40,
        heartbeatSecondsAgo: 1,
      });

      expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(0);

      const after = await readRunById(runId);
      expect(after.status).toBe(status);
      expect(after.action_output).not.toBeNull();
      // The heartbeat/coarse reaper owns this row's failure; once IT
      // terminalizes, the terminal-grace lane clears the payload on a later
      // tick, so nothing is left holding messages either way.
      expect(JSON.stringify(after.action_input)).toContain('tenancy deposit');
      await getTestDb()`DELETE FROM runs WHERE id = ${runId}`;
    }
  });

  // The grace is the whole reason the sweep can run on a 30s tick without
  // breaking healthy reads: a run marked `completed` a moment ago is about to
  // be picked up by a waiter polling every 500ms.
  it('leaves a freshly completed run alone until the grace elapses', async () => {
    const runId = await seedReservedRun({ status: 'completed', completedAtSecondsAgo: 1 });

    expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(0);

    const after = await readRunById(runId);
    expect(after.action_output).not.toBeNull();
    expect(JSON.stringify(after.action_input)).toContain('tenancy deposit');
  });

  it('never touches an unrelated action run', async () => {
    const reservedId = await seedReservedRun({ status: 'completed', completedAtSecondsAgo: 120 });
    const unrelatedId = await seedReservedRun({
      status: 'completed',
      actionKey: 'send_message',
      completedAtSecondsAgo: 120,
    });

    expect(await sweepAbandonedVirtualFeedReadRuns(getTestDb())).toBe(1);

    expect((await readRunById(reservedId)).action_output).toBeNull();
    const unrelated = await readRunById(unrelatedId);
    expect(unrelated.action_output).not.toBeNull();
    expect(JSON.stringify(unrelated.action_input)).toContain('tenancy deposit');
  });

  // The reserved key is dispatched by the gateway, never declared. Declaring it
  // would flip `supportsExecute` and publish a read seam as a user-invokable
  // operation — so it must not be listable or executable through the operations
  // surface at all.
  it('does not expose the reserved read key as a manage_operations operation', async () => {
    const ctx = ownerToolContext(lifecycleOrgId, lifecycleUserId);
    const listed = (await manageOperations(
      { action: 'list_available', connector_key: CONNECTOR_KEY },
      {} as never,
      ctx
    )) as { operations?: Array<{ operation_key: string }> };
    expect(
      (listed.operations ?? []).some((o) => o.operation_key === DEVICE_VIRTUAL_FEED_ACTION_KEY)
    ).toBe(false);

    const executed = (await manageOperations(
      {
        action: 'execute',
        connection_id: lifecycleConnectionId,
        operation_key: DEVICE_VIRTUAL_FEED_ACTION_KEY,
        input: { feed_key: FEED_KEY, terms: ['invoice'], limit: 5, offset: 0, sort: null },
      },
      {} as never,
      ctx
    ).catch((err: Error) => ({ success: false, error: err.message }))) as {
      success?: boolean;
      error?: string;
    };
    expect(executed.success).not.toBe(true);
    // Refused because the key is not in `actions_schema` — the same gate any
    // undeclared operation hits, which is exactly the property being pinned.
    expect(String(executed.error ?? '')).toBe(
      `Invalid operation_key '${DEVICE_VIRTUAL_FEED_ACTION_KEY}' for this connection.`
    );
    // And no run was enqueued behind the refusal.
    expect(await lifecycleRuns()).toHaveLength(0);
  }, 30_000);
});
