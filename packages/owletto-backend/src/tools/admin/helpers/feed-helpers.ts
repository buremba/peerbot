import { getDb, pgBigintArray } from '../../../db/client';

export interface FeedDefinition {
  key?: string;
  name?: string;
  displayNameTemplate?: string;
  configSchema?: {
    properties?: Record<string, unknown>;
  } | null;
}

function getFeedDefinition(
  feedsSchema: Record<string, FeedDefinition> | null,
  feedKey: string
): FeedDefinition | null {
  if (!feedsSchema) return null;
  if (feedsSchema[feedKey]) return feedsSchema[feedKey];

  for (const definition of Object.values(feedsSchema)) {
    if (definition?.key === feedKey) return definition;
  }

  const definitions = Object.values(feedsSchema);
  return definitions.length === 1 ? (definitions[0] ?? null) : null;
}

export function splitConfigByFeedScope(
  config: Record<string, unknown> | null | undefined,
  feedsSchema: Record<string, FeedDefinition> | null
): {
  connectionConfig: Record<string, unknown> | null;
  feedConfig: Record<string, unknown> | null;
} {
  if (!config || Object.keys(config).length === 0) {
    return {
      connectionConfig: null,
      feedConfig: null,
    };
  }

  const feedScopedKeys = new Set<string>();
  for (const definition of Object.values(feedsSchema ?? {})) {
    for (const key of Object.keys(definition?.configSchema?.properties ?? {})) {
      feedScopedKeys.add(key);
    }
  }

  const connectionConfig: Record<string, unknown> = {};
  const feedConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (feedScopedKeys.has(key)) {
      feedConfig[key] = value;
    } else {
      connectionConfig[key] = value;
    }
  }

  return {
    connectionConfig: Object.keys(connectionConfig).length > 0 ? connectionConfig : null,
    feedConfig: Object.keys(feedConfig).length > 0 ? feedConfig : null,
  };
}

export async function resolveFeedDisplayName(params: {
  explicitName?: string | null;
  feedKey: string;
  config?: Record<string, unknown> | null;
  entityIds?: number[] | null;
  feedsSchema: Record<string, FeedDefinition> | null;
}): Promise<string> {
  if (params.explicitName?.trim()) return params.explicitName.trim();

  const definition = getFeedDefinition(params.feedsSchema, params.feedKey);
  const baseName = definition?.name ?? params.feedKey;

  if (definition?.displayNameTemplate && params.config) {
    const rendered = definition.displayNameTemplate
      .replace(/\{(\w+)\}/g, (_, key) => {
        const value = params.config?.[key];
        return value != null ? String(value) : '';
      })
      .replace(/\s*-\s*$/, '')
      .trim();
    if (rendered) return rendered;
  }

  if (params.entityIds?.length) {
    const sql = getDb();
    const rows = await sql`
      SELECT name
      FROM entities
      WHERE id = ANY(${pgBigintArray(params.entityIds)}::bigint[])
      ORDER BY name
      LIMIT 5
    `;
    const names = rows.map((row: { name: string }) => row.name).filter(Boolean);
    if (names.length > 0) return `${baseName} for ${names.join(', ')}`;
  }

  if (params.config) {
    const firstStringValue = Object.values(params.config).find(
      (value) => typeof value === 'string' && value.trim().length > 0
    ) as string | undefined;
    if (firstStringValue) return `${baseName}: ${firstStringValue}`;
  }

  return baseName;
}
