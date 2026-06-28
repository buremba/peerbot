/**
 * The ACL source registry — the ONE place a new access-controlled source is
 * declared. Each entry says "this connector produces resources of THIS entity
 * type, keyed on THIS identity namespace, whose members are identified by THESE
 * namespaces." Everything else is generic:
 *   - the graph builders (`./slack-channel-graph`, `./github-repo-graph`) hand
 *     their normalized resources to `buildAccessGraph` with the entry's descriptor;
 *   - the read gate (`./resource-visibility`) gates events by membership of any
 *     resource whose type is in {@link RESOURCE_TYPE_SLUGS};
 *   - (next) the sync tick loops the registry to re-materialize each source.
 *
 * Adding Linear/Jira/Drive = ONE entry here + a connector that stamps the
 * resource identity on its events. No new gate code, no new engine code.
 */

import type { AccessIdentitySpec, AccessResourceType } from './access-graph.js';

export interface AclSourceDef {
  /** Connector/platform key (`slack`, `github`, …). */
  key: string;
  /** The resource entity type this source's resources materialize as. */
  resourceType: AccessResourceType;
  /** How a member of one of this source's resources is identified. */
  memberIdentities: AccessIdentitySpec[];
}

export const SLACK_SOURCE: AclSourceDef = {
  key: 'slack',
  resourceType: {
    slug: 'channel',
    name: 'Channel',
    description: 'A chat channel (Slack channel, etc.) — the unit of conversation access control',
    icon: 'hash',
    namespace: 'slack_channel_id',
  },
  memberIdentities: [{ namespace: 'slack_user_id', primary: true }],
};

export const GITHUB_SOURCE: AclSourceDef = {
  key: 'github',
  resourceType: {
    slug: 'repo',
    name: 'Repository',
    description: 'A code repository — the unit of repo access control',
    icon: 'git-branch',
    namespace: 'github_repo_full_name',
  },
  memberIdentities: [
    { namespace: 'github_user_id', primary: true },
    { namespace: 'github_login' },
  ],
};

/** Every registered ACL source. */
export const ACL_SOURCES: AclSourceDef[] = [SLACK_SOURCE, GITHUB_SOURCE];

/** Resource entity-type slugs that the read gate treats as access-controlled.
 * Validated to simple identifiers so they can be inlined as SQL literals. */
export const RESOURCE_TYPE_SLUGS: string[] = ACL_SOURCES.map((s) => {
  const slug = s.resourceType.slug;
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Invalid ACL resource type slug (must be a simple identifier): ${slug}`);
  }
  return slug;
});
