/**
 * Connector-owned "which workspace does this binding belong to" resolver.
 *
 * `agent_channel_bindings.team_id` is a HARD invariant: it ALWAYS names the
 * concrete workspace/tenant a channel lives in, never a broader install
 * identity (for Slack Grid: the workspace `T…`, NEVER the enterprise `E…`).
 * The generic binding-write path (`channel-bindings` handlers,
 * `slack-claim-onboarding`) must not know how any one connector computes that —
 * it just calls {@link resolveBindingTeam}. Each connector owns its own rule.
 *
 * Why a server-side module list and NOT `ConnectorIdentityModule`: identity
 * modules are a pure, synchronous namespace-normalizer (no I/O). Resolving a
 * Slack binding's workspace on a Grid org-wide install needs a
 * `conversations.info` round-trip (the install identity is the enterprise id —
 * only the channel's `context_team_id` reveals its workspace), so the Slack
 * resolver lives in the Slack server module where the Slack Web API + secret
 * store are reachable. Core/generic code never names a connector; dispatch is by
 * `connectorKey` against a static module list (mirrors
 * `CONNECTOR_IDENTITY_MODULES`).
 *
 * Contract: a resolver returns the concrete workspace team id, or `null` when it
 * cannot be determined YET (e.g. a private channel the bot isn't in). `null`
 * means "unknown" — the row is written with a NULL team and heals from the first
 * inbound event (which carries the real workspace id). A resolver MUST NEVER
 * return a broader install identity (an `E…`) as if it were the workspace.
 */

import { slackBindingScopeModule } from "../connections/slack-binding-scope.js";

/** What a resolver needs about the connection backing a binding. */
export interface BindingConnection {
  connectorKey: string;
  /** The connection's stored tenant identity. For most connectors this IS the
   *  workspace; for a Slack Grid org-wide install it is the enterprise `E…`,
   *  which the Slack resolver deliberately refuses to treat as a workspace. */
  externalTenantId: string | null;
  /** Numeric `connections.id` — lets a resolver load the bot credential. */
  connectionId: number;
  organizationId: string;
}

export interface BindingScopeResolveParams {
  connection: BindingConnection;
  /** Bound channel id (may be platform-prefixed `slack:C…` or bare). */
  channelId: string;
  /** A trusted workspace hint carried by the write's origin (e.g. a slash
   *  command / deep-link `team_id`), when the caller has one. Preferred over any
   *  live lookup — it's the real workspace, already verified by the platform. */
  workspaceHint?: string | null;
}

/** Resolve the concrete workspace team a binding belongs to, or null if unknown
 *  yet (heal-from-inbound). */
export type BindingScopeResolver = (
  params: BindingScopeResolveParams,
) => Promise<string | null>;

/** A connector's self-description for binding-scope resolution. */
export interface BindingScopeModule {
  /** Connector/platform key (`slack`, …). */
  key: string;
  resolve: BindingScopeResolver;
}

/**
 * The connector modules that own a binding-scope rule — the ONE place this
 * generic module enumerates connectors (mirrors `CONNECTOR_IDENTITY_MODULES`).
 * Only connectors whose tenant identity differs from their workspace need one;
 * every other connector uses the default (stored tenant id) below.
 */
const BINDING_SCOPE_MODULES: readonly BindingScopeModule[] = [
  slackBindingScopeModule,
];

/** Test-only per-connector resolver overrides (the Slack module wires the real
 *  Slack Web API + secret store, which tests replace with stubs). */
const testOverrides = new Map<string, BindingScopeResolver>();

/** Test seam: override the resolver for one connector key. Pass `undefined` to
 *  clear. Tests MUST clear in a `finally`/`afterEach` to avoid leaking. */
export function __setBindingScopeResolverForTests(
  connectorKey: string,
  resolve: BindingScopeResolver | undefined,
): void {
  if (resolve) testOverrides.set(connectorKey, resolve);
  else testOverrides.delete(connectorKey);
}

/**
 * Resolve the workspace team id to stamp on a new/updated binding. Dispatches to
 * the connector's module; falls back to the connection's stored tenant id for
 * connectors whose tenant identity IS the workspace (the common case — no
 * special handling needed). Returns null only when the connector's resolver says
 * the workspace is unknown yet.
 */
export async function resolveBindingTeam(
  params: BindingScopeResolveParams,
): Promise<string | null> {
  const key = params.connection.connectorKey;
  const override = testOverrides.get(key);
  if (override) return override(params);
  const mod = BINDING_SCOPE_MODULES.find((m) => m.key === key);
  if (mod) return mod.resolve(params);
  // Default: the connection's tenant id is the workspace (Telegram chat, a
  // single-workspace connector, …). A trusted hint still wins when present.
  return params.workspaceHint ?? params.connection.externalTenantId ?? null;
}
