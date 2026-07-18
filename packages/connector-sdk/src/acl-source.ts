/**
 * ACL-source contract — the shared shape between a connector and the generic
 * access-graph engine.
 *
 * A connector that gates read access on membership (Slack channels, GitHub
 * repos, …) reduces to: RESOURCES × AUDIENCE of MEMBERS. The connector owns
 * normalization into that shape; the server materializes entities, identities,
 * and `member_of` edges. Core never names a connector.
 *
 * All ACL resources are entity type `$resource`. Sources differ only by
 * resource identity namespace and member identity namespaces.
 */

/**
 * Sole platform entity-type slug for ACL-gated units.
 * `$` prefix → system (hide rail, never prune, user-create blocked).
 */
export const ACL_RESOURCE_TYPE_SLUG = '$resource' as const;

/** Columns used when ensuring the platform `$resource` entity type. */
export const ACL_RESOURCE_TYPE = {
  slug: ACL_RESOURCE_TYPE_SLUG,
  name: 'Resource',
  description:
    'ACL-gated access unit (Slack channel, GitHub repository, …). Graph anchor only — empty metadata schema.',
  icon: 'shield',
} as const;

/**
 * A claim that identifies a member, e.g. `{namespace:'slack_user_id', primary:true}`.
 * The engine collapses a member onto any existing entity carrying ANY of their
 * identities; `primary` ones additionally govern creation.
 */
export interface AccessIdentitySpec {
  namespace: string;
  primary?: boolean;
}

/** One member of a resource's audience. */
export interface AccessMember {
  /** Stable dedupe key (e.g. `T…:U…` for Slack, numeric id for GitHub). */
  key: string;
  /** Display name for an auto-created `person`. Falls back to `key`. */
  name?: string;
  /** This member's identity claims (namespaces in `memberIdentities`). */
  identities: { namespace: string; value: string }[];
}

/** One resource (channel/repo/…) and the members who may read it. */
export interface AccessResource {
  /**
   * Stored under the source's `resourceNamespace`
   * (`T…:C…` for Slack, `owner/repo` for GitHub).
   */
  key: string;
  name?: string;
  members: AccessMember[];
}

/**
 * A connector's ACL-source descriptor — the ONE thing a connector declares to
 * become access-controlled. All resources materialize as `$resource`; only the
 * identity namespaces are source-specific.
 */
export interface AclSourceDef {
  /** Connector/platform key (`slack`, `github`, …). */
  key: string;
  /**
   * Identity namespace for resource keys (e.g. `slack_channel_id`,
   * `github_repo_full_name`).
   */
  resourceNamespace: string;
  /** How a member of a resource is identified. */
  memberIdentities: AccessIdentitySpec[];
}

/**
 * A chat platform's READ-gate identity model — how the per-channel visibility
 * gate keys a channel and a requester for THIS platform. Unlike `AclSourceDef`
 * (pure data, persisted, replayed generically) this carries key-BUILDER
 * functions, so it is used only in-process at the server's authz edge.
 *
 * A binding stores a bare channel id (`C…`) + a tenant/team id; the gate must
 * reconstruct the exact team-scoped key the ACL sync wrote (`T…:C…`) to match
 * the graphed `$resource` entity.
 */
export interface ChannelReadIdentity {
  /** Platform key (`slack`, …) — matched against a binding's `platform`. */
  platform: string;
  /** Identity namespace a channel resource entity is stored under. */
  channelNamespace: string;
  /** Identity namespace a requester (channel member) is stored under. */
  userNamespace: string;
  /**
   * Build the team-scoped channel key (`T…:C…`) from a tenant/team id and a
   * BARE channel id. Returns null when the inputs can't form a valid key.
   */
  buildChannelKey(teamId: string | null | undefined, bareChannelId: string): string | null;
  /**
   * Build the team-scoped requester key (`T…:U…`) from a tenant/team id and a
   * bare user id. Returns null when the inputs can't form a valid key.
   */
  buildUserKey(teamId: string | null | undefined, userId: string | null | undefined): string | null;
  /**
   * The same channel-key construction as a SQL expression, given safe SQL
   * column expressions for team id and bare channel id.
   */
  channelKeySql(teamColExpr: string, channelColExpr: string): string;
}
