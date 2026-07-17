/**
 * Canonical reserved names and entity-type classification helpers.
 *
 * Two separate jobs — do not collapse them:
 * 1. System types — slug starts with `$` (`$member`, `$resource`, …)
 * 2. Reserved slug lists — illegal *names* for user create / routes (may not be rows)
 *
 * Users cannot create `$…` types. Hide + prune use the `$` prefix only.
 * `created_by` is audit only and must never be used as a stand-in for system.
 */

// ── Entity type classification ──────────────────────────────────────────────

/**
 * True when a type is platform-owned (hidden from rail, never pruned).
 * Sole signal: slug starts with `$` (not created_by, not hide-slug denylists).
 */
export function isSystemEntityType(et: {
  slug?: string | null;
  /** @deprecated ignored — classification is slug `$` only */
  is_system?: boolean | null;
}): boolean {
  return typeof et.slug === "string" && et.slug.startsWith("$");
}

/** @deprecated Use isSystemEntityType */
export const isSystemResourceEntityType = isSystemEntityType;

// ── Route / path reserved names ─────────────────────────────────────────────

/**
 * Owner-level route segments under /$owner/. Entity type slugs and org slugs
 * must never collide with these.
 */
export const OWNER_ROUTE_SEGMENTS = [
  "agents",
  "connectors",
  "devices",
  "environments",
  "infrastructure",
  "memory",
  "members",
  "settings",
] as const;

/** Legacy page slugs removed from the UI router. */
export const REMOVED_OWNER_SEGMENTS = [
  "events",
  "watchers",
  "connections",
  "sources",
] as const;

/**
 * Reserved owner-slug / path names. Combines owner routes, removed legacy
 * pages, global prefixes, and infra subdomains that must not be claimed as
 * org slugs.
 */
export const RESERVED_PATHS = [
  ...OWNER_ROUTE_SEGMENTS,
  ...REMOVED_OWNER_SEGMENTS,
  "auth",
  "api",
  "inbox",
  "templates",
  "help",
  "account",
  "admin",
  "health",
  "login",
  "logout",
  "signup",
  "register",
  "contents",
  "entity-types",
  "www",
  "mcp",
  "static",
  "assets",
  "cdn",
  "docs",
  "mail",
] as const;

export const RESERVED_PATHS_SET: ReadonlySet<string> = new Set(RESERVED_PATHS);

// ── Entity type create denylist ─────────────────────────────────────────────

/**
 * Slugs users cannot use when *creating* an entity type. Route collisions plus
 * product words that are not knowledge types. Create-time hygiene only — not
 * hide/prune policy (that is `$` prefix only).
 */
export const RESERVED_ENTITY_TYPE_SLUGS = [
  ...OWNER_ROUTE_SEGMENTS,
  ...REMOVED_OWNER_SEGMENTS,
  "organization",
  "user",
  "watcher",
  "content",
  "source",
  "connector",
] as const;

/** @deprecated Use RESERVED_ENTITY_TYPE_SLUGS */
export const RESERVED_ENTITY_TYPES = RESERVED_ENTITY_TYPE_SLUGS;

/**
 * Whether a proposed entity-type slug is illegal for user/API create.
 * `$…` is reserved for platform-named types ($member, $resource).
 */
export function isReservedEntityTypeSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  if (s.startsWith("$")) return true;
  return (RESERVED_ENTITY_TYPE_SLUGS as readonly string[]).includes(s);
}
