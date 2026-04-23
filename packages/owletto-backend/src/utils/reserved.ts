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

/** System-level route prefixes (not under /$owner). */
export const RESERVED_PATHS = [
  ...OWNER_ROUTE_SEGMENTS,
  'auth',
  'api',
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
];

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

const RESERVED_SEGMENTS = new Set<string>([...RESERVED_ENTITY_TYPES, ...RESERVED_PATHS]);

/**
 * Check if a URL segment is reserved (i.e. it's a known route name or system path).
 * Used by resolve_path to distinguish reserved routes from entity types.
 */
function isReservedSegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment);
}
