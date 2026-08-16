import { getDb } from './db/client';

/**
 * Retire rows written by the removed MCP App snapshot helpers. Keep this
 * bounded cleanup until every deployment has aged past the historical
 * retention window; no runtime path creates or restores these rows anymore.
 */
export async function cleanupExpiredMcpAppResultSnapshots(): Promise<number> {
  const rows = await getDb()`
    DELETE FROM public.mcp_app_result_snapshots WHERE expires_at <= now()
  `;
  return rows.count;
}
