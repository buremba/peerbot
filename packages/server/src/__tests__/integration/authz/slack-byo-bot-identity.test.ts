/**
 * `resolveSlackBotIdentity` — the bot-token/user-id resolution that backs Slack
 * ACL sync. Covers the gap that left BYO Slack connections ungraphed: an active
 * connection with real bindings but NO OAuth app-installation must resolve its
 * bot identity from the connection's OWN config, not fail closed. Also proves
 * the install path still wins when an install exists, and that a teamId-less BYO
 * connection self-heals its team via `auth.test` (the real prod case: a BYO
 * connection created without an OAuth install never persists a teamId).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSlackBotIdentity } from '../../../authz/slack-acl-sync';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestOrganization,
  insertChatConnectionRow,
} from '../../setup/test-fixtures';

// A no-op secret store: our test tokens are plaintext (not `secret://` refs), so
// resolveSecretValue returns them verbatim without ever calling `.get`.
const secretStore = {
  get: async () => undefined,
} as unknown as Parameters<typeof resolveSlackBotIdentity>[0]['secretStore'];

// Install store that reports NO install for any team — forces the BYO fallback.
// `getSlackInstallByTeamId` calls `resolveActiveByTenant`; returning null there
// is the "no install" signal.
const emptyInstallStore = {
  resolveActiveByTenant: async () => null,
} as unknown as Parameters<typeof resolveSlackBotIdentity>[0]['installStore'];

// Slack Web stub. `authTest` is only reached on the self-heal path (a BYO
// connection with no stored teamId); the default throws so any UNEXPECTED
// auth.test call surfaces as a test failure. Individual tests override it.
function makeSlackWeb(authTest?: (token: string) => Promise<{ teamId: string }>) {
  return {
    authTest:
      authTest ??
      (async () => {
        throw new Error('auth.test should not be called on the fast path');
      }),
  } as unknown as Parameters<typeof resolveSlackBotIdentity>[0]['slackWeb'];
}

const TEAM = 'T0BYOTEAM';

describe('resolveSlackBotIdentity — BYO fallback', () => {
  let orgId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization();
    orgId = org.id;
  });

  it('falls back to the connection\'s own bot token + user id when there is no install', async () => {
    await insertChatConnectionRow({
      id: 'conn-byo',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { teamId: TEAM, botUserId: 'U0BYOBOT' },
    });

    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb: makeSlackWeb() },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-byo' },
    );

    expect(identity).toEqual({ token: 'xoxb-byo-token', botUserId: 'U0BYOBOT' });
  });

  it('returns null when neither an install nor a BYO token exists (fails closed)', async () => {
    await insertChatConnectionRow({
      id: 'conn-notoken',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: {}, // no botToken
      metadata: { teamId: TEAM },
    });

    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb: makeSlackWeb() },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-notoken' },
    );

    expect(identity).toBeNull();
  });

  it('does not resolve a BYO token across orgs (org-scoped lookup)', async () => {
    await insertChatConnectionRow({
      id: 'conn-byo',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { teamId: TEAM, botUserId: 'U0BYOBOT' },
    });

    const other = await createTestOrganization();
    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb: makeSlackWeb() },
      { organizationId: other.id, teamId: TEAM, connectionId: 'conn-byo' },
    );

    expect(identity).toBeNull();
  });

  it('does NOT hand back a BYO token for a team the connection already belongs to a DIFFERENT team', async () => {
    // The connection carries stored team T0BYOTEAM; asking to graph a DIFFERENT
    // team must resolve null (fail-closed) via the stored-team guard, never this
    // connection's own token — otherwise Slack channel_not_found on the foreign
    // team + the empty-member reconcile would wipe live edges the foreign team's
    // real connection maintains. No auth.test needed (stored team suffices).
    await insertChatConnectionRow({
      id: 'conn-byo',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { teamId: TEAM, botUserId: 'U0BYOBOT' },
    });

    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb: makeSlackWeb() },
      { organizationId: orgId, teamId: 'T0OTHERTEAM', connectionId: 'conn-byo' },
    );

    expect(identity).toBeNull();
  });

  it('self-heals a teamId-less BYO connection: auth.test confirms the team, backfills it, returns the token', async () => {
    // The REAL prod case: a BYO connection created without an OAuth install never
    // persists a teamId (external_tenant_id NULL, no config.chatMetadata.teamId).
    // The resolver must confirm the token's team live and backfill it.
    await insertChatConnectionRow({
      id: 'conn-noteam',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { botUserId: 'U0BYOBOT' }, // NO teamId
    });

    let authCalls = 0;
    const slackWeb = makeSlackWeb(async (token) => {
      authCalls += 1;
      expect(token).toBe('xoxb-byo-token');
      return { teamId: TEAM };
    });

    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-noteam' },
    );

    expect(identity).toEqual({ token: 'xoxb-byo-token', botUserId: 'U0BYOBOT' });
    expect(authCalls).toBe(1);

    // Backfilled: external_tenant_id now carries the confirmed team, so the NEXT
    // resolve takes the fast path (no auth.test round-trip).
    const [row] = await getDb()<{ external_tenant_id: string | null }>`
      SELECT external_tenant_id FROM connections WHERE slug = 'agentconn-conn-noteam'
    `;
    expect(row?.external_tenant_id).toBe(TEAM);

    const second = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-noteam' },
    );
    expect(second).toEqual({ token: 'xoxb-byo-token', botUserId: 'U0BYOBOT' });
    expect(authCalls).toBe(1); // fast path — no second auth.test
  });

  it('fails closed for the requested team but backfills the REAL team when auth.test disagrees', async () => {
    // A teamId-less BYO connection whose token actually belongs to another
    // workspace must NOT graph the requested team (would wipe that team's edges).
    // But it SHOULD record the token's real team so it stops re-hitting auth.test
    // every tick and takes the foreign-team fast-fail path thereafter.
    await insertChatConnectionRow({
      id: 'conn-noteam',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { botUserId: 'U0BYOBOT' }, // NO teamId
    });

    let authCalls = 0;
    const slackWeb = makeSlackWeb(async () => {
      authCalls += 1;
      return { teamId: 'T0SOMEOTHER' };
    });

    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-noteam' },
    );

    expect(identity).toBeNull();

    // Backfilled with the token's REAL team (not the requested one).
    const [row] = await getDb()<{ external_tenant_id: string | null }>`
      SELECT external_tenant_id FROM connections WHERE slug = 'agentconn-conn-noteam'
    `;
    expect(row?.external_tenant_id).toBe('T0SOMEOTHER');

    // A subsequent resolve for the requested team takes the foreign-team fast-fail
    // path — no second auth.test round-trip.
    const second = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-noteam' },
    );
    expect(second).toBeNull();
    expect(authCalls).toBe(1);
  });

  it('fails closed when auth.test throws (dead/invalid token)', async () => {
    await insertChatConnectionRow({
      id: 'conn-noteam',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { botUserId: 'U0BYOBOT' }, // NO teamId
    });

    const slackWeb = makeSlackWeb(async () => {
      throw new Error('Slack auth.test failed: invalid_auth');
    });

    const identity = await resolveSlackBotIdentity(
      { installStore: emptyInstallStore, secretStore, slackWeb },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-noteam' },
    );

    expect(identity).toBeNull();
  });

  it('prefers the install path when an active install exists', async () => {
    // Shape it as an AppInstallationRow — toSlackRow reads metadata.external_id,
    // metadata.bot_user_id, metadata.config, externalTenantId, status.
    const installStore = {
      resolveActiveByTenant: async () => ({
        organizationId: orgId,
        externalTenantId: TEAM,
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
        metadata: {
          external_id: 'slackinst-abc',
          bot_user_id: 'U0INSTALLBOT',
          config: { botToken: 'xoxb-install-token' },
        },
      }),
    } as unknown as Parameters<typeof resolveSlackBotIdentity>[0]['installStore'];

    await insertChatConnectionRow({
      id: 'conn-byo',
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      credentialMode: 'byo',
      config: { botToken: 'xoxb-byo-token' },
      metadata: { teamId: TEAM, botUserId: 'U0BYOBOT' },
    });

    const identity = await resolveSlackBotIdentity(
      { installStore, secretStore, slackWeb: makeSlackWeb() },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-byo' },
    );

    expect(identity).toEqual({ token: 'xoxb-install-token', botUserId: 'U0INSTALLBOT' });
  });
});
