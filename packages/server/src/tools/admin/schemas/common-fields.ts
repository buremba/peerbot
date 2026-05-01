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

