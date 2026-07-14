/**
 * Connector intent-search for `search_sdk`.
 *
 * A fresh agent asked to "connect a website" searches by INTENT ("website",
 * "crawl a web page"), not by the exact SDK method path — and a connector may be
 * installed for this org yet absent from the global catalog, so it's easy to
 * wrongly conclude a source is unsupported (the agent-discovery audit's RSS-
 * instead-of-Website failure). This surfaces the matching live connector — with
 * its feed keys and the exact connect→feed→trigger lifecycle — directly in
 * `search_sdk` results, so one discovery call finds the capability whether it's
 * a method or a connector (the "one catalog" idea). Read-only; never emits
 * credentials or raw connector config.
 *
 * Reuses the existing admin handlers (same functions the sandbox namespaces
 * wrap) — no new data path, no cross-replica state. Handlers are injectable so
 * tests supply fakes without `mock.module` (process-global in Bun, it corrupts
 * sibling suites).
 */

import { manageCatalog } from './admin/manage_catalog';
import { manageConnections } from './admin/manage_connections';
import type { Env } from '../index';
import type { ToolContext } from './registry';

export interface ConnectorDiscoveryDeps {
  manageCatalog: typeof manageCatalog;
  manageConnections: typeof manageConnections;
}

const DEFAULT_DEPS: ConnectorDiscoveryDeps = { manageCatalog, manageConnections };

function asArray<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Feed keys are the top-level keys of a connector's feeds_schema object. */
function feedKeysOf(detail: unknown): string[] | undefined {
  const feeds = (detail as { feeds_schema?: unknown } | null)?.feeds_schema;
  if (!feeds || typeof feeds !== 'object' || Array.isArray(feeds)) return undefined;
  const keys = Object.keys(feeds as Record<string, unknown>);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Token-aware match: an agent rarely searches the bare connector name — it
 * searches a phrase like "website connect source" or "crawl a web page". Match
 * when ANY meaningful token of the query hits a connector field, so a multi-word
 * query still finds the connector. Short/stopword tokens are dropped so common
 * filler words don't match every connector.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'to', 'of', 'in', 'and', 'or', 'for', 'with', 'into',
  'connect', 'connector', 'source', 'data', 'get', 'add', 'set', 'up', 'from',
  'search', 'ingest', 'collect', 'sync', 'read', 'content', 'page', 'pages',
]);
function matchesQueryTokens(query: string, ...fields: Array<string | null | undefined>): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return false;
  const hay = fields.filter((f): f is string => typeof f === 'string').map((f) => f.toLowerCase());
  return tokens.some((t) => hay.some((f) => f.includes(t)));
}

/**
 * Search live connectors (installed + global catalog) for an intent keyword,
 * returning rendered lines in `search_sdk`'s result shape. Installed connectors
 * come first (ready to configure, or already configured), then catalog offerings
 * (installable). Empty for a blank query or no match.
 */
export async function searchLiveConnectors(
  query: string,
  env: Env,
  ctx: ToolContext,
  deps: ConnectorDiscoveryDeps = DEFAULT_DEPS
): Promise<string[]> {
  const { manageCatalog, manageConnections } = deps;
  const q = query.trim();
  if (!q) return [];
  const lines: string[] = [];
  try {
    const [inst, cat, conn] = await Promise.all([
      manageCatalog({ action: 'list_installed', kinds: ['connectors'] } as never, env, ctx) as Promise<{
        installed?: { connectors?: { items?: unknown } };
      }>,
      manageCatalog({ action: 'list_catalog', kinds: ['connectors'] } as never, env, ctx) as Promise<{
        catalogs?: { connectors?: { entries?: unknown } };
      }>,
      manageConnections({ action: 'list', limit: 200 } as never, env, ctx) as Promise<{
        connections?: unknown;
      }>,
    ]);
    const installed = asArray<{
      id: string;
      name?: string;
      detail?: { description?: string; feeds_schema?: unknown };
    }>(inst.installed?.connectors?.items);
    const catalog = asArray<{ id: string; name?: string; description?: string }>(
      cat.catalogs?.connectors?.entries
    );
    const configured = asArray<{ connector_key: string; status: string }>(conn.connections);
    const configuredByKey = new Map<string, string>();
    for (const c of configured) {
      if (!configuredByKey.has(c.connector_key)) configuredByKey.set(c.connector_key, c.status);
    }
    const installedIds = new Set(installed.map((i) => i.id));

    for (const i of installed) {
      if (!matchesQueryTokens(q, i.id, i.name, i.detail?.description)) continue;
      const feeds = feedKeysOf(i.detail);
      const status = configuredByKey.get(i.id);
      if (status) {
        // Already has a live connection — read/verify, don't re-connect.
        lines.push(
          `connector '${i.id}' (${i.name ?? i.id}) — INSTALLED and already CONFIGURED (a connection exists, status: ${status}).${
            feeds ? ` Feed keys: ${feeds.join(', ')}.` : ''
          } To add a feed: run_sdk → client.feeds.create({ connection_id, feed_key: ${
            feeds?.[0] ? `'${feeds[0]}'` : '<feed_key>'
          }, config }). To read collected data: query_sql on events or search_memory. Get the connection_id via query_sdk → client.connections.list({ connector_key: '${i.id}' }).`
        );
      } else {
        lines.push(
          `connector '${i.id}' (${i.name ?? i.id}) — INSTALLED, not yet configured.${
            feeds ? ` Feed keys: ${feeds.join(', ')}.` : ''
          } Lifecycle: run_sdk → client.connections.connect({ connector_key: '${i.id}' }) → client.feeds.create({ connection_id, feed_key: ${
            feeds?.[0] ? `'${feeds[0]}'` : '<feed_key>'
          }, config }) → client.feeds.trigger({ feed_id }); then query_sql on events or search_memory to read. Use search_sdk 'feeds.create feeds.trigger' for signatures.`
        );
      }
    }
    for (const c of catalog) {
      if (installedIds.has(c.id)) continue; // installed line already covers it
      if (!matchesQueryTokens(q, c.id, c.name, c.description)) continue;
      lines.push(
        `connector '${c.id}' (${c.name ?? c.id}) — in the global CATALOG, not yet installed here. Install with run_sdk → client.connections.installConnector({ connector_id: '${c.id}' }), then connect + create feed.`
      );
    }
  } catch {
    return [];
  }
  return lines.slice(0, 8);
}
