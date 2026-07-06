/**
 * Shared view-URL enrichment helpers.
 *
 * Tool responses link back to the web UI by combining the org slug, the
 * public web origin, and a url-builder function. That triplet used to be
 * re-derived inline at every call site; these helpers centralize it.
 */

import {
  buildEntityUrl,
  buildResourcePermalink,
  type EntityInfo,
  getOrganizationSlug,
  getPublicWebUrl,
} from '../utils/url-builder';
import type { ToolContext } from './registry';

type UrlContext = Pick<ToolContext, 'organizationId' | 'requestUrl' | 'baseUrl'>;

interface OrgUrlContext {
  ownerSlug: string | null;
  baseUrl: string | undefined;
}

/** Resolve the org-slug + public-base-URL pair used for view-URL enrichment. */
export async function getOrgUrlContext(ctx: UrlContext): Promise<OrgUrlContext> {
  return {
    ownerSlug: await getOrganizationSlug(ctx.organizationId),
    baseUrl: getPublicWebUrl(ctx.requestUrl, ctx.baseUrl),
  };
}

interface ViewEntityRow {
  entity_type: string;
  slug: string;
  parent_entity_type?: string | null;
  parent_slug?: string | null;
}

/** Map a DB entity row to the `EntityInfo` shape url-builder expects. */
export function toEntityInfo(ownerSlug: string, entity: ViewEntityRow): EntityInfo {
  return {
    ownerSlug,
    entityType: entity.entity_type,
    slug: entity.slug,
    parentType: entity.parent_entity_type ?? null,
    parentSlug: entity.parent_slug ?? null,
  };
}

/** Public view URL for an entity, or undefined when the org has no slug. */
export async function buildEntityViewUrl(
  ctx: UrlContext,
  entity: ViewEntityRow
): Promise<string | undefined> {
  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  if (!ownerSlug) return undefined;
  return buildEntityUrl(toEntityInfo(ownerSlug, entity), baseUrl);
}

/** Permalink for a knowledge event, or undefined when the org has no slug. */
export async function buildEventViewUrl(
  ctx: UrlContext,
  eventId: number
): Promise<string | undefined> {
  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  return buildResourcePermalink(ownerSlug, { kind: 'event', eventId }, baseUrl);
}
