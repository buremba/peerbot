import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { OperationDescriptor } from './types';
import { getErrorMessage } from '@lobu/core';
import { formatAjvError } from '../utils/ajv-singleton';

const operationInputAjv = new Ajv({
  allErrors: false,
  strict: false,
  coerceTypes: false,
});
addFormats(operationInputAjv);

// `input_schema` objects are parsed fresh from the DB on each request (no
// `$id`), so AJV can't dedupe them and `compile()` would add a new validator
// to the instance's internal store on every call, growing without bound on a
// long-lived gateway. Cache the compiled validator keyed on the serialized
// schema: identical schemas reuse one validator (capping growth at the number
// of distinct schemas), while an updated schema for the same operation still
// gets its own validator.
const validatorCache = new Map<string, ValidateFunction>();

export function validateOperationInput(
  operation: OperationDescriptor,
  input: Record<string, unknown>
): string | null {
  const schema = operation.input_schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;

  try {
    const cacheKey = JSON.stringify(schema);
    let validate = validatorCache.get(cacheKey);
    if (!validate) {
      validate = operationInputAjv.compile(schema);
      validatorCache.set(cacheKey, validate);
    }
    if (validate(input)) return null;
    const firstError = validate.errors?.[0];
    return firstError
      ? formatAjvError(firstError)
      : 'input does not match operation schema';
  } catch (error) {
    return `operation input schema is invalid: ${getErrorMessage(error)}`;
  }
}
