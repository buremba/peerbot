/**
 * The ACL source registry — the ONE place core code COLLECTS the
 * access-controlled sources. Each descriptor is owned by its connector
 * (`@lobu/connectors/<key>-identity` exports the `AclSourceDef`); this file only
 * gathers them so the generic read gate (`./resource-visibility`) and sync loop
 * (`./acl-sync`) can iterate every source without naming a connector.
 *
 * Adding Linear/Jira/Drive = a connector that exports an `AclSourceDef` +
 * appending it here. No new gate code, no new engine code.
 */

import type { AclSourceDef, ChannelReadIdentity } from '@lobu/connector-sdk';
import { githubAclSource } from '@lobu/connectors/github-identity';
import { slackAclSource, slackChannelReadIdentity } from '@lobu/connectors/slack-identity';

/** Every registered ACL source (contributed by its connector package). */
export const ACL_SOURCES: AclSourceDef[] = [slackAclSource, githubAclSource];

/** Resource entity-type slugs that the read gate treats as access-controlled.
 * Validated to simple identifiers so they can be inlined as SQL literals. */
export const RESOURCE_TYPE_SLUGS: string[] = ACL_SOURCES.map((s) => {
  const slug = s.resourceType.slug;
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Invalid ACL resource type slug (must be a simple identifier): ${slug}`);
  }
  return slug;
});

/**
 * Chat platforms whose per-channel read gate is enforced, keyed by `platform`.
 * Each descriptor (owned by its connector) tells the gate how to key a channel
 * and a requester for that platform, so `channel-visibility` /
 * `channel-messages-visibility` / `channel-entity` / `acl-state` name no
 * connector. GitHub is NOT here — its resource gate is repo-based, not the
 * team-scoped chat-channel model.
 *
 * Adding Telegram/Discord chat ACL = the connector exports a
 * `ChannelReadIdentity` + appending it here. No gate code changes.
 */
export const CHANNEL_READ_IDENTITIES: ChannelReadIdentity[] = [slackChannelReadIdentity];

const CHANNEL_READ_IDENTITY_BY_PLATFORM = new Map<string, ChannelReadIdentity>(
  CHANNEL_READ_IDENTITIES.map((c) => [c.platform, c]),
);

/**
 * The read-gate identity model for a chat platform, or null when that platform
 * has no enforced channel gate (→ the caller falls back to non-enforced /
 * passthrough behavior). Never throws.
 */
export function channelReadIdentityFor(platform: string): ChannelReadIdentity | null {
  return CHANNEL_READ_IDENTITY_BY_PLATFORM.get(platform) ?? null;
}
