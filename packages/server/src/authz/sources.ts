/**
 * The ACL source registry — the ONE place core code COLLECTS the
 * access-controlled sources. Each descriptor is owned by its connector
 * (`@lobu/connectors/<key>-identity` exports the `AclSourceDef`); this file only
 * gathers them so the generic read gate (`./resource-visibility`) and sync loop
 * (`./acl-sync`) can iterate every source without naming a connector.
 *
 * Adding Linear/Jira/Drive = a connector that exports an `AclSourceDef` +
 * appending it here. No new gate code, no new engine code.
 *
 * All sources share entity type `$resource` ({@link ACL_RESOURCE_TYPE_SLUG}).
 */

import {
  ACL_RESOURCE_TYPE_SLUG,
  type AclSourceDef,
  type ChannelReadIdentity,
} from '@lobu/connector-sdk';
import { githubAclSource } from '@lobu/connectors/github-identity';
import { slackAclSource, slackChannelReadIdentity } from '@lobu/connectors/slack-identity';

/** Every registered ACL source (contributed by its connector package). */
export const ACL_SOURCES: AclSourceDef[] = [slackAclSource, githubAclSource];

// Hard invariant: one ACL entity type for every source (identity namespace differs).
for (const source of ACL_SOURCES) {
  if (source.resourceType.slug !== ACL_RESOURCE_TYPE_SLUG) {
    throw new Error(
      `ACL source '${source.key}' must use resource type '${ACL_RESOURCE_TYPE_SLUG}', got '${source.resourceType.slug}'`,
    );
  }
}

const ACL_SOURCE_BY_KEY = new Map<string, AclSourceDef>(ACL_SOURCES.map((s) => [s.key, s]));

/**
 * The ACL source descriptor for a connector key, or null when that connector
 * contributes no access-controlled resource type. Lets a caller read a
 * connector's `resourceType` (namespace + slug) without naming the connector.
 */
export function aclSourceFor(key: string): AclSourceDef | null {
  return ACL_SOURCE_BY_KEY.get(key) ?? null;
}

/**
 * Resource entity-type slugs the read gate treats as access-controlled.
 * Always `$resource` only — kept as an array so the SQL `IN (...)` compiler
 * stays generic if a second system type is ever needed.
 */
export const RESOURCE_TYPE_SLUGS: readonly string[] = [ACL_RESOURCE_TYPE_SLUG];

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
