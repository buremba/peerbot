/**
 * Shared TypeBox field definitions for admin tool schemas.
 *
 * These are spread into tool-specific schemas to avoid repeating
 * identical limit/offset/entity_id patterns across files.
 */

import { Type } from '@sinclair/typebox';

/** Standard pagination fields with sensible defaults. */
export const PaginationFields = {
  limit: Type.Optional(Type.Number({ description: 'Page size (default: 100)', default: 100 })),
  offset: Type.Optional(Type.Number({ description: 'Pagination offset (default: 0)', default: 0 })),
};

/** Entity ID field used for scoping operations. */
export const EntityIdField = Type.Optional(
  Type.Number({ description: 'Entity ID to scope operations' })
);

/** Freeform metadata record. */
export const MetadataField = Type.Optional(
  Type.Record(Type.String(), Type.Unknown(), {
    description: 'Custom metadata',
  })
);
