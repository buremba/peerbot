/**
 * Unit contract for `compileChannelMessagesVisibility` — the platform-parametric
 * `channel_messages` read gate. Pure (asserts on the compiled `{sql, params}`;
 * runs no query). Proves the gate is driven by the channel-read-identity
 * REGISTRY, not a hardcoded Slack key: each registered chat platform contributes
 * one `platform`-gated membership branch using its own channel namespace + key
 * expression. Adding a platform must extend the OR without editing this compiler.
 */

import { describe, expect, it } from 'vitest';
import { SLACK_IDENTITY } from '@lobu/connectors/slack-identity';
import { compileChannelMessagesVisibility } from '../channel-messages-visibility.js';
import { CHANNEL_READ_IDENTITIES } from '../sources.js';
import type { AuthzScope } from '../scope.js';

const scope: AuthzScope = { organizationId: 'org_test', principal: 'user_test' };

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
});
