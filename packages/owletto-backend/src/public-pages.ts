import { getDb } from './db/client';
import type { Env } from './index';
import type { ToolContext } from './tools/registry';
import { type ResolvePathResult, resolvePath } from './tools/resolve_path';
import {
  batchLoadRelationships,
  listEntities,
  type RelationshipColumnSpec,
} from './utils/entity-management';
import { getConfiguredPublicOrigin } from './utils/public-origin';
import { RESERVED_PATHS } from './utils/reserved';

interface PublicOrganization {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logo: string | null;
}

interface PublicEntityTypeDetails {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  entity_count: number;
  metadata_schema: Record<string, unknown> | null;
}

interface PublicEntityListItem {
  id: number;
  entity_type: string;
  name: string;
  slug: string;
  parent_id: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  total_content: number;
  active_connections: number;
  watchers_count: number;
  children_count: number;
}

interface PublicEntityListResult {
  entities: PublicEntityListItem[];
  metadata: {
    page_size: number;
    has_more: boolean;
    total_count: number;
    limit: number;
    offset: number;
    sort_by: string;
    sort_order: 'asc' | 'desc';
  };
}

export interface PublicPageBootstrap {
  path: string;
  ownerSlug: string;
  kind: 'workspace' | 'entity' | 'entity-type';
  resolvedPath?: ResolvePathResult;
  ownerResolvedPath?: ResolvePathResult;
  entityTypeSlug?: string;
  entityType?: PublicEntityTypeDetails | null;
  entityList?: PublicEntityListResult;
}

interface PublicPageModel {
  status: number;
  title: string;
  description: string;
  canonicalUrl: string;
  robots: string;
  openGraphImage: string | null;
  structuredData: Array<Record<string, unknown>>;
  bodyHtml: string;
  bootstrap: PublicPageBootstrap;
  cacheControl: string;
}

interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

const PUBLIC_HTML_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';
const PUBLIC_XML_CACHE_CONTROL = 'public, max-age=1800, stale-while-revalidate=86400';
const PUBLIC_LIST_LIMIT = 50;
const PUBLIC_APP_ROUTE_PREFIXES = new Set([
  'agents',
  'connectors',
  'events',
  'members',
  'watchers',
]);

function getPublicOrigin(requestUrl: string): string {
  return getConfiguredPublicOrigin() ?? new URL(requestUrl).origin;
}

function buildToolContext(requestUrl: string, organizationId: string): ToolContext {
  return {
    organizationId,
    userId: null,
    isAuthenticated: false,
    requestUrl,
    baseUrl: getPublicOrigin(requestUrl),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sentenceCase(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCountLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function snippet(value: string | null | undefined, maxLength = 180): string {
  if (!value) return '';
  return truncateText(collapseWhitespace(stripTags(value)), maxLength);
}

function absoluteUrl(path: string, origin: string): string {
  return new URL(path, origin).toString();
}

function buildEntityUrl(
  ownerSlug: string,
  segments: Array<{ entity_type: string; slug: string }>
): string {
  const entityPath = segments.flatMap((segment) => [segment.entity_type, segment.slug]).join('/');
  return `/${ownerSlug}/${entityPath}`;
}

function buildEntityUrlFromListItem(ownerSlug: string, entity: PublicEntityListItem): string {
  if (entity.parent_slug && entity.parent_entity_type) {
    return buildEntityUrl(ownerSlug, [
      { entity_type: entity.parent_entity_type, slug: entity.parent_slug },
      { entity_type: entity.entity_type, slug: entity.slug },
    ]);
  }
  return buildEntityUrl(ownerSlug, [{ entity_type: entity.entity_type, slug: entity.slug }]);
}

function findMetadataDescription(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata || typeof metadata !== 'object') return null;

  for (const key of ['description', 'summary', 'tagline', 'about', 'content']) {
    const value = metadata[key];
    if (typeof value === 'string' && collapseWhitespace(value)) {
      return collapseWhitespace(value);
    }
  }

  return null;
}

function renderStatList(stats: Array<{ label: string; value: string }>): string {
  return `
    <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      ${stats
        .map(
          (stat) => `
            <div class="rounded-xl border border-border bg-muted/30 p-4">
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">${escapeHtml(stat.label)}</dt>
              <dd class="mt-1.5 text-lg font-bold text-foreground">${escapeHtml(stat.value)}</dd>
            </div>
          `
        )
        .join('')}
    </dl>
  `;
}

function renderLinkList(
  items: Array<{ href: string; title: string; meta?: string | null; body?: string | null }>
): string {
  if (items.length === 0) {
    return '<p class="text-muted-foreground">No public items yet.</p>';
  }

  return `
    <ul class="m-0 grid list-none gap-3 p-0">
      ${items
        .map(
          (item) => `
            <li class="m-0">
              <a class="block rounded-xl border border-border bg-card p-4 text-foreground no-underline transition-colors hover:border-muted-foreground/40 hover:bg-muted/30" href="${escapeAttribute(item.href)}">
                <strong class="block text-base font-semibold text-foreground">${escapeHtml(item.title)}</strong>
                ${item.meta ? `<span class="mt-1.5 block text-sm text-muted-foreground">${escapeHtml(item.meta)}</span>` : ''}
                ${item.body ? `<span class="mt-2 block leading-relaxed text-foreground/80">${escapeHtml(item.body)}</span>` : ''}
              </a>
            </li>
          `
        )
        .join('')}
    </ul>
  `;
}

function renderPublicShell(
  heading: string,
  eyebrow: string,
  description: string,
  sections: Array<{ title: string; html: string }>,
  breadcrumbs: Array<{ label: string; href?: string }> = []
): string {
  const breadcrumbHtml =
    breadcrumbs.length > 0
      ? `<nav class="mb-5 flex flex-wrap gap-2 text-sm text-muted-foreground" aria-label="Breadcrumb">${breadcrumbs
          .map((crumb, index) =>
            crumb.href
              ? `<a class="text-teal-700 no-underline hover:underline dark:text-teal-400" href="${escapeAttribute(crumb.href)}">${escapeHtml(crumb.label)}</a>${
                  index < breadcrumbs.length - 1
                    ? '<span class="text-muted-foreground/60">/</span>'
                    : ''
                }`
              : `<span aria-current="page">${escapeHtml(crumb.label)}</span>`
          )
          .join('')}</nav>`
      : '';

  return `
    <div class="mx-auto max-w-6xl px-4 pb-16 pt-8 text-foreground sm:px-5 sm:pb-20 sm:pt-12">
      ${breadcrumbHtml}
      <header class="mb-8">
        <p class="mb-3 text-xs font-bold uppercase tracking-wider text-teal-700 dark:text-teal-400">${escapeHtml(eyebrow)}</p>
        <h1 class="text-3xl font-semibold text-foreground">${escapeHtml(heading)}</h1>
        <p class="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">${escapeHtml(description)}</p>
      </header>
      ${sections
        .map(
          (section) => `
            <section class="mt-8 border-t border-border pt-5">
              <h2 class="mb-4 text-lg font-semibold text-foreground">${escapeHtml(section.title)}</h2>
              ${section.html}
            </section>
          `
        )
        .join('')}
    </div>
  `;
}

function buildStructuredBreadcrumbs(
  origin: string,
  breadcrumbs: Array<{ label: string; href: string }>
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      item: absoluteUrl(crumb.href, origin),
    })),
  };
}

async function getPublicOrganizationBySlug(slug: string): Promise<PublicOrganization | null> {
  const sql = getDb();
  const rows = await sql.unsafe<PublicOrganization>(
    `
      SELECT
        id,
        slug,
        name,
        description,
        logo
      FROM "organization"
      WHERE slug = $1
        AND visibility = 'public'
      LIMIT 1
    `,
    [slug]
  );
  return rows[0] ?? null;
}

async function getPublicEntityType(
  organizationId: string,
  slug: string
): Promise<PublicEntityTypeDetails | null> {
  const sql = getDb();
  const rows = await sql.unsafe<PublicEntityTypeDetails>(
    `
      SELECT
        et.id,
        et.slug,
        et.name,
        et.description,
        et.icon,
        et.color,
        et.metadata_schema,
        (
          SELECT COUNT(*)::int
          FROM entities e
          WHERE e.organization_id = et.organization_id
            AND e.entity_type = et.slug
            AND e.deleted_at IS NULL
        ) AS entity_count
      FROM entity_types et
      WHERE et.organization_id = $1
        AND et.slug = $2
        AND et.deleted_at IS NULL
      LIMIT 1
    `,
    [organizationId, slug]
  );
  return rows[0] ?? null;
}

async function getPublicEntityTypeList(
  organizationId: string,
  env: Env,
  requestUrl: string,
  entityTypeSlug: string
): Promise<PublicEntityListResult> {
  const sql = getDb();
  const ctx = buildToolContext(requestUrl, organizationId);

  const [result, entityTypeRow] = await Promise.all([
    listEntities(
      {
        entity_type: entityTypeSlug,
        limit: PUBLIC_LIST_LIMIT,
        offset: 0,
        sort_by: 'created_at',
        sort_order: 'desc',
      },
      env,
      ctx
    ),
    sql`SELECT metadata_schema FROM entity_types WHERE slug = ${entityTypeSlug} AND organization_id = ${organizationId} AND deleted_at IS NULL LIMIT 1`.then(
      (r) => r[0] ?? null
    ),
  ]);

  const schema = entityTypeRow?.metadata_schema as Record<string, unknown> | null;
  const relSpecs = (schema?.['x-table-relationships'] ?? []) as RelationshipColumnSpec[];
  const entityIds = result.entities.map((e) => e.id);
  const relMap =
    relSpecs.length > 0 && entityIds.length > 0
      ? await batchLoadRelationships(entityIds, relSpecs, organizationId)
      : new Map();

  return {
    entities: result.entities.map((entity) => ({
      id: entity.id,
      entity_type: entity.entity_type,
      name: entity.name,
      slug: entity.slug,
      parent_id: entity.parent_id ?? null,
      parent_name: entity.parent_name ?? null,
      parent_slug: entity.parent_slug ?? null,
      parent_entity_type: entity.parent_entity_type ?? null,
      metadata: entity.metadata ?? {},
      created_at: new Date(entity.created_at).toISOString(),
      total_content: Number(entity.total_content) || 0,
      active_connections: Number(entity.active_connections) || 0,
      watchers_count: Number(entity.watchers_count) || 0,
      children_count: Number(entity.children_count) || 0,
      ...(relMap.size > 0 && relMap.has(entity.id) ? { relationships: relMap.get(entity.id) } : {}),
    })),
    metadata: {
      page_size: result.entities.length,
      has_more: result.hasMore,
      total_count: result.totalCount,
      limit: result.limit,
      offset: result.offset,
      sort_by: result.sortBy,
      sort_order: result.sortOrder,
    },
  };
}

function buildWorkspaceModel(
  organization: PublicOrganization,
  resolvedPath: ResolvePathResult,
  requestUrl: string
): PublicPageModel {
  const origin = getPublicOrigin(requestUrl);
  const canonicalPath = `/${organization.slug}`;
  const canonicalUrl = absoluteUrl(canonicalPath, origin);
  const bootstrap = resolvedPath.bootstrap;
  const summary = bootstrap?.summary;
  const description = truncateText(
    organization.description?.trim() ||
      `Public workspace for ${organization.name} with ${formatCountLabel(
        summary?.total_content ?? 0,
        'knowledge item'
      )}, ${formatCountLabel(summary?.active_connections ?? 0, 'connector')}, and ${formatCountLabel(
        summary?.watchers_count ?? 0,
        'watcher'
      )}.`,
    180
  );

  const sections = [
    {
      title: 'Workspace Summary',
      html: renderStatList([
        { label: 'Knowledge', value: formatCountLabel(summary?.total_content ?? 0, 'item') },
        {
          label: 'Connectors',
          value: formatCountLabel(summary?.active_connections ?? 0, 'active connector'),
        },
        {
          label: 'Watchers',
          value: formatCountLabel(summary?.watchers_count ?? 0, 'active watcher'),
        },
      ]),
    },
    {
      title: 'Entity Types',
      html: renderLinkList(
        (bootstrap?.entity_types ?? []).map((entityType) => ({
          href: `/${organization.slug}/${entityType.slug}`,
          title: entityType.name,
          meta: formatCountLabel(entityType.entity_count, 'entity'),
          body: entityType.description ? snippet(entityType.description, 140) : null,
        }))
      ),
    },
    {
      title: 'Recent Knowledge',
      html: renderLinkList(
        (bootstrap?.recent_content ?? []).map((item) => ({
          href: item.source_url || canonicalPath,
          title: item.title || item.entity_name || `Knowledge item #${item.id}`,
          meta: [item.platform, item.author_name, formatDate(item.occurred_at || item.created_at)]
            .filter(Boolean)
            .join(' • '),
          body: snippet(item.text_content, 180),
        }))
      ),
    },
  ];

  return {
    status: 200,
    title: `${organization.name} | Owletto`,
    description,
    canonicalUrl,
    robots: 'index,follow,max-image-preview:large',
    openGraphImage: organization.logo,
    structuredData: [
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: organization.name,
        description,
        url: canonicalUrl,
        logo: organization.logo || undefined,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${organization.name} workspace`,
        description,
        url: canonicalUrl,
      },
    ],
    bodyHtml: renderPublicShell(organization.name, 'Public Workspace', description, sections),
    bootstrap: {
      path: canonicalPath,
      ownerSlug: organization.slug,
      kind: 'workspace',
      resolvedPath,
    },
    cacheControl: PUBLIC_HTML_CACHE_CONTROL,
  };
}

function buildEntityTypeModel(params: {
  organization: PublicOrganization;
  entityType: PublicEntityTypeDetails;
  entityList: PublicEntityListResult;
  ownerResolvedPath: ResolvePathResult;
  requestUrl: string;
}): PublicPageModel {
  const origin = getPublicOrigin(params.requestUrl);
  const canonicalPath = `/${params.organization.slug}/${params.entityType.slug}`;
  const canonicalUrl = absoluteUrl(canonicalPath, origin);
  const countLabel = formatCountLabel(params.entityType.entity_count, 'entity');
  const description = truncateText(
    params.entityType.description?.trim() ||
      `${params.entityType.name} in ${params.organization.name}. ${countLabel} publicly visible in this workspace.`,
    180
  );

  const sections = [
    {
      title: 'Overview',
      html: renderStatList([
        { label: 'Entities', value: countLabel },
        {
          label: 'Shown',
          value: formatCountLabel(params.entityList.entities.length, 'entity'),
        },
      ]),
    },
    {
      title: `${params.entityType.name} Directory`,
      html: renderLinkList(
        params.entityList.entities.map((entity) => ({
          href: buildEntityUrlFromListItem(params.organization.slug, entity),
          title: entity.name,
          meta: [
            formatCountLabel(entity.total_content, 'knowledge item'),
            entity.parent_name ? `Parent: ${entity.parent_name}` : null,
          ]
            .filter(Boolean)
            .join(' • '),
          body:
            findMetadataDescription(entity.metadata) ||
            snippet((entity.metadata?.domain as string | undefined) ?? '', 120) ||
            null,
        }))
      ),
    },
  ];

  return {
    status: 200,
    title: `${params.entityType.name} | ${params.organization.name} | Owletto`,
    description,
    canonicalUrl,
    robots: 'index,follow,max-image-preview:large',
    openGraphImage: params.organization.logo,
    structuredData: [
      buildStructuredBreadcrumbs(origin, [
        { label: params.organization.name, href: `/${params.organization.slug}` },
        { label: params.entityType.name, href: canonicalPath },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${params.entityType.name} in ${params.organization.name}`,
        description,
        url: canonicalUrl,
      },
    ],
    bodyHtml: renderPublicShell(
      params.entityType.name,
      `Public ${sentenceCase(params.entityType.slug)} Listing`,
      description,
      sections,
      [
        { label: params.organization.name, href: `/${params.organization.slug}` },
        { label: params.entityType.name },
      ]
    ),
    bootstrap: {
      path: canonicalPath,
      ownerSlug: params.organization.slug,
      kind: 'entity-type',
      ownerResolvedPath: params.ownerResolvedPath,
      entityTypeSlug: params.entityType.slug,
      entityType: params.entityType,
      entityList: params.entityList,
    },
    cacheControl: PUBLIC_HTML_CACHE_CONTROL,
  };
}

function buildEntityModel(
  organization: PublicOrganization,
  resolvedPath: ResolvePathResult,
  requestUrl: string
): PublicPageModel {
  if (!resolvedPath.entity) {
    throw new Error('Entity page requires a resolved entity');
  }

  const origin = getPublicOrigin(requestUrl);
  const canonicalPath = buildEntityUrl(
    organization.slug,
    resolvedPath.path.map((item) => ({ entity_type: item.entity_type, slug: item.slug }))
  );
  const canonicalUrl = absoluteUrl(canonicalPath, origin);
  const entity = resolvedPath.entity;
  const description = truncateText(
    findMetadataDescription(entity.metadata) ||
      `${entity.name} in ${organization.name}. ${formatCountLabel(
        entity.total_content,
        'knowledge item'
      )}, ${formatCountLabel(entity.active_connections, 'connector')}, and ${formatCountLabel(
        entity.watchers_count,
        'watcher'
      )}.`,
    180
  );

  const metadataEntries = Object.entries(entity.metadata || {})
    .filter(([, value]) => {
      if (value == null) return false;
      if (typeof value === 'string') return collapseWhitespace(value).length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object')
        return Object.keys(value as Record<string, unknown>).length > 0;
      return true;
    })
    .slice(0, 8);

  const sections = [
    {
      title: 'Overview',
      html: renderStatList([
        { label: 'Knowledge', value: formatCountLabel(entity.total_content, 'item') },
        {
          label: 'Connectors',
          value: formatCountLabel(entity.active_connections, 'active connector'),
        },
        { label: 'Watchers', value: formatCountLabel(entity.watchers_count, 'active watcher') },
      ]),
    },
    {
      title: 'Details',
      html:
        metadataEntries.length > 0
          ? `<dl class="grid gap-3">${metadataEntries
              .map(
                ([key, value]) => `
                  <div class="rounded-xl border border-border bg-card p-4">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">${escapeHtml(sentenceCase(key))}</dt>
                    <dd class="mt-2 leading-relaxed text-foreground">${escapeHtml(
                      Array.isArray(value)
                        ? value.join(', ')
                        : typeof value === 'object'
                          ? JSON.stringify(value)
                          : String(value)
                    )}</dd>
                  </div>
                `
              )
              .join('')}</dl>`
          : '<p class="text-muted-foreground">No additional public metadata is available for this entity.</p>',
    },
    {
      title: 'Child Entities',
      html: renderLinkList(
        resolvedPath.children.map((child) => ({
          href: buildEntityUrl(organization.slug, [
            ...resolvedPath.path.map((segment) => ({
              entity_type: segment.entity_type,
              slug: segment.slug,
            })),
            { entity_type: child.entity_type, slug: child.slug },
          ]),
          title: child.name,
          meta: child.market ? child.market.toUpperCase() : null,
          body:
            child.content_count > 0
              ? formatCountLabel(child.content_count, 'knowledge item')
              : null,
        }))
      ),
    },
    {
      title: 'Recent Knowledge',
      html: renderLinkList(
        (resolvedPath.bootstrap?.recent_content ?? []).map((item) => ({
          href: item.source_url || canonicalPath,
          title: item.title || `Knowledge item #${item.id}`,
          meta: [item.platform, item.author_name, formatDate(item.occurred_at || item.created_at)]
            .filter(Boolean)
            .join(' • '),
          body: snippet(item.text_content, 180),
        }))
      ),
    },
  ];

  return {
    status: 200,
    title: `${entity.name} | ${organization.name} | Owletto`,
    description,
    canonicalUrl,
    robots: 'index,follow,max-image-preview:large',
    openGraphImage: organization.logo,
    structuredData: [
      buildStructuredBreadcrumbs(origin, [
        { label: organization.name, href: `/${organization.slug}` },
        ...resolvedPath.path.map((item, index) => ({
          label: item.name,
          href: buildEntityUrl(
            organization.slug,
            resolvedPath.path.slice(0, index + 1).map((segment) => ({
              entity_type: segment.entity_type,
              slug: segment.slug,
            }))
          ),
        })),
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'Thing',
        name: entity.name,
        description,
        url: canonicalUrl,
      },
    ],
    bodyHtml: renderPublicShell(
      entity.name,
      sentenceCase(entity.entity_type),
      description,
      sections,
      [
        { label: organization.name, href: `/${organization.slug}` },
        ...resolvedPath.path.slice(0, -1).map((item, index) => ({
          label: item.name,
          href: buildEntityUrl(
            organization.slug,
            resolvedPath.path.slice(0, index + 1).map((segment) => ({
              entity_type: segment.entity_type,
              slug: segment.slug,
            }))
          ),
        })),
        { label: entity.name },
      ]
    ),
    bootstrap: {
      path: canonicalPath,
      ownerSlug: organization.slug,
      kind: 'entity',
      resolvedPath,
    },
    cacheControl: PUBLIC_HTML_CACHE_CONTROL,
  };
}

function buildNotFoundModel(
  organization: PublicOrganization,
  requestUrl: string,
  path: string
): PublicPageModel {
  const origin = getPublicOrigin(requestUrl);
  const canonicalUrl = absoluteUrl(path, origin);
  const description = `The public page at ${path} could not be found in ${organization.name}.`;

  return {
    status: 404,
    title: `Not Found | ${organization.name} | Owletto`,
    description,
    canonicalUrl,
    robots: 'noindex,nofollow',
    openGraphImage: organization.logo,
    structuredData: [],
    bodyHtml: renderPublicShell('Page Not Found', '404', description, [
      {
        title: 'Next Step',
        html: `<p><a class="ow-link-card" href="/${escapeAttribute(organization.slug)}">Return to ${escapeHtml(
          organization.name
        )}</a></p>`,
      },
    ]),
    bootstrap: {
      path,
      ownerSlug: organization.slug,
      kind: 'workspace',
    },
    cacheControl: 'public, max-age=60, stale-while-revalidate=300',
  };
}

function injectIntoTemplate(templateHtml: string, model: PublicPageModel): string {
  const headTags = [
    `<meta name="description" content="${escapeAttribute(model.description)}" />`,
    `<meta name="robots" content="${escapeAttribute(model.robots)}" />`,
    `<link rel="canonical" href="${escapeAttribute(model.canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeAttribute(model.title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(model.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttribute(model.canonicalUrl)}" />`,
    `<meta name="twitter:card" content="${model.openGraphImage ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeAttribute(model.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(model.description)}" />`,
    model.openGraphImage
      ? `<meta property="og:image" content="${escapeAttribute(model.openGraphImage)}" />`
      : '',
    model.openGraphImage
      ? `<meta name="twitter:image" content="${escapeAttribute(model.openGraphImage)}" />`
      : '',
    ...model.structuredData.map(
      (item) => `<script type="application/ld+json">${serializeForScript(item)}</script>`
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const withTitle = templateHtml.replace(
    /<title>.*?<\/title>/is,
    `<title>${escapeHtml(model.title)}</title>`
  );
  const withHead = withTitle.includes('</head>')
    ? withTitle.replace('</head>', `${headTags}\n</head>`)
    : `${withTitle}${headTags}`;
  const withRoot = withHead.replace(
    /<div id="root"><\/div>/i,
    `<div id="ssr-hydrate-shell" data-public-ssr>${model.bodyHtml}</div><div id="root"></div>`
  );
  const bootstrapScript = `<script>window.__OWLETTO_PUBLIC_BOOTSTRAP__=${serializeForScript(
    model.bootstrap
  )};</script>`;

  return withRoot.includes('</body>')
    ? withRoot.replace('</body>', `${bootstrapScript}\n</body>`)
    : `${withRoot}${bootstrapScript}`;
}

function stripSubdomainPrefix(path: string, sub: string | null | undefined): string {
  if (!sub) return path;
  const prefix = `/${sub}`;
  if (path === prefix) return '/';
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return path;
}

function applyBootstrapStrip<T extends PublicPageModel>(model: T, sub: string | null | undefined): T {
  if (!sub) return model;
  return {
    ...model,
    bootstrap: { ...model.bootstrap, path: stripSubdomainPrefix(model.bootstrap.path, sub) },
  };
}

export async function buildPublicPageModel(
  path: string,
  env: Env,
  requestUrl: string,
  subdomainOrg?: string | null
): Promise<PublicPageModel | null> {
  const rawPath = `/${path.replace(/^\/+|\/+$/g, '')}`;
  // On a subdomain host, synthesize the owner segment when the request path
  // doesn't already carry it, so downstream segment-based routing works
  // identically to the canonical-host (`app.lobu.ai/{org}/...`) form.
  const normalizedPath =
    subdomainOrg && rawPath !== `/${subdomainOrg}` && !rawPath.startsWith(`/${subdomainOrg}/`)
      ? `/${subdomainOrg}${rawPath === '/' ? '' : rawPath}`
      : rawPath;
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const ownerSlug = segments[0]!;
  if (ownerSlug.startsWith('@')) return null;
  if (RESERVED_PATHS.includes(ownerSlug)) return null;
  if (segments[1] && PUBLIC_APP_ROUTE_PREFIXES.has(segments[1])) return null;

  const organization = await getPublicOrganizationBySlug(ownerSlug);
  if (!organization) return null;

  const toolCtx = buildToolContext(requestUrl, organization.id);

  try {
    if (segments.length === 1) {
      const resolvedPath = await resolvePath(
        { path: normalizedPath, include_bootstrap: true },
        env,
        toolCtx
      );
      return applyBootstrapStrip(
        buildWorkspaceModel(organization, resolvedPath, requestUrl),
        subdomainOrg
      );
    }

    if (segments.length === 2) {
      const entityType = await getPublicEntityType(organization.id, segments[1]!);
      if (!entityType) {
        return applyBootstrapStrip(
          buildNotFoundModel(organization, requestUrl, normalizedPath),
          subdomainOrg
        );
      }
      const [ownerResolvedPath, entityList] = await Promise.all([
        resolvePath({ path: `/${organization.slug}`, include_bootstrap: true }, env, toolCtx),
        getPublicEntityTypeList(organization.id, env, requestUrl, entityType.slug),
      ]);
      return applyBootstrapStrip(
        buildEntityTypeModel({
          organization,
          entityType,
          entityList,
          ownerResolvedPath,
          requestUrl,
        }),
        subdomainOrg
      );
    }

    // If any segment after the owner is a known app-route prefix (e.g. watchers, agents),
    // this is a deep SPA route — let the client handle it entirely.
    const entitySegments = segments.slice(1);
    for (let i = 0; i < entitySegments.length; i += 2) {
      if (PUBLIC_APP_ROUTE_PREFIXES.has(entitySegments[i]!)) {
        return null;
      }
    }

    if ((segments.length - 1) % 2 === 0) {
      const resolvedPath = await resolvePath(
        { path: normalizedPath, include_bootstrap: true },
        env,
        toolCtx
      );
      return applyBootstrapStrip(
        buildEntityModel(organization, resolvedPath, requestUrl),
        subdomainOrg
      );
    }

    return applyBootstrapStrip(
      buildNotFoundModel(organization, requestUrl, normalizedPath),
      subdomainOrg
    );
  } catch {
    return applyBootstrapStrip(
      buildNotFoundModel(organization, requestUrl, normalizedPath),
      subdomainOrg
    );
  }
}

export function renderPublicPageTemplate(templateHtml: string, model: PublicPageModel): string {
  return injectIntoTemplate(templateHtml, model);
}

export async function buildSitemapEntries(origin: string): Promise<SitemapEntry[]> {
  const sql = getDb();
  const organizationRows = await sql.unsafe<{ slug: string; updated_at: string | null }>(
    `
      SELECT
        slug,
        "createdAt"::text AS updated_at
      FROM "organization"
      WHERE visibility = 'public'
      ORDER BY slug ASC
    `,
    []
  );

  const typeRows = await sql.unsafe<{
    organization_slug: string;
    entity_type_slug: string;
    updated_at: string | null;
  }>(
    `
      SELECT
        o.slug AS organization_slug,
        et.slug AS entity_type_slug,
        MAX(et.updated_at)::text AS updated_at
      FROM "organization" o
      JOIN entity_types et ON et.organization_id = o.id AND et.deleted_at IS NULL
      WHERE o.visibility = 'public'
      GROUP BY o.slug, et.slug
      ORDER BY o.slug ASC, et.slug ASC
    `,
    []
  );

  const entityRows = await sql.unsafe<{
    organization_slug: string;
    path: string;
    updated_at: string | null;
  }>(
    `
      WITH RECURSIVE entity_paths AS (
        SELECT
          e.id,
          e.organization_id,
          e.entity_type,
          e.slug,
          e.parent_id,
          ('/' || o.slug || '/' || e.entity_type || '/' || e.slug) AS path,
          e.updated_at
        FROM entities e
        JOIN "organization" o ON o.id = e.organization_id
        WHERE o.visibility = 'public'
          AND e.deleted_at IS NULL
          AND e.parent_id IS NULL

        UNION ALL

        SELECT
          child.id,
          child.organization_id,
          child.entity_type,
          child.slug,
          child.parent_id,
          (entity_paths.path || '/' || child.entity_type || '/' || child.slug) AS path,
          child.updated_at
        FROM entities child
        JOIN entity_paths ON entity_paths.id = child.parent_id
        WHERE child.deleted_at IS NULL
      )
      SELECT
        o.slug AS organization_slug,
        entity_paths.path,
        entity_paths.updated_at::text AS updated_at
      FROM entity_paths
      JOIN "organization" o ON o.id = entity_paths.organization_id
      ORDER BY entity_paths.path ASC
    `,
    []
  );

  return [
    ...organizationRows.map((row) => ({
      loc: absoluteUrl(`/${row.slug}`, origin),
      lastmod: formatDate(row.updated_at),
    })),
    ...typeRows.map((row) => ({
      loc: absoluteUrl(`/${row.organization_slug}/${row.entity_type_slug}`, origin),
      lastmod: formatDate(row.updated_at),
    })),
    ...entityRows.map((row) => ({
      loc: absoluteUrl(row.path, origin),
      lastmod: formatDate(row.updated_at),
    })),
  ];
}

export function buildRobotsTxt(origin: string): string {
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /connect/',
    'Disallow: /mcp',
    'Disallow: /oauth/',
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml', origin)}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const items = entries
    .map(
      (entry) => `
  <url>
    <loc>${escapeHtml(entry.loc)}</loc>
    ${entry.lastmod ? `<lastmod>${escapeHtml(entry.lastmod)}</lastmod>` : ''}
  </url>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}
</urlset>
`;
}

export const PUBLIC_XML_CACHE = PUBLIC_XML_CACHE_CONTROL;
