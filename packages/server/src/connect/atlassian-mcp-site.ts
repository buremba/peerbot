import { type DbClient, getDb } from '../db/client';
import type { McpProxyConfig } from '../mcp-proxy/types';
import { resolveAtlassianMcpJiraSite } from '../operations/atlassian-mcp-feed';
import { jiraSiteConfigPatch, type JiraCloudSite } from './atlassian-resources';

/**
 * Resolve Jira site identity through the authenticated Rovo MCP connection and
 * persist it at the narrowest durable scope. A unique site is connection-wide;
 * an explicit selection from a multi-site grant stays feed-scoped.
 */
export async function reconcileAtlassianMcpJiraSite(params: {
  organizationId: string;
  connectionId: number;
  connectorKey: string;
  mcpConfig: McpProxyConfig;
  preferredCloudId?: string;
  feedId?: number;
  sql?: DbClient;
}): Promise<{ site: JiraCloudSite; configPatch: Record<string, unknown> }> {
  const sql = params.sql ?? getDb();
  const site = await resolveAtlassianMcpJiraSite(params);
  const configPatch = jiraSiteConfigPatch(site);

  if (params.feedId) {
    await sql`
      UPDATE feeds
      SET config = COALESCE(config, '{}'::jsonb) || ${sql.json(configPatch)}::jsonb,
          updated_at = NOW()
      WHERE id = ${params.feedId}
        AND organization_id = ${params.organizationId}
        AND connection_id = ${params.connectionId}
    `;
  }

  if (site.resourceCount === 1) {
    await sql`
      UPDATE connections
      SET config = (
            (COALESCE(config, '{}'::jsonb)
              - 'cloud_id' - 'site_cloud_id' - 'site_url' - 'site_name')
            || ${sql.json(configPatch)}::jsonb
          ),
          external_tenant_id = ${site.cloudId},
          updated_at = NOW()
      WHERE id = ${params.connectionId}
        AND organization_id = ${params.organizationId}
    `;
  }

  return { site, configPatch };
}
