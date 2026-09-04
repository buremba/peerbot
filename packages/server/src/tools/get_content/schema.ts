/**
 * Tool: read_knowledge — argument validation.
 *
 * The schema itself lives in `@lobu/core/contracts/tools/read-knowledge` so the
 * connector SDK can derive its published input type from the SAME declaration
 * the handler enforces. Re-exported here because server call sites import it
 * from the tool it belongs to.
 *
 * Inside the server, always import these from this module rather than reaching
 * for the core contract directly: the `markAcceptedInternalFields` stamp below
 * runs on THIS module's load, so a caller that bypasses it can validate against
 * a schema that has not been stamped yet.
 */

import {
  GET_CONTENT_INTERNAL_FIELDS,
  type GetContentArgs,
  GetContentSchema,
} from '@lobu/core/contracts/tools/read-knowledge';
import { markAcceptedInternalFields } from '../validate-args';

// Keeps the accepted-but-unadvertised internal fields VALID for the argument
// validator while omitting them from its "valid arguments are: …" error text.
// Which fields those are is contract data and lives with the schema; stamping
// them onto it is the validator's job and stays here.
markAcceptedInternalFields(GetContentSchema, GET_CONTENT_INTERNAL_FIELDS);

export {
  type GetContentArgs,
  GetContentSchema,
  type PublicGetContentArgs,
  PublicGetContentSchema,
} from '@lobu/core/contracts/tools/read-knowledge';

export function getIncludeSupersededValidationErrors(args: Partial<GetContentArgs>): string[] {
  const errors: string[] = [];

  if (!args.entity_id) {
    errors.push('entity_id is required');
  }
  if (args.query) {
    errors.push('query is not supported');
  }
  if (args.content_ids && args.content_ids.length > 0) {
    errors.push('content_ids is not supported');
  }
  if (args.sort_by === 'score') {
    errors.push('sort_by=score is not supported');
  }
  if (args.classification_source) {
    errors.push('classification_source is not supported');
  }
  if (args.classification_filters && Object.keys(args.classification_filters).length > 0) {
    errors.push('classification_filters is not supported');
  }
  if (args.before_occurred_at || args.before_id || args.after_occurred_at || args.after_id) {
    errors.push('cursor pagination is not supported');
  }

  return errors;
}
