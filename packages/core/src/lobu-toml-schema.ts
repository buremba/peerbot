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

const judgeDomainEntry = z.union([
  z.string(),
  z.object({
    domain: z.string(),
    judge: z.string().optional(),
  }),
]);

const networkSchema = z
  .object({
    allowed: z.array(z.string()).optional(),
    denied: z.array(z.string()).optional(),
    /**
     * Domains routed through the LLM egress judge. Each entry is either
     * a bare domain string (uses the "default" judge policy) or an object
     * `{ domain, judge }` naming a policy in {@link network.judges}.
     */
    judge: z.array(judgeDomainEntry).optional(),
    /**
     * Named judge policies referenced by `judge[].judge`. The key "default"
     * is applied when an entry omits `judge`.
     */
    judges: z.record(z.string(), z.string()).optional(),
  })
  .transform((network) => ({
    allowed: normalizeDomainPatterns(network.allowed),
    denied: normalizeDomainPatterns(network.denied),
    judge: network.judge?.map((entry) =>
      typeof entry === "string"
        ? { domain: entry }
        : {
            domain: entry.domain,
            ...(entry.judge ? { judge: entry.judge } : {}),
          }
    ),
    judges: network.judges,
  }));

// ── Egress ──────────────────────────────────────────────────────────────────

const egressSchema = z.object({
  /** Operator policy appended to every judge prompt for this agent. */
  extra_policy: z.string().optional(),
  /** Judge model identifier (defaults to a fast Haiku model). */
  judge_model: z.string().optional(),
});

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
  egress: egressSchema.optional(),
  tools: toolsSchema.optional(),
  /**
   * Guardrails enabled for this agent. Each name must match a guardrail
   * registered in the gateway's GuardrailRegistry. See packages/core/src/guardrails.
   */
  guardrails: z.array(z.string()).optional(),
  worker: workerSchema.optional(),
});

// ── Memory ─────────────────────────────────────────────────────────────────

const owlettoMemorySchema = z.object({
  enabled: z.boolean().optional(),
  org: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
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
export type EgressEntry = z.infer<typeof egressSchema>;
export type ToolsEntry = z.infer<typeof toolsSchema>;
export type WorkerEntry = z.infer<typeof workerSchema>;
export type OwlettoMemoryEntry = z.infer<typeof owlettoMemorySchema>;
export type MemoryEntry = z.infer<typeof memorySchema>;
export type OwlettoProfileEntry = z.infer<typeof owlettoProfileSchema>;
export type OwlettoEntry = z.infer<typeof owlettoSchema>;
