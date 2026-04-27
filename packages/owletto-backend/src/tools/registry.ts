/**
 * MCP Tool Registry
 *
 * This file defines all MCP tools and imports their Typebox schemas from tool files.
 * Typebox provides compile-time type safety and runtime JSON schema generation.
 */

import { getPublicReadableActions, getRequiredAccessLevel } from '../auth/tool-access';
import type { Env } from '../index';
import { INTERNAL_REST_TOOLS } from './admin';
import { QuerySqlSchema, querySql } from './admin/query_sql';
import { ListOrganizationsSchema } from './organizations';
import { ResolvePathSchema, resolvePath } from './resolve_path';
import { SaveContentSchema, saveContent } from './save_content';
import { SearchSchema, search } from './search';
import { QuerySchema, RunSchema, querySdkScript, runSdkScript } from './sdk_run';
import { SdkSearchSchema, sdkSearch } from './sdk_search';

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
}

export type TokenType = 'oauth' | 'session' | 'pat' | 'anonymous';

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
  /** Durable Owletto/Lobu agent identity bound to this MCP session, when provided. */
  agentId?: string | null;
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
  /** PUBLIC_WEB_URL env var fallback for URL generation when requestUrl is unreliable */
  baseUrl?: string;
}

export interface ToolDefinition<T = any> {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
  annotations?: ToolAnnotations;
  /** Internal tools are excluded from external MCP clients (only available to the frontend) */
  internal?: boolean;
  handler: (args: T, env: Env, ctx: ToolContext) => Promise<any>;
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

const TOOLS: ToolDefinition[] = [
  // ─── Memory hot path — read ───────────────────────────────────────────────
  {
    name: 'search_knowledge',
    description:
      'First step when answering anything about the user. Searches the workspace knowledge graph for entities, saved facts, decisions, preferences, and notes. Supports fuzzy matching and entity_type filtering. Pair writes with `save_knowledge`; reach for `query` only when a TS script is needed.',
    inputSchema: SearchSchema,
    annotations: READ_ONLY,
    handler: search,
  },
  {
    name: 'save_knowledge',
    description:
      "Save user-shared facts, preferences, decisions, observations, and notes the moment they surface. Storage is append-only — pass `supersedes_event_id` to replace an existing fact (the old event is hidden from future searches without losing history). Optionally attach to entities via `entity_ids`. Always search first to avoid duplicates.",
    inputSchema: SaveContentSchema,
    annotations: { readOnlyHint: true },
    handler: saveContent,
  },
  // ─── Discovery ────────────────────────────────────────────────────────────
  {
    name: 'list_organizations',
    description:
      'List organizations the authenticated user belongs to, plus any public workspaces the session can read. The response marks the bound org with `is_current: true` — that is the default target for memory and SDK calls. Use the slug with `client.org(slug)` from `query` / `run` for cross-org reads on /mcp + OAuth, or reconnect to /mcp/{slug} to pin a different default.',
    inputSchema: ListOrganizationsSchema,
    annotations: READ_ONLY,
    handler: async () => {
      throw new Error('Handled directly in executeTool');
    },
  },
  {
    name: 'search',
    description:
      "Discover ClientSDK methods. Pass a namespace ('watchers', 'entities', etc.) for a listing, a dotted path ('watchers.create') for a drill-down with signature/throws/example, or a free-text query for fuzzy matches. Hot-path methods include a usage_example. Pair with `query` (read-only) or `run` (full SDK) to actually call methods.",
    inputSchema: SdkSearchSchema,
    annotations: READ_ONLY,
    handler: sdkSearch,
  },
  // ─── Power tools — TS scripting + raw SQL ─────────────────────────────────
  {
    name: 'query',
    description:
      'Run a TypeScript script in a sandboxed isolate over a READ-ONLY `ClientSDK`. The script signature is `export default async (ctx, client) => ...`. Mutating methods are absent from `client` — attempts surface as undefined methods, retry with `run`. Output capped at 1 MB. Use `search` to find method names. Example: `export default async (_ctx, client) => client.entities.list({ entity_type: "company" });`',
    inputSchema: QuerySchema,
    annotations: READ_ONLY,
    handler: querySdkScript,
  },
  {
    name: 'query_sql',
    description:
      'Run a paginated, sortable, searchable read-only SQL query. Table references auto-scope to the bound org. Do NOT include ORDER BY/LIMIT/OFFSET or positional parameters. Optional `org_slug` (OAuth on /mcp only) redirects the query to a different member org; rejected on /mcp/{slug} and on PAT auth.',
    inputSchema: QuerySqlSchema,
    annotations: READ_ONLY,
    handler: querySql,
  },
  {
    name: 'run',
    description:
      'Destructive — confirm before running. Runs a TypeScript script in a sandboxed isolate over the FULL `ClientSDK`. Signature: `export default async (ctx, client) => ...`. Can mutate entities, watchers, knowledge, classifiers, connections, etc. Use `query` for reads. Output capped at 1 MB. Example: `export default async (_ctx, client) => client.entities.create({ type: "company", name: "Acme" });`',
    inputSchema: RunSchema,
    annotations: { destructiveHint: true },
    handler: runSdkScript,
  },
  // ─── REST/session/CLI surface (manage_*, list_watchers, get_watcher, ...) ─
  ...INTERNAL_REST_TOOLS,
  // ─── Path resolution (frontend internal) ──────────────────────────────────
  {
    name: 'resolve_path',
    description:
      'Resolve a namespace-based URL path like /acme/entity-type/entity-slug into namespace and entity details. Returns template_data with executed data source query results when templates define data_sources.',
    inputSchema: ResolvePathSchema,
    annotations: READ_ONLY,
    internal: true,
    handler: resolvePath,
  },
];

// ============================================
// Helper Functions
// ============================================

/**
 * Get tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * Flatten a TypeBox Union (anyOf) schema into a single object schema.
 * Each variant must be an object with an `action` literal discriminator.
 * Result: single object with `action` as a string enum, all other
 * properties merged (only `action` is required).
 */
function flattenUnionSchema(schema: any): any {
  const variants: any[] = schema.anyOf || schema.oneOf;
  const actionValues: string[] = [];
  const mergedProperties: Record<string, any> = {};

  for (const variant of variants) {
    if (variant.type !== 'object' || !variant.properties) continue;
    for (const [key, prop] of Object.entries<any>(variant.properties)) {
      if (key === 'action') {
        if (prop.const) actionValues.push(prop.const);
        continue;
      }
      // First occurrence wins (keeps description from the first variant that defines it)
      if (!mergedProperties[key]) {
        mergedProperties[key] = prop;
      }
    }
  }

  return {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: actionValues, description: 'Action to perform' },
      ...mergedProperties,
    },
    required: ['action'],
  };
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

/**
 * Get all tool definitions for MCP tools/list
 */
export function getAllTools(options?: {
  includeInternalTools?: boolean;
  publicOnly?: boolean;
  maxAccessLevel?: 'read' | 'write' | 'admin';
}) {
  const includeInternalTools = options?.includeInternalTools ?? true;
  const publicOnly = options?.publicOnly ?? false;
  const maxAccessLevel = options?.maxAccessLevel ?? 'admin';

  return TOOLS.filter((tool) => includeInternalTools || !tool.internal)
    .filter((tool) => !publicOnly || getPublicReadableActions(tool.name) !== undefined)
    .map((tool) => {
      let inputSchema = tool.inputSchema;
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
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
}

