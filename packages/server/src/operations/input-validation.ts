import Ajv from 'ajv';
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

export function validateOperationInput(
  operation: OperationDescriptor,
  input: Record<string, unknown>
): string | null {
  const schema = operation.input_schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;

  try {
    const validate = operationInputAjv.compile(schema);
    if (validate(input)) return null;
    const firstError = validate.errors?.[0];
    return firstError
      ? formatAjvError(firstError)
      : 'input does not match operation schema';
  } catch (error) {
    return `operation input schema is invalid: ${getErrorMessage(error)}`;
  }
}
