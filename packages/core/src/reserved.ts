/**
 * Canonical reserved names and entity-type classification helpers.
 *
 * 1. System types — slug starts with `$` (`$member`, `$resource`, …)
 * 2. Reserved slug lists — illegal *names* for user create / routes
 *
 * Users cannot create `$…` types. Hide + prune use the `$` prefix only.
 */

// ── Entity type classification ──────────────────────────────────────────────

/**
 * True when a type is platform-owned (hidden from rail, never pruned).
 * Sole signal: slug starts with `$`.
 */
export function isSystemEntityType(et: { slug?: string | null }): boolean {
  return typeof et.slug === "string" && et.slug.startsWith("$");
}

// ── Route / path reserved names ─────────────────────────────────────────────

/**
 * Owner-level route segments under /$owner/. Entity type slugs and org slugs
 * must never collide with these.
 */
export const OWNER_ROUTE_SEGMENTS = [
  "agents",
  "connectors",
  "devices",
  // Legacy redirect path /$owner/environments → infrastructure/sandboxes.
  // Keep reserved so an org/entity slug never collides with the redirect.
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

// ── Connector-key namespace prefixes ────────────────────────────────────────

/**
 * Namespace prefixes for synthesized connectors-list rows whose underlying data
 * lives outside the `connections` table. Model providers and remote sandboxes
 * share the connectors list/map with real connectors, so each gets a reserved
 * key prefix that keeps e.g. a provider named `slack` from colliding with the
 * real Slack connector. The prefixed key IS the routable connector key: rows
 * link to `/connectors/$connectorKey`, and the detail route strips the prefix to
 * resolve the remainder as a provider / sandbox instead of a connector def.
 *
 * These live in core (not the SPA) because the server's chat-message URL
 * builders emit the same prefixed keys into agent-error CTA links, and the SPA
 * re-exports them so browser code keeps one import site. Keep these values in
 * sync with the detail-route parsers (`inference-rows.ts`, `sandbox-rows.ts`).
 */

/** Model-provider row / CTA target: `inference-provider:<slug>`. */
export const INFERENCE_ROW_KEY_PREFIX = "inference-provider:";

/** Org sandbox-instance row: `sandbox:<id>`. */
export const SANDBOX_ROW_KEY_PREFIX = "sandbox:";

/** Sandbox provider-kind (catalog) row: `sandbox-provider:<kind>`. */
export const SANDBOX_PROVIDER_KEY_PREFIX = "sandbox-provider:";

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

/**
 * Whether a proposed entity-type slug is illegal for user/API create.
 * `$…` is reserved for platform-named types ($member, $resource).
 */
export function isReservedEntityTypeSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  if (s.startsWith("$")) return true;
  return (RESERVED_ENTITY_TYPE_SLUGS as readonly string[]).includes(s);
}
