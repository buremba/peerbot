/**
 * Re-export canonical reserved names from @lobu/core.
 * Keep this file so existing server imports (`../utils/reserved`) stay stable.
 */
export {
  isReservedEntityTypeSlug,
  isSystemEntityType,
  isSystemResourceEntityType,
  OWNER_ROUTE_SEGMENTS,
  REMOVED_OWNER_SEGMENTS,
  RESERVED_ENTITY_TYPE_SLUGS,
  RESERVED_ENTITY_TYPES,
  RESERVED_PATHS,
  RESERVED_PATHS_SET,
} from "@lobu/core";
