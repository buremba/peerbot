/**
 * Workspace Instructions Builder
 *
 * Generates MCP instructions with workspace schema (entity types, relationship
 * types) and behavioral guidance so LLMs act as a proactive memory layer.
 * All entity-level data comes from tool calls at runtime, not from instructions.
 */

import { getDb } from '../db/client';
import logger from './logger';
import { loadOrgGuidanceBlock } from './org-guidance';

/** Collapse whitespace/newlines so an authored description stays one line. */
function singleLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Render a metadata schema's fields as a compact `name (description)` list.
 * Accepts both a real JSON Schema (descends into `.properties` — the old
 * render printed the envelope keys "type, properties" instead) and a legacy
 * bare field map. Field descriptions are authored schema — surface them.
 */
function renderSchemaFields(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  const s = schema as Record<string, unknown>;
  let props: Record<string, unknown> | null = null;
  if (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) {
    props = s.properties as Record<string, unknown>;
  } else if (typeof s.type !== 'string') {
    // Legacy shape: the schema IS the field map.
    props = s;
  }
  if (!props) return '';
  return Object.entries(props)
    .map(([field, def]) => {
      const desc = singleLine((def as Record<string, unknown> | null)?.description);
      return desc ? `${field} (${desc})` : field;
    })
    .join(', ');
}

export async function buildWorkspaceInstructions(organizationId: string): Promise<string | null> {
  const sql = getDb();

  try {
    // Entity/relationship COUNTS are deliberately excluded: this block is part
    // of the cached system prompt, and live counts would mutate it on every
    // memory write, busting the prompt cache (and all downstream message
    // history) on each context refresh. Only stable schema belongs here; the
    // agent gets live counts from tool calls at runtime. (Org guidance below
    // also qualifies: admin-authored text that only mutates on explicit edit.)
    const [entityTypeRows, relationshipTypes, orgGuidance] = await Promise.all([
      sql.unsafe(
        `SELECT slug, name, description, metadata_schema, event_kinds FROM entity_types
         WHERE deleted_at IS NULL
           AND organization_id = $1
         ORDER BY name ASC`,
        [organizationId]
      ),
      sql.unsafe(
        `SELECT rt.slug, rt.name, rt.description, rt.is_symmetric, inv.slug as inverse_type_slug
         FROM entity_relationship_types rt
         LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
         WHERE rt.status = 'active'
           AND rt.deleted_at IS NULL
           AND rt.organization_id = $1
         ORDER BY rt.name ASC`,
        [organizationId]
      ),
      loadOrgGuidanceBlock(organizationId),
    ]);

    const entityTypeLines = entityTypeRows.map((et: any) => {
      const desc = singleLine(et.description);
      const fields = renderSchemaFields(et.metadata_schema);
      return `- ${et.slug} ("${et.name}")${desc ? ` — ${desc}` : ''}${fields ? ` — fields: ${fields}` : ''}`;
    });

    const emittedRelSlugs = new Set<string>();
    const relTypeLines: string[] = [];
    for (const rt of relationshipTypes) {
      const slug = rt.slug as string;
      const inverseSlug = rt.inverse_type_slug as string | null;
      if (inverseSlug && emittedRelSlugs.has(inverseSlug)) continue;
      emittedRelSlugs.add(slug);
      const parts: string[] = [];
      if (rt.is_symmetric) parts.push('symmetric');
      if (inverseSlug) parts.push(`inverse: ${inverseSlug}`);
      const meta = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      const desc = singleLine(rt.description);
      relTypeLines.push(`- ${slug}${meta}${desc ? ` — ${desc}` : ''}`);
    }

    // Assemble
    const sections: string[] = [
      '## Lobu — Your Persistent Memory',
      '',
      "You have persistent memory. Use it proactively — don't wait to be asked.",
    ];

    // Org-wide admin-authored context goes near the top: it is the governed
    // "why" that frames everything below (schema, tools, saving rules).
    if (orgGuidance) {
      sections.push(
        '',
        '### Organization Context',
        'Org-wide guidance authored by workspace admins (event kind `guidance`; admins edit it via save_memory with supersedes_event_id).',
        orgGuidance
      );
    }

    if (entityTypeLines.length > 0) {
      sections.push('', '### Schema: Entity Types', ...entityTypeLines);
    }

    // Event kinds per entity type (only for types that define them)
    for (const et of entityTypeRows) {
      const eventKinds = et.event_kinds as Record<
        string,
        { description?: string; metadataSchema?: Record<string, unknown> }
      > | null;
      if (!eventKinds || typeof eventKinds !== 'object') continue;
      const kindEntries = Object.entries(eventKinds);
      if (kindEntries.length === 0) continue;

      const kindLines = kindEntries.map(([kind, def]) => {
        const desc = def.description ?? '';
        const metaFields = def.metadataSchema?.properties
          ? Object.keys(def.metadataSchema.properties as Record<string, unknown>).join(', ')
          : '';
        const parts = [desc, metaFields ? `metadata: ${metaFields}` : '']
          .filter(Boolean)
          .join(' — ');
        return `- ${kind}${parts ? ` — ${parts}` : ''}`;
      });
      sections.push(
        '',
        `### Event Semantic Types: ${et.slug}`,
        `Use these as the \`semantic_type\` parameter in save_memory for ${et.slug} entities.`,
        ...kindLines
      );
    }

    if (relTypeLines.length > 0) {
      sections.push('', '### Schema: Relationship Types', ...relTypeLines);
    }

    const operationConnections = await sql`
      SELECT DISTINCT ON (cd.key)
        cd.key,
        cd.name,
        cd.description,
        cd.actions_schema,
        cd.mcp_config,
        cd.openapi_config
      FROM connector_definitions cd
      WHERE cd.status = 'active'
        AND cd.organization_id = ${organizationId}
        AND (
          cd.actions_schema IS NOT NULL
          OR cd.mcp_config IS NOT NULL
          OR cd.openapi_config IS NOT NULL
        )
      ORDER BY cd.key
    `;

    if (operationConnections.length > 0) {
      sections.push(
        '',
        '### Connector Operations',
        // One path only: `run_sdk` → `client.operations.execute(...)` with the
        // REAL SDK signature (connection_id + operation_key — see
        // sandbox/namespaces/operations.ts). Deliberately NOT surfacing the
        // local/mcp/openapi backend split — that is internal plumbing
        // `execute` dispatches on, and showing it invites the agent to look
        // for a separate MCP/HTTP tool that does not exist.
        'Run any connector operation the same way: `run_sdk` → `client.operations.execute({ connection_id, operation_key, input })`. There is no separate per-connector tool.',
        'Discover capabilities with `query_sdk` → `client.operations.listAvailable({ query: "..." })`. It includes disconnected connectors, readiness, and every visible `execution_targets` entry; use the returned target directly instead of guessing a connection id.',
        'When readiness is disconnected, call the returned `next_action`. `connections.connect` / `connections.create` may return `status: "setup_required"`: show its resolved setup/install URL, follow `next_action`, then invoke `resume_call` or poll `completion_check` exactly as returned.',
        'Execution may be policy-gated: a gated op returns `status: "pending_approval"` (a run queued for a human). Surface that to the user rather than treating it as a failure.'
      );
      for (const conn of operationConnections) {
        const localOps =
          conn.actions_schema && typeof conn.actions_schema === 'object'
            ? Object.keys(conn.actions_schema as Record<string, unknown>)
            : [];
        const hasMcp = !!conn.mcp_config;
        const hasOpenApi = !!conn.openapi_config;
        if (localOps.length === 0 && !hasMcp && !hasOpenApi) continue;
        // Prefer showing concrete operation names; fall back to a discovery
        // pointer when the ops live behind mcp/openapi backends (whose names
        // aren't in actions_schema — list_available resolves them).
        const detail =
          localOps.length > 0
            ? localOps.join(', ')
            : 'operations via `manage_operations.list_available`';
        const desc = singleLine(conn.description);
        sections.push(`- ${conn.key}${desc ? ` (${desc})` : ''}: ${detail}`);
      }
    }

    sections.push(
      '',
      '### Tool surface',
      'External MCP tools: `search_memory`, `save_memory`, `search_sdk` (SDK method + connector discovery — pass mode=read for query_sdk methods), `query_sdk` (read-only TS), `query_sql` (paginated SQL for all members), `run_sdk` (full TS writes). Discover with `search_sdk`, then act via `query_sdk` / `run_sdk`. Prefer `client.metrics.*` for governed metrics.',
      '### Connecting a data source (do NOT assume a source is unsupported — enumerate first)',
      'A connector may be INSTALLED for this org yet absent from the global catalog, so always check installed connectors before concluding a source is unsupported:',
      '- Find the connector: `search_sdk` with the source/topic word (e.g. "website", "slack") returns any matching live connector + its feed keys + lifecycle. Or list them: `query_sdk` → `client.catalog.listInstalled({ kinds: ["connectors"] })` (installed = ready to configure; each item\'s `detail.feeds_schema` keys are the feed_key values) and `client.catalog.listCatalog({ kinds: ["connectors"] })` (global, installable) and `client.connections.list()` (already configured).',
      '- Lifecycle: `run_sdk` → `client.connections.connect({ connector_key })` → `client.feeds.create({ connection_id, feed_key, config })` → `client.feeds.trigger({ feed_id })`; then verify with `query_sql` on the events table and search with `search_memory`.',
      'For reads beyond search_memory, prefer `query_sdk` with a TS script. For writes (entity CRUD, watchers, classifiers, connections, feeds, view templates, operations), use `run_sdk`. Use `search_sdk` to discover method names.',
      '',
      '### Saving (do this automatically)',
      'When the user shares any of these, save immediately:',
      '- Preferences, opinions, or personal details → `save_memory` to matching entity (create the entity first via `run_sdk({script: "client.entities.create(...)"})` if needed)',
      '- Facts about people, projects, or topics → `save_memory` to the relevant entity',
      '- Relationships between things → `run_sdk` calling `client.entities.link({...})`',
      '',
      "### Updating Facts (supersede, don't duplicate)",
      'When a fact changes (e.g. updated preference, corrected info):',
      '1. Search for the existing fact via `search_memory` or `query_sdk({script: "client.knowledge.read({...})"})`',
      '2. Save the updated fact with `supersedes_event_id` pointing to the old one in `save_memory`',
      'The old fact is automatically hidden from future searches. Never save a duplicate — always search first.',
      '',
      '### Recalling',
      '- Always search before creating to avoid duplicates',
      '- `search_memory(query=…, entity_type=…)` to find entities + semantic content matches',
      '- `query_sdk({script: "client.entities.listLinks({entity_id: ...})"})` to explore relationships',
      '',
      '### Full schema details',
      '- `query_sdk({script: "client.entitySchema.listTypes()"})` for entity types',
      '- `query_sdk({script: "client.entitySchema.listRelTypes()"})` for relationship types and rules'
    );

    return sections.join('\n');
  } catch (err) {
    logger.warn({ err, organizationId }, 'Failed to build workspace instructions');
    return null;
  }
}
