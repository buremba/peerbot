/**
 * MCP Tool Registry
 *
 * This file defines all MCP tools and imports their Typebox schemas from tool files.
 * Typebox provides compile-time type safety and runtime JSON schema generation.
 *
 * Glossary — "namespace" in tool descriptions below means three different things,
 * none of which is a memory-scope axis:
 *   1. `search_sdk`'s `namespace` param — a ClientSDK module name
 *      (`watchers`, `entities`, `knowledge`, ...).
 *   2. `resolve_path`'s "namespace-based URL path" — the first URL segment
 *      (org slug or entity-type slug).
 *   3. `entity_identities.namespace` (deep in SQL) — the identifier type
 *      (`email`, `phone`, `wa_jid`); see `identity-normalize.ts`.
 *
 * Memory scoping uses `events.metadata.agent_id` (filtered via
 * `search_memory`'s top-level `agent_id` arg) — not any of the above.
 */

import { getPublicReadableActions, getRequiredAccessLevel } from '../auth/tool-access';
import type { Env } from '../index';
import { ADMIN_TOOLS } from './admin';
import { ListMetricsSchema, listMetrics } from './admin/list_metrics';
import { MetricSeriesSchema, metricSeries } from './admin/metric_series';
import { QueryMetricSchema, queryMetric } from './admin/query_metric';
import { QuerySqlSchema, querySql } from './admin/query_sql';
import { ListOrganizationsSchema } from './organizations';
import { ResolvePathSchema, ResolvePathResultSchema, resolvePath } from './resolve_path';
import { SaveContentSchema, saveContent } from './save_content';
import { PublicSearchSchema, SearchSchema, UnifiedSearchResultSchema, search } from './search';
import { QuerySchema, RunSchema, SdkScriptResultSchema, querySdkScript, runSdkScript } from './sdk_run';
import { SdkSearchSchema, SdkSearchResultSchema, sdkSearch } from './sdk_search';

// ============================================
// Tool Definitions
// ============================================

/**
 * MCP Tool Annotations
 * @see https://developers.openai.com/apps-sdk/reference#annotations
 */
export interface ToolAnnotations {
  /** Signal that the tool is read-only. ChatGPT can skip 'Are you sure?' prompts when true. */
  readOnlyHint?: boolean;
  /** Declare that the tool may delete or overwrite user data, requiring explicit approval. */
  destructiveHint?: boolean;
  /** Declare that the tool publishes content or reaches outside the current user's account. */
  openWorldHint?: boolean;
  /** Declare that calling the tool repeatedly with the same arguments has no additional effect. */
  idempotentHint?: boolean;
  /** Short human-readable label shown in tool pickers */
  title?: string;
}

export type TokenType = 'oauth' | 'session' | 'pat' | 'anonymous';

export interface ToolSourceContext {
  platform?: string;
  conversationId?: string;
  channelId?: string;
  teamId?: string;
  connectionId?: string;
  userId?: string;
  source?: string;
}

/**
 * Tool execution context from authentication
 * Passed to all tool handlers for organization scoping
 */
export interface ToolContext {
  /** User's organization ID - REQUIRED for all operations */
  organizationId: string;
  /** User ID from OAuth token, PAT, or session (null for anonymous public reads) */
  userId: string | null;
  /** Caller's role in the organization (null for non-members reading a public workspace). */
  memberRole: string | null;
  /** Durable Lobu/Lobu agent identity bound to this MCP session, when provided. */
  agentId?: string | null;
  /** Verified source conversation for worker-originated tool calls, when any. */
  sourceContext?: ToolSourceContext | null;
  /** `x-lobu-apply-id` when this call belongs to a `lobu apply` run (REST proxy only). */
  applyId?: string | null;
  /** Whether request was authenticated */
  isAuthenticated: boolean;
  /** OAuth client ID that created this request (null for session/anonymous) */
  clientId?: string | null;
  /** OAuth scopes granted to this MCP/tool session, when applicable. */
  scopes?: string[] | null;
  tokenType: TokenType;
  /** True when the MCP URL pinned an org slug (e.g. `/mcp/acme`). */
  scopedToOrg: boolean;
  /**
   * Whether `client.org(other)` is allowed inside the sandbox. Computed at session
   * start as `tokenType === 'oauth' && !scopedToOrg`.
   */
  allowCrossOrg: boolean;
  /**
   * Set by the sandbox when the script's wall-clock budget runs out. Handlers
   * that opt in (today: `query_sql` and `client.query`) race their work
   * against this signal so the awaiting caller unblocks immediately. The
   * underlying postgres connection isn't cancelled — `statement_timeout` is
   * the actual server-side cap.
   */
  abortSignal?: AbortSignal;
  /** Original request URL, used to derive public-facing origin for URL generation */
  requestUrl?: string;
  /** PUBLIC_GATEWAY_URL env var fallback for URL generation when requestUrl is unreliable */
  baseUrl?: string;
}

export interface ToolDefinition<T = any> {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
  /**
   * Narrower schema advertised on `tools/list` when the tool accepts fields
   * that are server-internal (e.g. pre-computed embeddings, identity-bound
   * filters the server populates from auth context). Validation still runs
   * against the full `inputSchema`, so internal callers and tests keep working;
   * only the client-facing listing is narrowed. Falls back to `inputSchema`.
   */
  publicInputSchema?: any; // JSON Schema
  annotations?: ToolAnnotations;
  /**
   * JSON Schema describing the tool's structured result. When present, the
   * `tools/call` response carries matching `structuredContent` alongside the
   * text `content` (MCP spec: declaring `outputSchema` implies the result is
   * structured). TypeBox schemas carry their JSON Schema at runtime, so a tool
   * that derives its result type via `Static<typeof ResultSchema>` can hand the
   * same schema object here — one source of truth, no drift.
   */
  outputSchema?: any; // JSON Schema
  handler: (args: T, env: Env, ctx: ToolContext) => Promise<any>;
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

const WRITE_WITHOUT_CONFIRM: ToolAnnotations = { destructiveHint: false, idempotentHint: false };

/** Tools advertised on MCP `tools/list` and external OpenAPI. */
const AGENT_TOOLS: ToolDefinition[] = [
  // ─── Memory hot path — read ───────────────────────────────────────────────
  {
    name: 'search_memory',
    description:
      'Search saved workspace memory: entities, facts, decisions, preferences, observations, and notes. Use this to answer “what do we know?” Pair writes with `save_memory`; use `search_sdk` / `query_sdk` only when you need SDK capabilities or programmable reads.',
    inputSchema: SearchSchema,
    // Advertise the narrower public schema: query_embedding (server pre-compute
    // optimization) and agent_id (auth-bound) are server-internal, not client
    // affordances. See search.ts → PublicSearchSchema.
    publicInputSchema: PublicSearchSchema,
    outputSchema: UnifiedSearchResultSchema,
    annotations: { ...READ_ONLY, title: 'Search memory' },
    handler: search,
  },
  {
    name: 'save_memory',
    description:
      "Save user-shared facts, preferences, decisions, observations, and notes to workspace memory. Storage is append-only — pass `supersedes_event_id` to replace an existing fact (the old event is hidden from future searches without losing history). Optionally attach to entities via `entity_ids`. Always search first to avoid duplicates.",
    inputSchema: SaveContentSchema,
    annotations: { ...WRITE_WITHOUT_CONFIRM, title: 'Save memory' },
    handler: saveContent,
  },
  {
    name: 'search_sdk',
    description:
      "Search ClientSDK documentation and method metadata. Results are filtered to what you can call: pass mode='read' for query_sdk-safe methods, or omit mode for your full run_sdk tier (write/admin methods appear only when your role and scopes allow). Does not query workspace data — pair with `query_sdk` or `run_sdk` to execute. For flat SQL with pagination/feeds use `query_sql`; for governed metrics use client.metrics.* via query_sdk.",
    inputSchema: SdkSearchSchema,
    outputSchema: SdkSearchResultSchema,
    annotations: { ...READ_ONLY, title: 'Search SDK docs' },
    handler: sdkSearch,
  },
  // ─── Power tools — TS scripting + raw SQL ─────────────────────────────────
  {
    name: 'query_sdk',
    description:
      'Run read-only TypeScript in a sandboxed isolate over the ClientSDK. Use this to fetch workspace data through typed SDK methods. The script signature is `export default async (ctx, client) => ...`. Mutating methods are absent from `client` — attempts surface as undefined methods; use `run_sdk` for writes. Output capped at 1 MB. Use `search_sdk` to find method names. Example: `export default async (_ctx, client) => client.entities.list({ entity_type: "company" });`',
    inputSchema: QuerySchema,
    outputSchema: SdkScriptResultSchema,
    annotations: { ...READ_ONLY, title: 'Query SDK (read-only)' },
    handler: querySdkScript,
  },
  {
    name: 'query_sql',
    description:
      'Run a paginated, sortable, searchable read-only SQL query (member-safe). Table references auto-scope to the bound org. SELECT FROM events reads persisted/synced content only; virtual feeds are live-only and must be read explicitly with feed or via query_sdk client.feeds.readMany. Results may include coverage.suggested_virtual_feeds. Prefer client.metrics.query for declared measures; use client.query in query_sdk for simple one-shot SQL. Do NOT use positional parameters ($1, $2, …). Optional `org_slug` (OAuth on /mcp only) redirects to another member org.',
    inputSchema: QuerySqlSchema,
    annotations: { ...READ_ONLY, title: 'Query SQL' },
    handler: querySql,
  },
  {
    name: 'run_sdk',
    description:
      'Destructive — confirm before running. Runs TypeScript in a sandboxed isolate over the FULL ClientSDK. Use this for SDK writes or multi-step workflows. Signature: `export default async (ctx, client) => ...`. Can mutate entities, watchers, memory, classifiers, connections, etc. Use `query_sdk` for reads. Pass `dry_run: true` to execute reads while skipping write/external SDK calls and returning `side_effect_preview`. Output capped at 1 MB. Example: `export default async (_ctx, client) => client.entities.create({ type: "company", name: "Acme" });`',
    inputSchema: RunSchema,
    outputSchema: SdkScriptResultSchema,
    annotations: { destructiveHint: true, idempotentHint: false, title: 'Run SDK' },
    handler: runSdkScript,
  },
];

/**
 * Admin + first-party REST dispatch tools. Callable via `POST /api/:org/:toolName`
 * and MCP `tools/call` by name, but omitted from MCP `tools/list` — agents use
 * `search_sdk` → `query_sdk` / `run_sdk` instead.
 */
const INTERNAL_DISPATCH_TOOLS: ToolDefinition[] = [
  ...ADMIN_TOOLS,
  {
    name: 'list_organizations',
    description:
      'List organizations the authenticated user belongs to, plus any public workspaces the session can read. SDK alternative: client.organizations.list via `query_sdk` / `run_sdk`.',
    inputSchema: ListOrganizationsSchema,
    annotations: { ...READ_ONLY, title: 'List organizations' },
    handler: async () => {
      throw new Error('Handled directly in executeTool');
    },
  },
  {
    name: 'list_metrics',
    description:
      'List declared governed metrics per entity type. SDK alternative: client.metrics.list.',
    inputSchema: ListMetricsSchema,
    annotations: { ...READ_ONLY, title: 'List metrics' },
    handler: listMetrics,
  },
  {
    name: 'query_metric',
    description:
      'Run a declared metric. SDK alternative: client.metrics.query.',
    inputSchema: QueryMetricSchema,
    annotations: { ...READ_ONLY, title: 'Query metric' },
    handler: queryMetric,
  },
  {
    name: 'metric_series',
    description:
      'Read-only time-series SQL for dashboard sparklines. SDK alternative: client.metrics.series.',
    inputSchema: MetricSeriesSchema,
    annotations: { ...READ_ONLY, title: 'Metric series' },
    handler: metricSeries,
  },
  {
    name: 'resolve_path',
    description:
      'Resolve a namespace-based URL path like /acme/entity-type/entity-slug into namespace and entity details. Returns template_data with executed data source query results when templates define data_sources.',
    inputSchema: ResolvePathSchema,
    outputSchema: ResolvePathResultSchema,
    annotations: { ...READ_ONLY, title: 'Resolve path' },
    handler: resolvePath,
  },
];

const ALL_DISPATCH_TOOLS: ToolDefinition[] = [
  ...AGENT_TOOLS,
  ...INTERNAL_DISPATCH_TOOLS,
];

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  AGENT_TOOLS.map((tool) => tool.name),
);

const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  INTERNAL_DISPATCH_TOOLS.map((tool) => tool.name),
);

// ============================================
// Helper Functions
// ============================================

const DISPATCH_BY_NAME: Map<string, ToolDefinition> = new Map(
  ALL_DISPATCH_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Get tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return DISPATCH_BY_NAME.get(name);
}

export function isInternalDispatchTool(name: string): boolean {
  return INTERNAL_TOOL_NAMES.has(name);
}

/**
 * Flatten a TypeBox Union (anyOf) schema into a single object schema.
 * Each variant must be an object with an `action` literal discriminator.
 * Result: single object with `action` as a string enum (description
 * generated from the variants — see `buildActionEnumDescription`), all
 * other properties merged (first occurrence wins; only `action` is
 * required on the wire, per-action required fields surface in prose).
 */
function flattenUnionSchema(schema: any): any {
  const variants: any[] = schema.anyOf || schema.oneOf;
  const actionValues: string[] = [];
  const actionDescriptions = new Map<string, string>();
  const actionRequired = new Map<string, string[]>();
  const mergedProperties: Record<string, any> = {};

  for (const variant of variants) {
    if (variant.type !== 'object' || !variant.properties) continue;
    const actionProp = variant.properties.action;
    const actionName = actionProp?.const;
    if (typeof actionName !== 'string') continue;
    actionValues.push(actionName);
    if (typeof actionProp?.description === 'string') {
      actionDescriptions.set(actionName, actionProp.description);
    }
    // Variant's `required` array carries non-Optional prop names — the
    // basis for the per-action "Required: ..." line in the enum description.
    const requiredFields = (variant.required ?? [])
      .filter((k: string) => k !== 'action');
    if (requiredFields.length > 0) {
      actionRequired.set(actionName, requiredFields);
    }
    for (const [key, prop] of Object.entries<any>(variant.properties)) {
      if (key === 'action') continue;
      // First occurrence wins (keeps description from the first variant that defines it)
      if (!mergedProperties[key]) {
        mergedProperties[key] = prop;
      }
    }
  }

  return {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: actionValues,
        description: buildActionEnumDescription(
          actionValues,
          actionDescriptions,
          actionRequired,
        ),
      },
      ...mergedProperties,
    },
    required: ['action'],
  };
}

/**
 * Build a multi-line description for the flattened `action` enum. Each line
 * names one action and its purpose, followed by its required fields when the
 * variant declared any (beyond `action`). The purpose text is sourced from
 * each variant's `action: Type.Literal(name, { description })` — colocated
 * with the handler, so it can't drift from the schema. Falls back to a bare
 * `- name` line when no description is declared for an action.
 */
function buildActionEnumDescription(
  actionValues: string[],
  actionDescriptions: Map<string, string>,
  actionRequired: Map<string, string[]>,
): string {
  const lines: string[] = ['Action to perform.'];
  for (const name of actionValues) {
    const purpose = actionDescriptions.get(name);
    const head = purpose ? `- ${name}: ${purpose}` : `- ${name}`;
    const required = actionRequired.get(name);
    lines.push(required && required.length > 0 ? `${head} Required: ${required.join(', ')}.` : head);
  }
  return lines.join('\n');
}

/**
 * Ensure an outputSchema is advertised as an OBJECT schema, as the MCP spec
 * requires. TypeBox serializes `Type.Union([Type.Object(...), ...])` to a bare
 * `{ anyOf: [...] }` with no top-level `type`; a validating host rejects that
 * (or the paired structuredContent). Unlike inputSchema we do NOT flatten the
 * union into a single merged object — the discriminated variants are the
 * correct description of a result — we only add the missing `type: "object"`.
 * A schema that is already an object (or otherwise typed) is returned as-is.
 */
function normalizeOutputSchema(schema: any): any {
  if (schema && (schema.anyOf || schema.oneOf) && schema.type === undefined) {
    return { type: 'object' as const, ...schema };
  }
  return schema;
}

function filterSchemaForPublicActions(toolName: string, schema: any): any | null {
  const allowedActions = getPublicReadableActions(toolName);
  if (allowedActions === undefined) return null;
  if (allowedActions === null) return schema;

  const variants: any[] = schema?.anyOf || schema?.oneOf;
  if (!Array.isArray(variants)) return schema;

  const filteredVariants = variants.filter((variant) => {
    const actionConst = variant?.properties?.action?.const;
    return typeof actionConst === 'string' && allowedActions.has(actionConst);
  });

  if (filteredVariants.length === 0) return null;
  return {
    ...schema,
    ...(schema.anyOf ? { anyOf: filteredVariants } : {}),
    ...(schema.oneOf ? { oneOf: filteredVariants } : {}),
  };
}

function accessLevelRank(level: 'read' | 'write' | 'admin'): number {
  if (level === 'read') return 1;
  if (level === 'write') return 2;
  return 3;
}

function filterSchemaForAccessLevel(
  toolName: string,
  schema: any,
  readOnlyHint: boolean,
  maxAccessLevel: 'read' | 'write' | 'admin'
): any | null {
  const toolAccess = getRequiredAccessLevel(toolName, {}, readOnlyHint);
  if (accessLevelRank(toolAccess) <= accessLevelRank(maxAccessLevel)) {
    const variants: any[] = schema?.anyOf || schema?.oneOf;
    if (!Array.isArray(variants)) return schema;

    const filteredVariants = variants.filter((variant) => {
      const actionConst = variant?.properties?.action?.const;
      if (typeof actionConst !== 'string') return false;
      return (
        accessLevelRank(getRequiredAccessLevel(toolName, { action: actionConst }, readOnlyHint)) <=
        accessLevelRank(maxAccessLevel)
      );
    });

    if (filteredVariants.length === 0) return null;
    return {
      ...schema,
      ...(schema.anyOf ? { anyOf: filteredVariants } : {}),
      ...(schema.oneOf ? { oneOf: filteredVariants } : {}),
    };
  }

  return null;
}

// Memoize listed tool shapes per (surface × filter tuple).
const listedToolsCache = new Map<string, ReturnType<typeof computeListedTools>>();

type ListedToolOptions = {
  publicOnly?: boolean;
  maxAccessLevel?: 'read' | 'write' | 'admin';
};

/**
 * Agent-facing tools for MCP `tools/list` and external OpenAPI.
 */
export function getMcpTools(options?: ListedToolOptions) {
  return getListedTools(AGENT_TOOLS, options);
}

/**
 * All dispatch tools for REST `GET /api/:org/tools` (admin entries carry
 * `internal: true` for CLI filtering). Execution uses `getTool` across both sets.
 */
export function getAllTools(options?: ListedToolOptions) {
  const listed = getListedTools(ALL_DISPATCH_TOOLS, options);
  return listed.map((tool) =>
    INTERNAL_TOOL_NAMES.has(tool.name) ? { ...tool, internal: true as const } : tool,
  );
}

function getListedTools(
  source: ToolDefinition[],
  options?: ListedToolOptions,
) {
  const publicOnly = options?.publicOnly ?? false;
  const maxAccessLevel = options?.maxAccessLevel ?? 'admin';
  const cacheKey = `${source === AGENT_TOOLS ? 'mcp' : 'all'}:${publicOnly ? 1 : 0}:${maxAccessLevel}`;
  let cached = listedToolsCache.get(cacheKey);
  if (!cached) {
    cached = computeListedTools(source, publicOnly, maxAccessLevel);
    listedToolsCache.set(cacheKey, cached);
  }
  return cached;
}

function computeListedTools(
  source: ToolDefinition[],
  publicOnly: boolean,
  maxAccessLevel: 'read' | 'write' | 'admin'
) {
  return source
    .filter((tool) => !publicOnly || getPublicReadableActions(tool.name) !== undefined)
    .map((tool) => {
      // Advertise the narrower `publicInputSchema` when a tool declares one;
      // validation still runs against the full `inputSchema` so internal
      // server-supplied fields (e.g. embeddings, auth-bound filters) are
      // accepted at the handler boundary but never advertised to clients.
      let inputSchema = tool.publicInputSchema ?? tool.inputSchema;
      const readOnlyHint = tool.annotations?.readOnlyHint === true;

      if (publicOnly) {
        inputSchema = filterSchemaForPublicActions(tool.name, inputSchema);
      }
      if (!inputSchema) return null;

      inputSchema = filterSchemaForAccessLevel(
        tool.name,
        inputSchema,
        readOnlyHint,
        maxAccessLevel
      );
      if (!inputSchema) return null;

      // Claude API rejects anyOf/oneOf/allOf at the top level of input_schema.
      // Flatten discriminated Union schemas into a single object.
      if (inputSchema.anyOf || inputSchema.oneOf) {
        inputSchema = flattenUnionSchema(inputSchema);
      } else if (inputSchema.type !== 'object') {
        inputSchema = { type: 'object' as const, ...inputSchema };
      }

      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
        ...(tool.annotations && { annotations: tool.annotations }),
        // outputSchema keeps its discriminated variants (no flattening, no
        // access-level filtering — those are input concerns) but the MCP spec
        // requires a tool's outputSchema to be an OBJECT schema. TypeBox
        // serializes a `Type.Union` of object variants to a bare `{ anyOf: [...] }`
        // with no top-level `type`, which a validating host rejects. Stamp
        // `type: "object"` on top so the union is advertised as a valid object
        // schema while the `anyOf` still tells the client which variant applied.
        ...(tool.outputSchema && { outputSchema: normalizeOutputSchema(tool.outputSchema) }),
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
}
