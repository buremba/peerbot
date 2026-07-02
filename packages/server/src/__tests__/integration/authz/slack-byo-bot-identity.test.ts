/**
 * `resolveSlackBotIdentity` — the bot-token/user-id resolution that backs Slack
 * ACL sync. Covers the gap that left BYO Slack connections ungraphed: an active
 * connection with real bindings but NO OAuth app-installation must resolve its
 * bot identity from the connection's OWN config, not fail closed. Also proves
 * the install path still wins when an install exists.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSlackBotIdentity } from '../../../authz/slack-acl-sync';
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
      { installStore: emptyInstallStore, secretStore },
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
      { installStore: emptyInstallStore, secretStore },
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
      { installStore: emptyInstallStore, secretStore },
      { organizationId: other.id, teamId: TEAM, connectionId: 'conn-byo' },
    );

    expect(identity).toBeNull();
  });

  it('does NOT hand back a BYO token for a team the connection does not belong to', async () => {
    // The connection is team T0BYOTEAM; asking to graph a DIFFERENT team must
    // resolve null (fail-closed), never this connection's own token — otherwise
    // Slack channel_not_found on the foreign team + the empty-member reconcile
    // would wipe live edges the foreign team's real connection maintains.
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
      { installStore: emptyInstallStore, secretStore },
      { organizationId: orgId, teamId: 'T0OTHERTEAM', connectionId: 'conn-byo' },
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
      { installStore, secretStore },
      { organizationId: orgId, teamId: TEAM, connectionId: 'conn-byo' },
    );

    expect(identity).toEqual({ token: 'xoxb-install-token', botUserId: 'U0INSTALLBOT' });
  });
});
