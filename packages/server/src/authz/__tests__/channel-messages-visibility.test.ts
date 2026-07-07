/**
 * Unit contract for `compileChannelMessagesVisibility` — the platform-parametric
 * `channel_messages` read gate. Pure (asserts on the compiled `{sql, params}`;
 * runs no query). Proves the gate is driven by the channel-read-identity
 * REGISTRY, not a hardcoded Slack key: each registered chat platform contributes
 * one `platform`-gated membership branch using its own channel namespace + key
 * expression. Adding a platform must extend the OR without editing this compiler.
 */

import { describe, expect, it } from 'vitest';
import type { ChannelReadIdentity } from '@lobu/connector-sdk';
import { SLACK_IDENTITY } from '@lobu/connectors/slack-identity';
import { compileChannelMessagesVisibility } from '../channel-messages-visibility.js';
import { CHANNEL_READ_IDENTITIES } from '../sources.js';
import type { AuthzScope } from '../scope.js';

const scope: AuthzScope = { organizationId: 'org_test', principal: 'user_test' };

/**
 * A synthetic second chat platform, structurally unlike Slack (different
 * namespace + a distinct key SQL shape), used only to exercise the multi-platform
 * OR that the single-registered-platform production registry never reaches. Its
 * key builder is deliberately NOT `UPPER(t||':'||c)` so a leak of Slack's key
 * expression into the other platform's branch would be caught.
 */
const discordIdentity: ChannelReadIdentity = {
  platform: 'discord',
  channelNamespace: 'discord_channel_id',
  userNamespace: 'discord_user_id',
  buildChannelKey: (team, channel) => `${team}/${channel}`,
  buildUserKey: (_team, user) => user,
  channelKeySql: (team, channel) => `LOWER(${team} || '/' || ${channel})`,
};

describe('compileChannelMessagesVisibility', () => {
  it('binds org + principal params from baseParamIndex, in order', () => {
    const { sql, params } = compileChannelMessagesVisibility(scope, 1, 'cm');
    expect(params).toEqual(['org_test', 'user_test']);
    // baseParamIndex=1 → $1 org, $2 principal.
    expect(sql).toContain('$1::text');
    expect(sql).toContain('$2::text');
  });

  it('preserves the not-graphed passthrough and enforced-set fail-closed shape', () => {
    const { sql } = compileChannelMessagesVisibility(scope, 1, 'cm');
    // not-graphed → no acl_state row → passthrough.
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('public.authz_source_acl_state');
    // enforced branch is gated on the enforced-connection set (fail-closed on stale).
    expect(sql).toContain('IN (');
    // membership is via a member_of edge to the channel entity.
    expect(sql).toContain("rt.slug = 'member_of'");
    // requester resolved on the unforgeable auth-signup claim only.
    expect(sql).toContain("mei.source_connector = 'auth:signup'");
  });

  it('emits ONE platform-gated membership branch per registered chat platform', () => {
    const { sql } = compileChannelMessagesVisibility(scope, 1, 'cm');
    for (const identity of CHANNEL_READ_IDENTITIES) {
      // Each registered platform contributes a branch gated on the row's platform…
      expect(sql).toContain(`cm.platform = '${identity.platform}'`);
      // …keyed under THAT platform's channel namespace…
      expect(sql).toContain(`cei.namespace = '${identity.channelNamespace}'`);
      // …using THAT platform's channel-key SQL expression (byte-identical to its
      // TS buildChannelKey), over the team COALESCE + the row's channel_id.
      const teamExpr = `COALESCE(
    cm.team_id,
    conn.external_tenant_id,
    conn.config->'chatMetadata'->>'teamId'
  )`;
      expect(sql).toContain(identity.channelKeySql(teamExpr, 'cm.channel_id'));
    }
  });

  it('registers Slack with the team-scoped slack_channel_id model', () => {
    const slack = CHANNEL_READ_IDENTITIES.find((c) => c.platform === 'slack');
    expect(slack).toBeDefined();
    expect(slack?.channelNamespace).toBe(SLACK_IDENTITY.CHANNEL_ID);
    // The key SQL is UPPER(team || ':' || channel) — the exact form the ACL sync
    // wrote, so an in-query match agrees with the stored identity.
    expect(slack?.channelKeySql('T', 'C')).toBe("UPPER(T || ':' || C)");
    const { sql } = compileChannelMessagesVisibility(scope, 1, 'cm');
    expect(sql).toContain("cm.platform = 'slack'");
    expect(sql).toContain(`cei.namespace = '${SLACK_IDENTITY.CHANNEL_ID}'`);
  });

  describe('multi-platform (≥2 registered) — the OR the production registry never reaches', () => {
    const twoPlatforms = [...CHANNEL_READ_IDENTITIES, discordIdentity];

    it('OR-joins one platform-gated branch per registered platform', () => {
      const { sql } = compileChannelMessagesVisibility(scope, 1, 'cm', twoPlatforms);
      // Both platforms are gated on the row's own platform value…
      expect(sql).toContain("cm.platform = 'slack'");
      expect(sql).toContain("cm.platform = 'discord'");
      // …and the two branches are joined by OR (not AND — a message on EITHER
      // platform is member-visible when the requester belongs to its channel).
      expect(sql).toContain('OR');
      // Exactly two platform gates ⇒ two `cm.platform =` occurrences.
      const gateCount = (sql.match(/cm\.platform = '/g) ?? []).length;
      expect(gateCount).toBe(2);
    });

    it('keeps each platform’s channel-key SQL inside its OWN branch (no cross-leak)', () => {
      const { sql } = compileChannelMessagesVisibility(scope, 1, 'cm', twoPlatforms);
      const teamExpr = `COALESCE(
    cm.team_id,
    conn.external_tenant_id,
    conn.config->'chatMetadata'->>'teamId'
  )`;
      const slackKey = "UPPER(" + teamExpr + " || ':' || cm.channel_id)";
      const discordKey = `LOWER(${teamExpr} || '/' || cm.channel_id)`;
      // Slack's UPPER(...:...) and Discord's LOWER(.../...) each appear, keyed
      // under their own namespace — proving the compiler doesn't hardcode one
      // platform's key expression across every branch.
      expect(sql).toContain(slackKey);
      expect(sql).toContain(discordKey);
      expect(sql).toContain(`cei.namespace = '${discordIdentity.channelNamespace}'`);
      expect(sql).toContain(`cei.namespace = '${SLACK_IDENTITY.CHANNEL_ID}'`);
    });

    it('empty registry ⇒ enforced branch is closed (FALSE), only passthrough can match', () => {
      const { sql } = compileChannelMessagesVisibility(scope, 1, 'cm', []);
      // No registered platform → the member-visible disjunct is the literal FALSE,
      // so an enforced connection matches neither branch and its rows are dropped.
      expect(sql).toContain('FALSE');
      expect(sql).not.toContain("cm.platform = '");
      // The not-graphed passthrough is still present (org-open legacy fence).
      expect(sql).toContain('NOT EXISTS');
    });
  });
});
