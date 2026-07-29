/**
 * Atlassian 3LO site discovery.
 *
 * Jira (and other Atlassian Cloud products) OAuth tokens are site-agnostic.
 * REST calls need the Cloud id: `https://api.atlassian.com/ex/jira/{cloudId}/…`.
 * After code exchange we call accessible-resources once and stamp the primary
 * site onto the connection (`config.cloud_id` + `external_tenant_id`).
 *
 * No other Lobu OAuth connector needs this: Gmail/Calendar/YouTube/Outlook/Reddit
 * are user-scoped fixed hosts; GitHub/Slack/Linear tenant identity arrives via
 * app-install callbacks, not 3LO.
 */

import logger from '../utils/logger';

export interface AtlassianAccessibleResource {
  id: string;
  url: string | null;
  name: string | null;
  scopes: string[];
}

export interface JiraCloudSite {
  cloudId: string;
  siteUrl: string | null;
  siteName: string | null;
  /** Full list returned by accessible-resources (for multi-site future UI). */
  accessibleResources: AtlassianAccessibleResource[];
}

const ACCESSIBLE_RESOURCES_URL =
  'https://api.atlassian.com/oauth/token/accessible-resources';

/**
 * Fetch sites the 3LO token can reach. Returns [] on network/API failure so
 * OAuth completion never hard-fails on a discovery hiccup — the connector can
 * still lazy-resolve at first use.
 */
export async function fetchAtlassianAccessibleResources(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<AtlassianAccessibleResource[]> {
  try {
    const response = await fetchImpl(ACCESSIBLE_RESOURCES_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, body: body.slice(0, 500) },
        'Atlassian accessible-resources request failed'
      );
      return [];
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    const out: AtlassianAccessibleResource[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      if (!id) continue;
      out.push({
        id,
        url: typeof row.url === 'string' ? row.url : null,
        name: typeof row.name === 'string' ? row.name : null,
        scopes: Array.isArray(row.scopes)
          ? row.scopes.filter((s): s is string => typeof s === 'string')
          : [],
      });
    }
    return out;
  } catch (error) {
    logger.warn({ error }, 'Atlassian accessible-resources request error');
    return [];
  }
}

/**
 * Prefer a resource that already carries a Jira scope; otherwise first site.
 * Returns null when the token has no accessible Cloud sites.
 */
export function pickPrimaryJiraSite(
  resources: AtlassianAccessibleResource[]
): JiraCloudSite | null {
  if (resources.length === 0) return null;
  const jiraScoped =
    resources.find((r) => r.scopes.some((s) => s.includes('jira'))) ?? resources[0];
  return {
    cloudId: jiraScoped.id,
    siteUrl: jiraScoped.url,
    siteName: jiraScoped.name,
    accessibleResources: resources,
  };
}

/**
 * Resolve the primary Jira Cloud site for a freshly issued 3LO access token.
 */
export async function resolveJiraCloudSite(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<JiraCloudSite | null> {
  const resources = await fetchAtlassianAccessibleResources(accessToken, fetchImpl);
  return pickPrimaryJiraSite(resources);
}

/**
 * Merge discovered site fields into a connection.config blob without clobbering
 * unrelated keys (webhook state, action_modes, …).
 */
export function mergeJiraSiteIntoConnectionConfig(
  existing: Record<string, unknown> | null | undefined,
  site: JiraCloudSite
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  next.cloud_id = site.cloudId;
  if (site.siteUrl) next.site_url = site.siteUrl;
  if (site.siteName) next.site_name = site.siteName;
  // Compact list for multi-site UI later — strip scopes (can be long).
  next.accessible_sites = site.accessibleResources.map((r) => ({
    id: r.id,
    url: r.url,
    name: r.name,
  }));
  return next;
}
