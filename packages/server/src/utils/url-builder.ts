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
  // Backend-only self-hosters (no PUBLIC_GATEWAY_URL, no bundled frontend) should
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
 * A slice of the memory/events log to permalink into. One discriminated union
 * so every caller (approval_url, notification resourceUrl, agent output) picks a
 * *kind* and the URL shape is decided in exactly one place — no caller
 * hand-assembles `?content_ids=`/`?run_ids=`/`?feed_ids=` strings.
 *
 * Which kind to use:
 *  - `run`   — the link's identity is one execution (an operation approval, a
 *    watcher/scheduled run). Survives the supersede chain by construction: a
 *    run's events share one run_id and run-scoped reads were never masked by
 *    `superseded_by IS NULL`.
 *  - `event` — a point in the log (a specific card). Read-side chain resolution
 *    (get_content) resolves a superseded id to its full lineage, so a frozen
 *    event permalink still lands even after it's superseded.
 *  - `feed`  — a channel / conversational stream (all activity in #leads).
 */
export type MemoryResource =
  | { kind: 'run'; runId: number }
  | { kind: 'event'; eventId: number }
  | { kind: 'feed'; feedId: number };

/** The `?param=value` query for a {@link MemoryResource}. */
function memoryResourceQuery(resource: MemoryResource): string {
  switch (resource.kind) {
    case 'run':
      return `run_ids=${resource.runId}`;
    case 'event':
      return `content_ids=${resource.eventId}`;
    case 'feed':
      return `feed_ids=${resource.feedId}`;
  }
}

/**
 * Build a permalink into the memory/events log for a {@link MemoryResource}.
 * Pattern: /{ownerSlug}/memory?{run_ids|content_ids|feed_ids}={id}
 *
 * This is the ONE place a memory permalink is assembled. `ownerSlug` empty →
 * returns undefined (no org context, can't build a usable link).
 */
export function buildResourcePermalink(
  ownerSlug: string | null | undefined,
  resource: MemoryResource,
  baseUrl?: string
): string | undefined {
  if (!ownerSlug) return undefined;
  return withBaseUrl(
    normalizeBaseUrl(baseUrl),
    `/${ownerSlug}/memory?${memoryResourceQuery(resource)}`
  );
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
