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
    const [entityTypeRows, entityCounts, relationshipTypes] = await Promise.all([
      sql.unsafe(
        `SELECT slug, name, metadata_schema, event_kinds FROM entity_types
         WHERE deleted_at IS NULL
           AND organization_id = $1
         ORDER BY name ASC`,
        [organizationId]
      ),
      sql`
        SELECT et.slug AS entity_type, COUNT(*)::int as entity_count
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${organizationId}
          AND e.deleted_at IS NULL
        GROUP BY et.slug
      `,
      sql.unsafe(
        `SELECT rt.slug, rt.name, rt.is_symmetric, inv.slug as inverse_type_slug,
            COALESCE(rc.cnt, 0)::int as relationship_count
         FROM entity_relationship_types rt
         LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
         LEFT JOIN (
           SELECT relationship_type_id, COUNT(*) as cnt
           FROM entity_relationships WHERE deleted_at IS NULL
           GROUP BY relationship_type_id
         ) rc ON rc.relationship_type_id = rt.id
         WHERE rt.status = 'active'
           AND rt.deleted_at IS NULL
           AND rt.organization_id = $1
         ORDER BY rt.name ASC`,
        [organizationId]
      ),
    ]);

    const counts = new Map<string, number>();
    for (const row of entityCounts) {
      counts.set(row.entity_type as string, Number(row.entity_count));
    }

    const entityTypeLines = entityTypeRows.map((et: any) => {
      const count = counts.get(et.slug) || 0;
      const fields = et.metadata_schema ? Object.keys(et.metadata_schema).join(', ') : '';
      return `- ${et.slug} ("${et.name}")${fields ? ` — fields: ${fields}` : ''} — ${count} entities`;
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
      relTypeLines.push(`- ${slug}${meta} — ${rt.relationship_count} links`);
    }

    // Assemble
    const sections: string[] = [
      '## Owletto — Your Persistent Memory',
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
        `Use these as the \`semantic_type\` parameter in save_knowledge for ${et.slug} entities.`,
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
        '### Connector Operations (call via `run` → `client.operations.execute(...)`)'
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
      'External MCP tools: `search_knowledge`, `save_knowledge`, `list_organizations`, `search` (SDK method discovery), `query` (read-only TS over the typed client SDK), `query_sql` (read-only SQL), `run` (full TS — destructive).',
      'For reads beyond search_knowledge, prefer `query` with a TS script. For writes (entity CRUD, watchers, classifiers, connections, feeds, view templates, operations), use `run`. Use `search` to discover method names.',
      '',
      '### Saving (do this automatically)',
      'When the user shares any of these, save immediately:',
      '- Preferences, opinions, or personal details → `save_knowledge` to matching entity (create the entity first via `run({script: "client.entities.create(...)"})` if needed)',
      '- Facts about people, projects, or topics → `save_knowledge` to the relevant entity',
      '- Relationships between things → `run` calling `client.entities.link({...})`',
      '',
      "### Updating Facts (supersede, don't duplicate)",
      'When a fact changes (e.g. updated preference, corrected info):',
      '1. Search for the existing fact via `search_knowledge` or `query({script: "client.knowledge.read({...})"})`',
      '2. Save the updated fact with `supersedes_event_id` pointing to the old one in `save_knowledge`',
      'The old fact is automatically hidden from future searches. Never save a duplicate — always search first.',
      '',
      '### Recalling',
      '- Always search before creating to avoid duplicates',
      '- `search_knowledge(query=…, entity_type=…)` to find entities + semantic content matches',
      '- `query({script: "client.entities.listLinks({entity_id: ...})"})` to explore relationships',
      '',
      '### Full schema details',
      '- `query({script: "client.entitySchema.listTypes()"})` for entity types',
      '- `query({script: "client.entitySchema.listRelTypes()"})` for relationship types and rules'
    );

    return sections.join('\n');
  } catch (err) {
    logger.warn({ err, organizationId }, 'Failed to build workspace instructions');
    return null;
  }
}
