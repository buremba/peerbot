/**
 * URL Builder for Frontend Links
 *
 * Generates consistent URLs for the frontend application.
 */

import { AGENT_ERRORS, type AgentErrorCode } from '@lobu/core';
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

/**
 * Build the agent's model/provider settings URL —
 * `<webOrigin>/<orgSlug>/agents/<agentId>/settings` — the CTA target for
 * provider/model errors (connect a provider, choose a model, reconnect
 * credentials). Returns null when any required piece is missing; callers fall
 * back to a non-linked message.
 *
 * The `/settings` suffix is load-bearing: the bare `/agents/<id>` route
 * redirects to the agent's Chat page (`redirectBareAgentToChat`), which is the
 * surface the user just failed on — not where the model is fixed. `/settings`
 * lands on the tab that hosts the models allow-list editor, so the CTA drops
 * the admin exactly where they pick a model / connect a provider.
 *
 * `publicGatewayUrl` is the gateway base, which in embedded mode carries the
 * `/lobu` path suffix (the gateway is mounted at `/lobu` under the web app).
 * Admin UI routes live at the web origin (`/<slug>/agents/...`) NOT under
 * `/lobu`, so a trailing `/lobu` is stripped before composing the link.
 */
export async function buildAgentSettingsUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  agentId: string | undefined
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId || !agentId) return null;
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const webOrigin = publicGatewayUrl.replace(/\/+$/, '').replace(/\/lobu$/, '');
  return `${webOrigin}/${slug}/agents/${encodeURIComponent(agentId)}/settings`;
}

/**
 * Build the org's "connect a provider" URL — `<webOrigin>/<orgSlug>/
 * inference-providers/new` — the CTA target for errors whose fix is *connecting
 * a provider* (missing/expired credentials, unroutable provider), as opposed to
 * *picking a model* on an agent (which is {@link buildAgentSettingsUrl}). This
 * is the same live route the pre-enqueue model-provider preflight links to.
 *
 * Optional `provider`/`model` prefill the connect form so the user lands on the
 * exact provider to wire up. Returns null when any required piece is missing;
 * callers fall back to a non-linked message. The `/lobu` embedded-mode suffix is
 * stripped like the sibling builders.
 */
export async function buildProviderConnectUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  prefill?: { provider?: string; model?: string }
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId) return null;
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const webOrigin = publicGatewayUrl.replace(/\/+$/, '').replace(/\/lobu$/, '');
  const url = new URL(
    `/${encodeURIComponent(slug)}/inference-providers/new`,
    `${webOrigin}/`
  );
  if (prefill?.provider) url.searchParams.set('provider', prefill.provider);
  if (prefill?.model) url.searchParams.set('model', prefill.model);
  return url.toString();
}

export interface RenderedAgentError {
  /** User-facing body (no link appended — carry `ctaUrl` separately). */
  text: string;
  /** Resolved CTA link, or null when the code has no CTA / it couldn't build. */
  ctaUrl: string | null;
  /** Button/link label for `ctaUrl`. */
  ctaLabel?: string;
  /** True when this code is intentionally silent (no user message emitted). */
  silent: boolean;
}

/**
 * Per-CTA-kind URL resolvers, injected so `renderAgentError` stays free of the
 * per-surface plumbing (org slug / agent id / public origin live in the caller).
 * The catalog's two actionable CTA kinds land on DIFFERENT pages:
 *   - `agent-settings`   → the agent's model/provider settings (pick a model).
 *   - `provider-connect` → the org's connect-a-provider page (wire credentials).
 * A kind whose resolver is absent (or resolves null) renders with no button.
 */
export interface AgentErrorCtaResolvers {
  'agent-settings'?: () => Promise<string | null>;
  'provider-connect'?: () => Promise<string | null>;
}

/**
 * THE renderer: turn an `AgentErrorCode` + the raw provider message into the
 * user-facing body and a resolved CTA link. Every surface — Slack/Telegram
 * bridge, browser SSE — calls this so the same error reads identically
 * everywhere.
 *
 * The body is deliberately thin: for provider errors the catalog has no text, so
 * we relay the provider's OWN message verbatim (it already says the useful thing
 * — the reset time, the bad model id). For errors we synthesize (worker/config),
 * the catalog carries the text. The code's only job is to pick the CTA *kind*;
 * this resolves that kind to a concrete URL via the matching injected resolver,
 * so "connect a provider" and "pick a model" land on their own pages instead of
 * collapsing to one.
 */
export async function renderAgentError(
  code: AgentErrorCode,
  providerMessage: string | undefined,
  resolvers: AgentErrorCtaResolvers
): Promise<RenderedAgentError> {
  const spec = AGENT_ERRORS[code];
  const text = spec.message ?? providerMessage ?? '';
  let ctaUrl: string | null = null;
  const resolve =
    spec.cta === 'agent-settings' || spec.cta === 'provider-connect'
      ? resolvers[spec.cta]
      : undefined;
  if (resolve) {
    ctaUrl = await resolve().catch(() => null);
  }
  return {
    text,
    ctaUrl,
    ctaLabel: spec.ctaLabel,
    silent: spec.silent ?? false,
  };
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
