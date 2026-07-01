/**
 * Integration test for the expired unclaimed-Slack-install reaper. Seeds
 * org-less `pending` app_installations rows (marketplace / "Add to Slack"
 * installs nobody claimed) plus an active install, and asserts the reaper only
 * deletes pending rows past the TTL — attempting a best-effort token revoke on
 * each — while leaving fresh pending rows and active/claimed installs untouched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encrypt } from '@lobu/core';
import { getDb } from '../../db/client';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import type { SlackWebApi } from '../../gateway/connections/slack-web';
import { reapExpiredPendingSlackInstalls } from '../reap-expired-pending-installs';

const ORG_ID = 'pending-install-reaper-org';

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
});

/** Every method throws except revokeToken — the reaper only calls revokeToken. */
function fakeSlackApi(): SlackWebApi & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    async revokeToken(botToken: string) {
      revoked.push(botToken);
      return true;
    },
    openDm() {
      throw new Error('not used');
    },
    postMessage() {
      throw new Error('not used');
    },
    conversationMembers() {
      throw new Error('not used');
    },
    conversationInfo() {
      throw new Error('not used');
    },
    exchangeOAuthCode() {
      throw new Error('not used');
    },
  };
}

/** Seed an org-less pending Slack install with a given age + bot token. */
async function seedPending(
  teamId: string,
  ageDays: number,
  botToken: string,
): Promise<void> {
  const sql = getDb();
  await sql.unsafe(
    `INSERT INTO app_installations
       (organization_id, provider, provider_instance, provider_app_id,
        external_tenant_id, status, metadata, created_at, updated_at)
     VALUES
       (NULL, 'slack', 'cloud', 'cloud', $1, 'pending', $2::jsonb,
        now() - ($3::int * interval '1 day'), now())`,
    [teamId, JSON.stringify({ bot_token_enc: encrypt(botToken) }), ageDays],
  );
}

async function pendingTeamIds(): Promise<string[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT external_tenant_id FROM app_installations
    WHERE provider = 'slack' AND status = 'pending'
    ORDER BY external_tenant_id
  `) as unknown as Array<{ external_tenant_id: string }>;
  return rows.map((r) => r.external_tenant_id);
}

describe('reapExpiredPendingSlackInstalls', () => {
  test('deletes only pending rows past the TTL, revoking their tokens; leaves fresh + active alone', async () => {
    // 1. Stale pending (10 days old, TTL 7) — reaped + revoked.
    await seedPending('T-STALE', 10, 'xoxb-stale-token');
    // 2. Fresh pending (1 day old) — left alone.
    await seedPending('T-FRESH', 1, 'xoxb-fresh-token');
    // 3. Active install, org-bound, older than the TTL — must NEVER be touched.
    const sql = getDb();
    await sql.unsafe(
      `INSERT INTO app_installations
         (organization_id, provider, provider_instance, provider_app_id,
          external_tenant_id, status, metadata, created_at, updated_at)
       VALUES
         ($1, 'slack', 'cloud', 'cloud', 'T-ACTIVE', 'active', '{}'::jsonb,
          now() - interval '30 days', now())`,
      [ORG_ID],
    );

    const slack = fakeSlackApi();
    const result = await reapExpiredPendingSlackInstalls(7, slack);

    // Only the stale pending row was reaped.
    expect(result.expired).toBe(1);
    // Its token was decrypted + revoked (never the fresh one).
    expect(slack.revoked).toEqual(['xoxb-stale-token']);

    // Fresh pending survives; the active install is fully intact.
    expect(await pendingTeamIds()).toEqual(['T-FRESH']);
    const active = (await sql`
      SELECT status FROM app_installations WHERE external_tenant_id = 'T-ACTIVE'
    `) as unknown as Array<{ status: string }>;
    expect(active[0]?.status).toBe('active');
  });

  test('never touches another provider even when its row is old + pending-like', async () => {
    // A different provider's row that happens to be old must be out of scope.
    const sql = getDb();
    await sql.unsafe(
      `INSERT INTO app_installations
         (organization_id, provider, provider_instance, provider_app_id,
          external_tenant_id, status, metadata, created_at, updated_at)
       VALUES
         (NULL, 'github', 'cloud', 'cloud', 'gh-old', 'pending', '{}'::jsonb,
          now() - interval '90 days', now())`,
    );

    const slack = fakeSlackApi();
    const result = await reapExpiredPendingSlackInstalls(7, slack);

    expect(result.expired).toBe(0);
    expect(slack.revoked).toEqual([]);
    const gh = (await sql`
      SELECT id FROM app_installations WHERE provider = 'github'
    `) as unknown as Array<{ id: string }>;
    expect(gh.length).toBe(1);
  });

  test('a failed revoke does not block the delete (best-effort)', async () => {
    await seedPending('T-STALE', 10, 'xoxb-stale-token');

    const throwingApi: SlackWebApi = {
      async revokeToken() {
        throw new Error('token_revoked');
      },
      openDm() {
        throw new Error('not used');
      },
      postMessage() {
        throw new Error('not used');
      },
      conversationMembers() {
        throw new Error('not used');
      },
      conversationInfo() {
        throw new Error('not used');
      },
      exchangeOAuthCode() {
        throw new Error('not used');
      },
    };

    const result = await reapExpiredPendingSlackInstalls(7, throwingApi);
    expect(result.expired).toBe(1);
    expect(await pendingTeamIds()).toEqual([]);
  });
});
