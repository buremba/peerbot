/**
 * Shared AJV singleton and error formatting.
 *
 * Both schema-validation.ts and event-kind-validation.ts need an identically
 * configured AJV instance. Centralising it here avoids duplicate setup.
 */

import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

let ajvInstance: Ajv | null = null;

export function getAjv(): Ajv {
  if (!ajvInstance) {
    ajvInstance = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: true,
    });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

export function formatAjvError(error: ErrorObject): string {
  const field = error.instancePath ? error.instancePath.replace(/^\//, '') : 'root';
  switch (error.keyword) {
    case 'type':
      return `${field}: must be ${error.params.type}`;
    case 'required':
      return `missing required field: ${error.params.missingProperty}`;
    case 'format':
      return `${field}: must be a valid ${error.params.format}`;
    case 'minimum':
      return `${field}: must be >= ${error.params.limit}`;
    case 'maximum':
      return `${field}: must be <= ${error.params.limit}`;
    case 'minLength':
      return `${field}: must be at least ${error.params.limit} characters`;
    case 'maxLength':
      return `${field}: must be at most ${error.params.limit} characters`;
    case 'pattern':
      return `${field}: must match pattern ${error.params.pattern}`;
    case 'enum':
      return `${field}: must be one of: ${(error.params.allowedValues as string[]).join(', ')}`;
    case 'additionalProperties':
      return `${field}: unknown property '${error.params.additionalProperty}'`;
    default:
      return error.message ?? `${field}: validation failed`;
  }
}
