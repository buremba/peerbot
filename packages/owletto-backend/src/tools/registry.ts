/**
 * MCP Tool Registry
 *
 * This file defines all MCP tools and imports their Typebox schemas from tool files.
 * Typebox provides compile-time type safety and runtime JSON schema generation.
 */

import type { Static } from '@sinclair/typebox';
import { getPublicReadableActions, getRequiredAccessLevel } from '../auth/tool-access';
import type { Env } from '../index';
import { ADMIN_TOOLS } from './admin';
import { ListWatchersSchema, listWatchers } from './admin/manage_watchers';
import { GetContentSchema, getContent } from './get_content';
import { GetWatcherSchema, getWatcher } from './get_watchers';
import {
  JoinOrganizationSchema,
  ListOrganizationsSchema,
  SwitchOrganizationSchema,
} from './organizations';
import { ResolvePathSchema, resolvePath } from './resolve_path';
import { SaveContentSchema, saveContent } from './save_content';
// Import tool implementations and their schemas
import { SearchSchema, search } from './search';

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

/**
 * Tool execution context from authentication
 * Passed to all tool handlers for organization scoping
 */
export interface ToolContext {
  /** User's organization ID - REQUIRED for all operations */
  organizationId: string;
  /** User ID from OAuth token, PAT, or session (null for anonymous public reads) */
  userId: string | null;
  /** Durable Owletto/Lobu agent identity bound to this MCP session, when provided. */
  agentId?: string | null;
  /** Whether request was authenticated */
  isAuthenticated: boolean;
  /** OAuth client ID that created this request (null for session/anonymous) */
  clientId?: string | null;
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
  /** Org-switching tools are only exposed when the session uses the unscoped /mcp endpoint */
  orgSwitching?: boolean;
  handler: (args: T, env: Env, ctx: ToolContext) => Promise<any>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'search_knowledge',
    description:
      'Search the workspace knowledge graph and saved memory for entities and related context. Supports fuzzy matching and filtering by entity_type. Use this as the FIRST step when the user asks about a specific entity. If entity is missing, create it with manage_entity then configure ingestion with manage_connections.',
    inputSchema: SearchSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: Static<typeof SearchSchema>, env: Env, ctx: ToolContext) => {
      return await search(args, env, ctx);
    },
  },
  {
    name: 'list_watchers',
    description:
      'List watcher definitions and metadata for the current organization. Use optional filters like entity_id, watcher_id, or status. This is the discovery tool for finding watchers before using get_watcher on a specific watcher.',
    inputSchema: ListWatchersSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: Static<typeof ListWatchersSchema>, env: Env, ctx: ToolContext) => {
      return await listWatchers(args, env, ctx);
    },
  },
  {
    name: 'get_watcher',
    description:
      'Query saved analysis windows and metadata for a single watcher. Requires watcher_id. Use list_watchers to discover watchers first. Pair with read_knowledge + manage_watchers(action="complete_window") for client-driven LLM execution.',
    inputSchema: GetWatcherSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: Static<typeof GetWatcherSchema>, env: Env, ctx: ToolContext) => {
      return await getWatcher(args, env, ctx);
    },
  },
  {
    name: 'read_knowledge',
    description: `List or search saved knowledge and content for an entity. Provide \`query\` parameter to perform semantic/text search (combines vector similarity for longer queries with full-text matching). Omit \`query\` to list all saved knowledge with filters. Returns content ordered by relevance (when searching) or date (when listing).

WATCHER MODE: When \`watcher_id\` is provided with \`since\`/\`until\`, returns everything needed for external LLM processing:
- window_token: JWT for complete_window action
- prompt_rendered: Ready-to-use prompt for LLM
- extraction_schema: JSON Schema defining expected output structure
- content: The content data to analyze
- classifiers: Current classifier values for context`,
    inputSchema: GetContentSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: Static<typeof GetContentSchema>, env: Env, ctx: ToolContext) => {
      return await getContent(args, env, ctx);
    },
  },
  {
    name: 'resolve_path',
    description:
      'Resolve a namespace-based URL path like /acme/entity-type/entity-slug into namespace and entity details. Returns template_data with executed data source query results when templates define data_sources.',
    inputSchema: ResolvePathSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    internal: true,
    handler: async (args: Static<typeof ResolvePathSchema>, env: Env, ctx: ToolContext) => {
      return await resolvePath(args, env, ctx);
    },
  },
  {
    name: 'save_knowledge',
    description:
      "Save knowledge to the workspace, optionally associated with entities via entity_ids. Supports multiple content formats via payload_type: 'text' (default), 'markdown' (rich text), 'json_template' (structured UI with payload_template + payload_data), 'media' (media-focused), 'empty' (metadata only). Metadata is validated against the entity type schema when entities are provided. To update an existing fact, pass supersedes_event_id with the old event ID — the old event is hidden from future searches. Always search first to avoid duplicates.",
    inputSchema: SaveContentSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args: Static<typeof SaveContentSchema>, env: Env, ctx: ToolContext) => {
      return await saveContent(args, env, ctx);
    },
  },
  // Org switching tools (only exposed on unscoped /mcp endpoint)
  {
    name: 'list_organizations',
    description:
      'List organizations the authenticated user belongs to. Only available when the MCP session uses the unscoped /mcp endpoint.',
    inputSchema: ListOrganizationsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    orgSwitching: true,
    handler: async () => {
      throw new Error('Handled directly in executeTool');
    },
  },
  {
    name: 'switch_organization',
    description:
      'Switch the current session to a different organization. The org slug must have appeared in a prior list_organizations result. After switching, all subsequent tool calls operate in the new org context. Returns workspace instructions for the new org.',
    inputSchema: SwitchOrganizationSchema,
    annotations: { readOnlyHint: false },
    orgSwitching: true,
    handler: async () => {
      throw new Error('Handled directly in executeTool');
    },
  },
  {
    name: 'join_organization',
    description:
      'Join the current public workspace as a member so you can write (create entities, save knowledge, update classifications). Only works on workspaces with visibility=public; private workspaces still require an invitation. Idempotent — calling when already a member is safe. On the unscoped /mcp endpoint, pass `organization_slug`; on /mcp/{slug} sessions the current workspace is used.',
    inputSchema: JoinOrganizationSchema,
    // readOnlyHint:true lets read-scoped MCP sessions invoke it — the whole
    // point of this tool is to flip an anonymous reader into a member.
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async () => {
      throw new Error('Handled directly in executeTool');
    },
  },
  // Admin tools
  ...ADMIN_TOOLS,
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
  includeOrgSwitching?: boolean;
  publicOnly?: boolean;
  maxAccessLevel?: 'read' | 'write' | 'admin';
}) {
  const includeInternalTools = options?.includeInternalTools ?? true;
  const includeOrgSwitching = options?.includeOrgSwitching ?? false;
  const publicOnly = options?.publicOnly ?? false;
  const maxAccessLevel = options?.maxAccessLevel ?? 'admin';

  return TOOLS.filter((tool) => includeInternalTools || !tool.internal)
    .filter((tool) => includeOrgSwitching || !tool.orgSwitching)
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

/**
 * Check if a tool name matches a proxy tool prefix pattern (e.g. "gmail__send_email").
 * Returns the connector key prefix if matched, null otherwise.
 */
export function parseProxyToolName(
  toolName: string
): { prefix: string; originalName: string } | null {
  const idx = toolName.indexOf('__');
  if (idx <= 0) return null;
  return {
    prefix: toolName.substring(0, idx),
    originalName: toolName.substring(idx + 2),
  };
}
