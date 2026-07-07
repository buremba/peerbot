/**
 * ACL-source contract — the shared shape between a connector and the generic
 * access-graph engine.
 *
 * A connector that gates read access on membership (a Slack workspace's
 * channels, a GitHub org's repos, …) reduces to the same shape: a set of
 * RESOURCES, each with an AUDIENCE of MEMBERS who may read it. The connector
 * owns how its raw API data normalizes into that shape (`AclSourceDef`); the
 * server owns the generic materialization (resolve entities, member_of edges,
 * departure reconcile) driven entirely by these DTOs. Core code never names a
 * specific connector — it iterates `AclSourceDef`s the connectors contribute.
 *
 * These are pure data types (no server/db dependency) so they live in the SDK
 * and can be imported by both a connector package and the server engine.
 */

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
  /** Stable dedupe key for this member across resources (the primary identity
   * value is the natural choice: `T…:U…` for Slack, the numeric id for GitHub). */
  key: string;
  /** Display name for an auto-created `person`. Falls back to `key`. */
  name?: string;
  /** This member's identity claims (namespaces declared in `memberIdentities`). */
  identities: { namespace: string; value: string }[];
}

/** One resource (channel/repo/…) and the members who may read it. */
export interface AccessResource {
  /** Stored as the resource entity's identity under `resourceType.namespace`
   * (`T…:C…` for Slack, `owner/repo` or the numeric id for GitHub). */
  key: string;
  name?: string;
  members: AccessMember[];
}

/** The resource entity type to find-or-create and key resources under. */
export interface AccessResourceType {
  /** Entity-type slug, e.g. `channel` / `repo`. */
  slug: string;
  name: string;
  description: string;
  icon: string;
  /** Identity namespace the resource key is stored/looked-up under. */
  namespace: string;
}

/**
 * A connector's ACL-source descriptor — the ONE thing a connector declares to
 * become access-controlled. Says "this connector produces resources of THIS
 * entity type, keyed on THIS identity namespace, whose members are identified
 * by THESE namespaces." The generic server materializer reads it; no new gate
 * or engine code per connector.
 */
export interface AclSourceDef {
  /** Connector/platform key (`slack`, `github`, …). */
  key: string;
  /** The resource entity type this source's resources materialize as. */
  resourceType: AccessResourceType;
  /** How a member of one of this source's resources is identified. */
  memberIdentities: AccessIdentitySpec[];
}

/**
 * A chat platform's READ-gate identity model — how the per-channel visibility
 * gate keys a channel and a requester for THIS platform. Unlike `AclSourceDef`
 * (pure data, persisted, replayed generically) this carries key-BUILDER
 * functions, so it is used only in-process at the server's authz edge (the read
 * gate runs live and may import connector code). It is what lets the fail-closed
 * channel gate be platform-parametric instead of Slack-hardcoded.
 *
 * A binding stores a bare channel id (`C…`) + a tenant/team id; the gate must
 * reconstruct the exact team-scoped key the ACL sync wrote (`T…:C…`) to match
 * the graphed `channel` entity. `channelKeySql` is the SAME construction as a
 * SQL expression, for the message-visibility compiler that keys inside a query.
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
   * BARE channel id. Returns null when the inputs can't form a valid key (→ the
   * gate drops the channel fail-closed).
   */
  buildChannelKey(teamId: string | null | undefined, bareChannelId: string): string | null;
  /**
   * Build the team-scoped requester key (`T…:U…`) from a tenant/team id and a
   * bare user id. Returns null when the inputs can't form a valid key.
   */
  buildUserKey(teamId: string | null | undefined, userId: string | null | undefined): string | null;
  /**
   * The same channel-key construction as a SQL expression, given the SQL column
   * references (already-safe identifiers, NOT user input) for the team id and
   * the bare channel id. Must produce a value byte-identical to
   * `buildChannelKey` so an in-query match agrees with the TS path.
   */
  channelKeySql(teamColExpr: string, channelColExpr: string): string;
}
