/**
 * The ACL source registry — the ONE place core code COLLECTS access-controlled
 * sources. Each descriptor is owned by its connector; this file only gathers
 * them so the generic gate and sync loop iterate without naming connectors.
 *
 * All sources materialize as entity type `$resource`. Identity namespaces
 * distinguish Slack channels, GitHub repos, etc.
 */

import type { AclSourceDef, ChannelReadIdentity } from '@lobu/connector-sdk';
import { githubAclSource } from '@lobu/connectors/github-identity';
import { slackAclSource, slackChannelReadIdentity } from '@lobu/connectors/slack-identity';

/** Every registered ACL source (contributed by its connector package). */
export const ACL_SOURCES: AclSourceDef[] = [slackAclSource, githubAclSource];

const ACL_SOURCE_BY_KEY = new Map<string, AclSourceDef>(ACL_SOURCES.map((s) => [s.key, s]));

/**
 * The ACL source descriptor for a connector key, or null when that connector
 * contributes no access-controlled resources.
 */
export function aclSourceFor(key: string): AclSourceDef | null {
  return ACL_SOURCE_BY_KEY.get(key) ?? null;
}

/**
 * Chat platforms whose per-channel read gate is enforced, keyed by `platform`.
 * GitHub is NOT here — its resource gate is repo-based, not chat-channel.
 */
export const CHANNEL_READ_IDENTITIES: ChannelReadIdentity[] = [slackChannelReadIdentity];

const CHANNEL_READ_IDENTITY_BY_PLATFORM = new Map<string, ChannelReadIdentity>(
  CHANNEL_READ_IDENTITIES.map((c) => [c.platform, c]),
);

/**
 * The read-gate identity model for a chat platform, or null when that platform
 * has no enforced channel gate.
 */
export function channelReadIdentityFor(platform: string): ChannelReadIdentity | null {
  return CHANNEL_READ_IDENTITY_BY_PLATFORM.get(platform) ?? null;
}
