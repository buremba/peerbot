/**
 * Workspace Instructions Builder
 *
 * Generates MCP instructions with workspace schema (entity types, relationship
 * types) and behavioral guidance so LLMs act as a proactive memory layer.
 * All entity-level data comes from tool calls at runtime, not from instructions.
 */

import { getDb } from '../db/client';
import logger from './logger';

export async function buildWorkspaceInstructions(organizationId: string): Promise<string | null> {
  const sql = getDb();

  try {
    // Entity/relationship COUNTS are deliberately excluded: this block is part
    // of the cached system prompt, and live counts would mutate it on every
    // memory write, busting the prompt cache (and all downstream message
    // history) on each context refresh. Only stable schema belongs here; the
    // agent gets live counts from tool calls at runtime.
    const [entityTypeRows, relationshipTypes] = await Promise.all([
      sql.unsafe(
        `SELECT slug, name, metadata_schema, event_kinds FROM entity_types
         WHERE deleted_at IS NULL
           AND organization_id = $1
         ORDER BY name ASC`,
        [organizationId]
      ),
      sql.unsafe(
        `SELECT rt.slug, rt.name, rt.is_symmetric, inv.slug as inverse_type_slug
         FROM entity_relationship_types rt
         LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
         WHERE rt.status = 'active'
           AND rt.deleted_at IS NULL
           AND rt.organization_id = $1
         ORDER BY rt.name ASC`,
        [organizationId]
      ),
    ]);

    const entityTypeLines = entityTypeRows.map((et: any) => {
      const fields = et.metadata_schema ? Object.keys(et.metadata_schema).join(', ') : '';
      return `- ${et.slug} ("${et.name}")${fields ? ` — fields: ${fields}` : ''}`;
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
      relTypeLines.push(`- ${slug}${meta}`);
    }

    // Assemble
    const sections: string[] = [
      '## Lobu — Your Persistent Memory',
      '',
      "You have persistent memory. Use it proactively — don't wait to be asked.",
    ];

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
        cd.actions_schema,
        cd.mcp_config,
        cd.openapi_config
      FROM connector_definitions cd
      INNER JOIN connections c
        ON c.connector_key = cd.key
        AND c.organization_id = ${organizationId}
      WHERE cd.status = 'active'
        AND cd.organization_id = ${organizationId}
      ORDER BY cd.key
    `;

    if (operationConnections.length > 0) {
      sections.push(
        '',
        '### Connector Operations (call via `run_sdk` → `client.operations.execute(...)`)'
      );
      for (const conn of operationConnections) {
        const actionCount =
          conn.actions_schema && typeof conn.actions_schema === 'object'
            ? Object.keys(conn.actions_schema as Record<string, unknown>).length
            : 0;
        const mcpCount = conn.mcp_config ? 1 : 0;
        const openApiCount = conn.openapi_config ? 1 : 0;
        const totalSources = actionCount + mcpCount + openApiCount;
        if (totalSources === 0) continue;
        sections.push(
          `- ${conn.key}: local actions ${actionCount}, mcp ${mcpCount}, openapi ${openApiCount}`
        );
      }
    }

    sections.push(
      '',
      '### Tool surface',
      'External MCP tools: `search_memory`, `save_memory`, `search_sdk` (SDK discovery — pass mode=read for query_sdk methods), `query_sdk` (read-only TS), `query_sql` (paginated SQL for all members), `run_sdk` (full TS writes). Discover SDK methods with `search_sdk`, then call via `query_sdk` / `run_sdk`. Prefer `client.metrics.*` for governed metrics.',
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
