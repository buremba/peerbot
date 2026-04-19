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
        SELECT entity_type, COUNT(*)::int as entity_count
        FROM entities
        WHERE organization_id = ${organizationId}
        GROUP BY entity_type
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
      sections.push('', '### Connector Operations (use manage_operations tool)');
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
      '### Saving (do this automatically)',
      'When the user shares any of these, save immediately:',
      '- Preferences, opinions, or personal details → save_knowledge to matching entity, create entity first if needed',
      '- Facts about people, projects, or topics → save_knowledge to the relevant entity',
      '- Relationships between things → manage_entity(action="link") with the appropriate relationship type',
      '',
      "### Updating Facts (supersede, don't duplicate)",
      'When a fact changes (e.g. updated preference, corrected info):',
      '1. Search for the existing fact: read_knowledge(query=…, entity_id=…)',
      '2. Save the updated fact with supersedes_event_id pointing to the old one:',
      '   save_knowledge({ content: "new fact", semantic_type: …, supersedes_event_id: <old_id> })',
      'The old fact is automatically hidden from future searches. Never save a duplicate — always search first.',
      '',
      '### Recalling',
      '- Always search before creating to avoid duplicates',
      '- search_knowledge(entity_type=…) to find entities by name',
      '- read_knowledge(query=…) for semantic recall across saved content',
      '- manage_entity(action="list_links") to explore connections',
      '',
      '### Full Schema Details',
      '- manage_entity_schema(schema_type=…, action="list") for field definitions and relationship rules'
    );

    return sections.join('\n');
  } catch (err) {
    logger.warn({ err, organizationId }, 'Failed to build workspace instructions');
    return null;
  }
}
