/**
 * Owner-level route segments that map to real app pages under /$owner/.
 * Entity type slugs must never collide with these.
 */
const OWNER_ROUTE_SEGMENTS = [
  'agents',
  'connectors',
  'events',
  'members',
  'settings',
  'watchers',
] as const;

/**
 * Reserved owner-slug names. Combines:
 * - System-level route prefixes (not under /$owner) — `auth`, `api`, …
 * - Infrastructure subdomains that must never be claimed as an org slug —
 *   `www`, `mcp`, `static`, `assets`, `cdn`, `docs`, `mail`. These mirror
 *   `RESERVED_SUBDOMAINS` in `packages/server/src/index.ts` so a name that
 *   resolves to infra at the routing layer cannot be claimed at the org layer.
 *
 * The DB-level `org_slug_not_reserved` CHECK constraint
 * (db/migrations/20260420120000_extend_reserved_org_slugs.sql) enforces a
 * subset of this list. Extra entries here are an intentional defense-in-depth
 * superset — losing one silently could allow squatting on a route.
 */
export const RESERVED_PATHS = [
  ...OWNER_ROUTE_SEGMENTS,
  'auth',
  'api',
  'inbox',
  'templates',
  'help',
  'account',
  'admin',
  'health',
  'login',
  'logout',
  'signup',
  'register',
  'sources',
  'contents',
  'entity-types',
  'www',
  'mcp',
  'static',
  'assets',
  'cdn',
  'docs',
  'mail',
];

/** Set form for O(1) membership checks (e.g. personal-org slug derivation). */
export const RESERVED_PATHS_SET: ReadonlySet<string> = new Set(RESERVED_PATHS);

/**
 * Reserved entity type slugs that users cannot create.
 * Includes owner-level routes (to prevent URL collisions) and
 * internal system type names.
 */
export const RESERVED_ENTITY_TYPES = [
  ...OWNER_ROUTE_SEGMENTS,
  'organization',
  'user',
  'watcher',
  'content',
  'source',
  'sources',
  'connections',
  'connector',
];

