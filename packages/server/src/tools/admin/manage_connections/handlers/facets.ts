/**
 * Connection facet derivation — the ONE place a connection's roles are computed.
 *
 * A connection is a single `connections` row, but it can play several roles at
 * once depending on what the connector + config enable. These "facets" are
 * DERIVED (never stored), so they stay correct as feeds/operations/membership
 * change. Keeping the derivation in one helper (shared by list / get /
 * connector-groups) means the chips on the index, the connection page, and the
 * group cards can never drift apart.
 *
 *   - data     — ingests external data into memory (feeds → events)
 *   - chat     — the agent converses through it (a live bot adapter; the
 *                Stage-2a `credential_mode` marker is set)
 *   - actions  — exposes operations the agent can invoke (MCP tools / writes)
 *   - audience — read access is gated by the source's own membership (ACL)
 */

import { ACL_SOURCES } from '../../../../authz/sources';

/** Connector keys whose data is access-controlled by source membership. */
const AUDIENCE_CONNECTOR_KEYS = new Set(ACL_SOURCES.map((s) => s.key));

export interface ConnectionFacets {
  data: boolean;
  chat: boolean;
  actions: boolean;
  audience: boolean;
}

export function deriveConnectionFacets(input: {
  connectorKey: string;
  /** A live bot adapter (the Stage-2a `credential_mode` marker is set). For a
   *  connector group, true when ANY member connection is a chat connection. */
  isChat: boolean;
  /** Number of live feeds bound to this connection (or group). */
  feedCount: number;
  /** Whether the connector declares a non-empty `feeds_schema` (data-capable). */
  connectorHasFeeds: boolean;
  /** Whether the connector exposes any invocable operations. */
  hasOperations: boolean;
}): ConnectionFacets {
  return {
    data: input.feedCount > 0 || input.connectorHasFeeds,
    chat: input.isChat,
    actions: input.hasOperations,
    audience: AUDIENCE_CONNECTOR_KEYS.has(input.connectorKey),
  };
}

/**
 * The credential-mode badge: managed (Lobu-hosted OAuth install) vs byo (you
 * supplied the credentials). Chat connections carry it explicitly in
 * `credential_mode`; for data connectors we infer it from the auth profile —
 * an OAuth app install (`app_auth_profile_id`) is managed, any other configured
 * auth is byo, and a connection with no auth concept returns null.
 */
export function deriveEffectiveCredentialMode(input: {
  credentialMode: string | null | undefined;
  appAuthProfileId: unknown;
  authProfileId: unknown;
}): 'managed' | 'byo' | null {
  if (input.credentialMode === 'managed' || input.credentialMode === 'byo') {
    return input.credentialMode;
  }
  if (input.appAuthProfileId != null) return 'managed';
  if (input.authProfileId != null) return 'byo';
  return null;
}
