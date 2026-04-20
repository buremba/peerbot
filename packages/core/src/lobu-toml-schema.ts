/**
 * Canonical zod schema for `lobu.toml`.
 *
 * This is the single source of truth for both the CLI (validation on disk)
 * and the gateway (runtime loading). Uses zod@4.
 */

import { z } from "zod";
import { normalizeDomainPatterns } from "./utils/network-domains";

// ── Provider ────────────────────────────────────────────────────────────────

const providerSchema = z
  .object({
    id: z.string(),
    model: z.string().optional(),
    /** API key — literal value or `$ENV_VAR` reference. */
    key: z.string().optional(),
    /** First-class durable secret reference. */
    secret_ref: z.string().optional(),
  })
  .refine((p) => !(p.key && p.secret_ref), {
    message: "provider must set at most one of `key` or `secret_ref`",
  });

// ── Connection ──────────────────────────────────────────────────────────────

const connectionSchema = z.object({
  type: z.string(),
  /**
   * Optional disambiguator when an agent has multiple connections of the same
   * type (e.g. two Slack workspaces). Slugged and appended to the stable
   * connection ID: `{agent}-{type}-{name}`. Omit for single-connection setups.
   */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: "connection name must be lowercase alphanumeric with hyphens",
    })
    .optional(),
  /** Platform-specific config (e.g. `{ botToken: "$BOT_TOKEN" }`). */
  config: z.record(z.string(), z.string()),
});

// ── MCP Server ──────────────────────────────────────────────────────────────

const mcpOAuthSchema = z.object({
  auth_url: z.string(),
  token_url: z.string(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const mcpServerSchema = z.object({
  /**
   * Transport kind. `streamable-http` (default for HTTP URLs) posts to a single
   * endpoint and accepts either JSON or SSE-framed responses per the MCP spec.
   * `sse` is the legacy transport with a separate /sse GET channel. `stdio`
   * runs a local command.
   */
  type: z.enum(["streamable-http", "sse", "stdio"]).optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: mcpOAuthSchema.optional(),
  /**
   * Credential scope for OAuth-authenticated MCPs.
   * - `"user"` (default): each chat user logs in separately. Safe default.
   * - `"channel"`: a single credential is shared across all users in a chat
   *   channel/conversation. Use only for shared-data integrations (e.g. team
   *   wikis) where per-user attribution isn't required.
   */
  auth_scope: z.enum(["user", "channel"]).optional(),
});

// ── Skills ──────────────────────────────────────────────────────────────────

const skillsSchema = z.object({
  mcp: z.record(z.string(), mcpServerSchema).optional(),
});

// ── Network ─────────────────────────────────────────────────────────────────

const networkSchema = z
  .object({
    allowed: z.array(z.string()).optional(),
    denied: z.array(z.string()).optional(),
  })
  .transform((network) => ({
    allowed: normalizeDomainPatterns(network.allowed),
    denied: normalizeDomainPatterns(network.denied),
  }));

// ── Tools ───────────────────────────────────────────────────────────────────

/**
 * Accepted `pre_approved` entry formats:
 *   /mcp/<id>/tools/<name>
 *   /mcp/<id>/tools/*
 * Anything else will fail validation — typos like "gmail" silently produced
 * a no-op grant previously.
 */
const MCP_TOOL_PATTERN = /^\/mcp\/[a-zA-Z0-9_-]+\/tools\/([a-zA-Z0-9_-]+|\*)$/;
const mcpToolPatternSchema = z
  .string()
  .refine((value) => MCP_TOOL_PATTERN.test(value), {
    message:
      'pre_approved entries must match "/mcp/<mcp-id>/tools/<tool-name>" or "/mcp/<mcp-id>/tools/*"',
  });

const toolsSchema = z.object({
  /**
   * Operator override: MCP tool grant patterns that bypass the in-thread
   * approval card. Synced to the grant store at deployment time. See
   * {@link AgentSettings.preApprovedTools} for the runtime shape.
   */
  pre_approved: z.array(mcpToolPatternSchema).optional(),
  /**
   * Worker-side tool visibility filter. Patterns follow Claude Code's
   * permission format: `Read`, `Bash(git:*)`, `mcp__github__*`, `*`.
   */
  allowed: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
  /** If true, ONLY `allowed` tools are permitted (ignores worker defaults). */
  strict: z.boolean().optional(),
});

// ── Worker ──────────────────────────────────────────────────────────────────

const workerSchema = z.object({
  nix_packages: z.array(z.string()).optional(),
});

// ── Schedule ────────────────────────────────────────────────────────────────

/**
 * Per-agent declared schedule. Mirrored into `ScheduleService` at startup
 * and on `reloadFromFiles` under id `toml:<agentId>:<localId>`.
 */
const scheduleSchema = z.object({
  /** Unique within this agent. Becomes part of the global schedule id. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "schedule id must be lowercase alphanumeric with hyphens",
  }),
  /** 5-field POSIX cron expression. Validated for parseability + timezone at upsert. */
  cron: z.string(),
  /** Prompt the agent runs when the schedule fires. */
  task: z.string(),
  /**
   * Where the agent's response lands. Format:
   *   "<platform>:<connectionSlug>:<channelId>[:<threadTs>]"
   * If omitted, falls back to `default_schedule_channel`, then headless.
   */
  deliver_to: z.string().optional(),
  /**
   * Optional approver routing for destructive tool calls in headless mode.
   * Same format as `deliver_to`. When unset and `deliver_to` is set, the
   * delivery channel is used. When both are unset, destructive calls
   * fail-closed.
   */
  approver: z.string().optional(),
  /** IANA timezone (e.g. "America/New_York"); default UTC. */
  timezone: z.string().optional(),
  /** Default true. When false, the schedule loads but does not fire. */
  enabled: z.boolean().default(true),
  /** Concurrency policy if previous run is still executing. Default "queue". */
  concurrency: z.enum(["queue", "skip", "allow"]).default("queue"),
});

// ── Agent ───────────────────────────────────────────────────────────────────

const agentEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Path to agent content directory (IDENTITY.md, SOUL.md, USER.md, skills/). */
  dir: z.string(),
  providers: z.array(providerSchema).default([]),
  connections: z.array(connectionSchema).default([]),
  skills: skillsSchema.default({}),
  network: networkSchema.optional(),
  tools: toolsSchema.optional(),
  worker: workerSchema.optional(),
  /**
   * Default delivery target for scheduled fires that omit `deliver_to`.
   * Same `<platform>:<connectionSlug>:<channelId>[:<threadTs>]` shape.
   */
  default_schedule_channel: z.string().optional(),
  schedules: z.array(scheduleSchema).default([]),
});

// ── Memory ─────────────────────────────────────────────────────────────────

const owlettoMemorySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.string().optional(),
  models: z.string().optional(),
  data: z.string().optional(),
});

const memorySchema = z.object({
  owletto: owlettoMemorySchema.optional(),
});

// ── Owletto CLI ────────────────────────────────────────────────────────────

const owlettoProfileSchema = z
  .object({
    url: z.string().optional(),
    api_url: z.string().optional(),
    mcp_url: z.string().optional(),
    database_url: z.string().optional(),
    embeddings_url: z.string().optional(),
    env_file: z.string().optional(),
  })
  .passthrough();

const owlettoSchema = z.object({
  profiles: z.record(z.string(), owlettoProfileSchema).optional(),
});

// ── Top Level ───────────────────────────────────────────────────────────────

export const lobuConfigSchema = z.object({
  agents: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), agentEntrySchema),
  memory: memorySchema.optional(),
  owletto: owlettoSchema.optional(),
});

// ── Inferred Types ──────────────────────────────────────────────────────────

export type LobuTomlConfig = z.infer<typeof lobuConfigSchema>;
export type AgentEntry = z.infer<typeof agentEntrySchema>;
export type ProviderEntry = z.infer<typeof providerSchema>;
export type ConnectionEntry = z.infer<typeof connectionSchema>;
export type McpServerEntry = z.infer<typeof mcpServerSchema>;
export type SkillsEntry = z.infer<typeof skillsSchema>;
export type NetworkEntry = z.infer<typeof networkSchema>;
export type ToolsEntry = z.infer<typeof toolsSchema>;
export type WorkerEntry = z.infer<typeof workerSchema>;
export type ScheduleEntry = z.infer<typeof scheduleSchema>;
export type OwlettoMemoryEntry = z.infer<typeof owlettoMemorySchema>;
export type MemoryEntry = z.infer<typeof memorySchema>;
export type OwlettoProfileEntry = z.infer<typeof owlettoProfileSchema>;
export type OwlettoEntry = z.infer<typeof owlettoSchema>;
