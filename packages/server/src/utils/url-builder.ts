/**
 * URL Builder for Frontend Links
 *
 * Generates consistent URLs for the frontend application.
 */

import { getWorkspaceProvider } from '../workspace';
import {
  getConfiguredPublicOrigin,
  HOSTED_UI_FALLBACK_ORIGIN,
  hasLocalFrontend,
} from './public-origin';

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  return baseUrl.replace(/\/+$/, '');
}

function withBaseUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl}${path}`;
}

export function getPublicWebUrl(requestUrl?: string, baseUrl?: string): string | undefined {
  const base = baseUrl || getConfiguredPublicOrigin();
  if (base) return normalizeBaseUrl(base);
  // Backend-only self-hosters (no PUBLIC_WEB_URL, no bundled frontend) should
  // still produce usable links by pointing at the hosted UI.
  if (!hasLocalFrontend()) return HOSTED_UI_FALLBACK_ORIGIN;
  if (requestUrl) return normalizeBaseUrl(new URL(requestUrl).origin);
  return undefined;
}

export async function getOrganizationSlug(
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) return null;
  return getWorkspaceProvider().getOrgSlug(organizationId);
}

export interface EntityInfo {
  ownerSlug: string;
  entityType: string;
  slug: string;
  parentType?: string | null;
  parentSlug?: string | null;
}

/**
 * Build URL to view an entity
 * Pattern: /{ownerSlug}/{type}/{slug}/[{type}/{slug}]
 */
export function buildEntityUrl(info: EntityInfo, baseUrl?: string): string {
  const segments: string[] = [];
  if (info.parentType && info.parentSlug) {
    segments.push(`${info.parentType}/${info.parentSlug}`);
  }
  segments.push(`${info.entityType}/${info.slug}`);
  return withBaseUrl(normalizeBaseUrl(baseUrl), `/${info.ownerSlug}/${segments.join('/')}`);
}

/**
 * Build URL to view entity watchers
 */
export function buildWatchersUrl(info: EntityInfo, baseUrl?: string): string {
  return `${buildEntityUrl(info, baseUrl)}/watchers`;
}

/**
 * Build URL to view connections (data sources) for a workspace.
 *
 * - No connectorKey → list page: `/{ownerSlug}/connectors`
 * - With connectorKey → detail page: `/{ownerSlug}/connectors/{connectorKey}`
 * - `query.install` adds `?install=…` (useful with or without a connector key)
 */
export function buildConnectionsUrl(
  ownerSlug: string,
  baseUrl?: string,
  connectorKey?: string | null,
  query?: { install?: string } | null
): string {
  const detailSegment = connectorKey ? `/${connectorKey}` : '';
  const params = new URLSearchParams();
  if (query?.install) params.set('install', query.install);
  const queryString = params.toString();
  const queryPart = queryString ? `?${queryString}` : '';
  return withBaseUrl(
    normalizeBaseUrl(baseUrl),
    `/${ownerSlug}/connectors${detailSegment}${queryPart}`
  );
}

/**
 * Build permalink URL for a single knowledge item
 * Pattern: /{ownerSlug}/events/{eventId}
 */
export function buildEventPermalink(ownerSlug: string, eventId: number, baseUrl?: string): string {
  return withBaseUrl(normalizeBaseUrl(baseUrl), `/${ownerSlug}/events/${eventId}`);
}

/**
 * Build URL to view entity content
 */
export function buildContentUrl(
  info: EntityInfo,
  filters?: {
    platform?: string;
    since?: string;
    until?: string;
    connectionId?: number;
  },
  baseUrl?: string
): string {
  const basePath = `${buildEntityUrl(info, baseUrl)}/content`;

  if (!filters) return basePath;

  const params = new URLSearchParams();
  if (filters.platform) params.set('platform', filters.platform);
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  if (filters.connectionId) params.set('connection_id', String(filters.connectionId));

  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}
