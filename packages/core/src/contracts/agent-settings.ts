/**
 * AgentSettings TypeBox contract family — the single source for the agent
 * settings shape across every surface (declarative, CLI apply, admin tools,
 * REST/MCP, Owletto UI, persistence, worker wire).
 *
 * Why this exists: `AgentSettings` was a hand-written `interface` duplicated
 * across `core/agent-store.ts` and `owletto/lib/api/agents.ts`, which drifted
 * in opposite directions (core had `mcpInstallNotified`; owletto had
 * `mcpServers`; `models` optional vs required). A TypeBox schema is
 * runtime-validatable AND derives the TS type via `Static<typeof>`, so every
 * surface imports one definition — drift becomes a compile error, not a
 * shipped-three-quarters-complete feature.
 *
 * Split (per reviewer Q1):
 *  - `AgentSettingsStoredSchema` — what the DB persists. EXCLUDES
 *    `authProfiles` (Postgres stores it in a separate table; the GET route
 *    merges it dynamically — `agent-routes.ts:1315,1686`). Includes
 *    `updatedAt` (set by the DB on every write).
 *  - `AgentSettings` (the runtime type) = `Static<Stored> & { authProfiles? }`
 *    — a superset of stored, matching the existing interface every consumer
 *    already uses, so this is a drop-in replacement.
 *
 * `Patch` (PATCH body, null=clear vs undefined=unchanged) and `Response`
 * (sanitized GET, redacted secrets + merged authProfiles) are follow-on
 * schemas built on top of Stored; they belong with the route that owns them.
 */
import { type Static, Type } from "@sinclair/typebox";

// ── Nested schemas ──────────────────────────────────────────────────────────

export const NetworkConfigSchema = Type.Object({
  allowedDomains: Type.Optional(Type.Array(Type.String())),
  deniedDomains: Type.Optional(Type.Array(Type.String())),
});
export type NetworkConfig = Static<typeof NetworkConfigSchema>;

export const NixConfigSchema = Type.Object({
  flakeUrl: Type.Optional(Type.String()),
  packages: Type.Optional(Type.Array(Type.String())),
});
export type NixConfig = Static<typeof NixConfigSchema>;

export const ToolsConfigSchema = Type.Object({
  allowedTools: Type.Optional(Type.Array(Type.String())),
  deniedTools: Type.Optional(Type.Array(Type.String())),
  strictMode: Type.Optional(Type.Boolean()),
  mcpExposure: Type.Optional(
    Type.Union([Type.Literal("tools"), Type.Literal("cli")])
  ),
});
export type ToolsConfig = Static<typeof ToolsConfigSchema>;

export const GuardrailStageSchema = Type.Union([
  Type.Literal("input"),
  Type.Literal("output"),
  Type.Literal("pre-tool"),
  Type.Literal("egress"),
]);

export const AgentInlineGuardrailSchema = Type.Object({
  name: Type.String(),
  enabled: Type.Boolean(),
  stage: GuardrailStageSchema,
  policy: Type.String(),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  domains: Type.Optional(Type.Array(Type.String())),
});
export type AgentInlineGuardrail = Static<typeof AgentInlineGuardrailSchema>;

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const SkillPreToolGuardrailSchema = Type.Union([
  Type.Object({ kind: Type.Literal("builtin"), name: Type.String() }),
  Type.Object({
    kind: Type.Literal("judge"),
    policy: Type.String(),
    tools: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.String()),
  }),
]);
export type SkillPreToolGuardrail = Static<typeof SkillPreToolGuardrailSchema>;

export const SkillConfigSchema = Type.Object({
  repo: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  enabled: Type.Boolean(),
  system: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.String()),
  contentFetchedAt: Type.Optional(Type.Number()),
  nixPackages: Type.Optional(Type.Array(Type.String())),
  providers: Type.Optional(Type.Array(Type.String())),
  modelPreference: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  guardrails: Type.Optional(
    Type.Object({
      "pre-tool": Type.Optional(Type.Array(SkillPreToolGuardrailSchema)),
    })
  ),
});
export type SkillConfig = Static<typeof SkillConfigSchema>;

export const SkillsConfigSchema = Type.Object({
  skills: Type.Array(SkillConfigSchema),
});
export type SkillsConfig = Static<typeof SkillsConfigSchema>;

const PluginSlotSchema = Type.Union([
  Type.Literal("tool"),
  Type.Literal("provider"),
  Type.Literal("memory"),
]);

const PluginConfigSchema = Type.Object({
  source: Type.String(),
  slot: PluginSlotSchema,
  enabled: Type.Optional(Type.Boolean()),
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type PluginConfig = Static<typeof PluginConfigSchema>;

export const PluginsConfigSchema = Type.Object({
  plugins: Type.Array(PluginConfigSchema),
});
export type PluginsConfig = Static<typeof PluginsConfigSchema>;

// ── AgentSettingsStored ─────────────────────────────────────────────────────

/**
 * What the DB persists (the `agents` row's settings jsonb columns). EXCLUDES
 * `authProfiles` — that's stored in a separate table and merged on GET.
 * `updatedAt` is included (set by the DB on every write, returned on read).
 *
 * Mirrors the field set of the legacy `AgentSettings` interface in
 * `agent-store.ts` exactly, so `AgentSettings = Static<Stored> & { authProfiles? }`
 * is a structural drop-in. The dead `mcpInstallNotified` field is NOT carried
 * over (removed in `fix/delete-mcp-install-notified`).
 */
export const AgentSettingsStoredSchema = Type.Object({
  models: Type.Optional(Type.Array(Type.String())),
  networkConfig: Type.Optional(NetworkConfigSchema),
  nixConfig: Type.Optional(NixConfigSchema),
  soulMd: Type.Optional(Type.String()),
  userMd: Type.Optional(Type.String()),
  identityMd: Type.Optional(Type.String()),
  skillsConfig: Type.Optional(SkillsConfigSchema),
  toolsConfig: Type.Optional(ToolsConfigSchema),
  guardrails: Type.Optional(Type.Array(Type.String())),
  guardrailsInline: Type.Optional(Type.Array(AgentInlineGuardrailSchema)),
  environmentId: Type.Optional(Type.String()),
  pluginsConfig: Type.Optional(PluginsConfigSchema),
  verboseLogging: Type.Optional(Type.Boolean()),
  showToolCalls: Type.Optional(Type.Boolean()),
  preApprovedTools: Type.Optional(Type.Array(Type.String())),
  updatedAt: Type.Number(),
});
export type AgentSettingsStored = Static<typeof AgentSettingsStoredSchema>;
