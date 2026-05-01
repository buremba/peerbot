/**
 * Feed Sync Library
 *
 * Extracted from scripts/sync-local.ts for programmatic reuse.
 */

import { executeCompiledConnector } from '../../../connector-worker/src/executor/runtime';
import { getDb } from '../db/client';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import logger from '../utils/logger';

export interface FeedRecord {
  id: number;
  type: string;
  organization_id: string;
  connection_id: number;
  connector_key: string;
  feed_key: string;
  entity_ids: number[];
  config: Record<string, unknown>;
  connection_config: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  compiled_code: string | null;
  api_type: string | null;
  auth_profile_id: number | null;
  app_auth_profile_id: number | null;
}

export interface FeedFilter {
  feedId?: number;
  type?: string;
}

export async function fetchFeeds(filter?: FeedFilter): Promise<FeedRecord[]> {
  const sql = getDb();

  let query = `
    SELECT
      f.id,
      f.organization_id,
      f.connection_id,
      c.connector_key,
      f.feed_key,
      f.feed_key AS type,
      COALESCE(f.entity_ids, '{}'::bigint[]) AS entity_ids,
      COALESCE(f.config, '{}'::jsonb) AS config,
      COALESCE(c.config, '{}'::jsonb) AS connection_config,
      f.checkpoint,
      cv.compiled_code,
      resolved_def.api_type,
      c.auth_profile_id,
      c.app_auth_profile_id
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    LEFT JOIN LATERAL (
      SELECT d.version, d.api_type
      FROM connector_definitions d
      WHERE d.key = c.connector_key
        AND d.status = 'active'
        AND d.organization_id = f.organization_id
      ORDER BY d.updated_at DESC
      LIMIT 1
    ) resolved_def ON TRUE
    LEFT JOIN connector_versions cv
      ON cv.connector_key = c.connector_key
     AND cv.version = COALESCE(f.pinned_version, resolved_def.version)
    WHERE f.status = 'active'
      AND c.status = 'active'
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
  `;
  const params: unknown[] = [];

  if (filter?.feedId != null) {
    params.push(filter.feedId);
    query += ` AND f.id = $${params.length}`;
  }
  if (filter?.type) {
    params.push(filter.type);
    query += ` AND f.feed_key = $${params.length}`;
  }

  query += ' ORDER BY f.id';

  const result = await sql.unsafe(query, params);
  return result.map((row) => ({
    ...(row as FeedRecord),
    entity_ids: parseEntityIds((row as { entity_ids: unknown }).entity_ids),
  })) as FeedRecord[];
}

export async function runFeed(feed: FeedRecord): Promise<{ itemCount: number }> {
  logger.info(
    {
      feedId: feed.id,
      feedKey: feed.feed_key,
      connectorKey: feed.connector_key,
      entityIds: feed.entity_ids,
    },
    'Starting feed sync'
  );

  const compiledCode = await resolveConnectorCode(feed.connector_key, feed.compiled_code);

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: feed.organization_id,
    connectionId: feed.connection_id,
    authProfileId: feed.auth_profile_id,
    appAuthProfileId: feed.app_auth_profile_id,
    credentialDb: getDb(),
    logContext: { feedId: feed.id },
    logMessage: 'Failed to resolve feed credentials',
  });
  const result = await executeCompiledConnector({
    mode: 'sync',
    compiledCode,
    config: mergeExecutionConfig(feed.connection_config, feed.config),
    checkpoint: feed.checkpoint as any,
    env: process.env as Record<string, string | undefined>,
    connectionCredentials,
    sessionState,
    credentials,
    feedKey: feed.feed_key,
    entityIds: feed.entity_ids,
    apiType: (feed.api_type as 'api' | 'browser') || 'api',
  });
  const itemCount = result.contents.length;

  logger.info({ feedId: feed.id, itemCount }, 'Feed sync completed');
  return { itemCount };
}

function parseEntityIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map(Number).filter(Number.isFinite);
  }
  if (typeof raw === 'string') {
    return raw.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number).filter(Number.isFinite);
  }
  return [];
}
