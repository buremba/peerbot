/**
 * Interaction-envelope wire literals for durable approval cards
 * (`tool_approval` transport via POST /internal/interactions/create).
 *
 * Why this exists: resourceKind / attribution were scattered string literals
 * across plugin-mcp, server tools, gateway routes, and the SPA. A rename on
 * one side (e.g. watcher → behavior) silently broke card routing on another
 * (plugin-mcp kept emitting "watcher" while owletto routed on "behavior").
 *
 * Single source:
 *  - Emitters import the const objects below (no bare string literals).
 *  - TypeBox schemas derive Static<> types for compile-time checking.
 *  - A parity test asserts SPA-side accepted literals match these unions.
 *
 * Config-audit `resourceKind` (deployments feed: connection, feed, …) is a
 * separate vocabulary (`ConfigResourceKind` on the server) — do not mix it
 * into this envelope.
 */

import { type Static, Type } from "@sinclair/typebox";

// ── resourceKind (approval card / interaction payload) ──────────────────────

/**
 * Canonical resourceKind values on the tool_approval interaction envelope.
 * Produced by plugin-mcp (card post) and manage_behaviors (event metadata);
 * consumed by the SPA to pick the right approval card renderer.
 */
export const INTERACTION_RESOURCE_KINDS = [
  "agent",
  "behavior",
  "entity",
] as const;

export type InteractionResourceKind =
  (typeof INTERACTION_RESOURCE_KINDS)[number];

export const InteractionResourceKindSchema = Type.Union(
  INTERACTION_RESOURCE_KINDS.map((k) => Type.Literal(k))
);

/**
 * Named constants for emitters. Prefer these over bare string literals so a
 * typo is a type error and grep finds every producer via the import.
 */
export const InteractionResourceKind = {
  Agent: "agent",
  Behavior: "behavior",
  Entity: "entity",
} as const satisfies Record<string, InteractionResourceKind>;

// ── attribution (who proposed a gated entity-field change) ──────────────────

/**
 * Who proposed a human-owned field change (entity_field_change cards).
 * manage_entity emits this as approval_attribution; plugin-mcp forwards it as
 * `attribution` on the interaction envelope; the SPA labels "An agent" vs
 * "A Behavior".
 */
export const APPROVAL_ATTRIBUTIONS = ["agent", "behavior"] as const;

export type ApprovalAttribution = (typeof APPROVAL_ATTRIBUTIONS)[number];

export const ApprovalAttributionSchema = Type.Union(
  APPROVAL_ATTRIBUTIONS.map((a) => Type.Literal(a))
);

export const ApprovalAttribution = {
  Agent: "agent",
  Behavior: "behavior",
} as const satisfies Record<string, ApprovalAttribution>;

/**
 * Coerce a wire value to ApprovalAttribution. Unknown / missing → agent
 * (matches the historical plugin-mcp default when attribution was absent).
 */
export function coerceApprovalAttribution(value: unknown): ApprovalAttribution {
  return value === ApprovalAttribution.Behavior
    ? ApprovalAttribution.Behavior
    : ApprovalAttribution.Agent;
}

// ── tool_approval create body (worker → gateway) ────────────────────────────

/**
 * Body shape posted to POST /internal/interactions/create when
 * interactionType === "tool_approval". Field optionality mirrors today's
 * emitters (manage_agents omits fields/attribution; manage_entity may omit
 * proposal). This is the shared type surface — runtime validation is still
 * permissive at the route (legacy/malformed cards must not 500).
 */
export const ToolApprovalCreateBodySchema = Type.Object({
  interactionType: Type.Literal("tool_approval"),
  runId: Type.Number(),
  action: Type.String(),
  resourceKind: InteractionResourceKindSchema,
  proposal: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  current: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  fields: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  attribution: Type.Optional(
    Type.Union([ApprovalAttributionSchema, Type.Null()])
  ),
});
export type ToolApprovalCreateBody = Static<
  typeof ToolApprovalCreateBodySchema
>;
