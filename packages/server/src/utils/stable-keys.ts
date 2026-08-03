import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/** Maximum tuple width keeps indexed identity values bounded and understandable. */
export const MAX_STABLE_KEY_FIELDS = 4;

/** Field names are configuration, but they are encoded into every identity. */
export const MAX_STABLE_KEY_FIELD_LENGTH = 128;

/** Each exact scalar component is capped before base64url expansion. */
export const MAX_STABLE_KEY_COMPONENT_BYTES = 256;

const STABLE_KEY_VERSION = 'v1';
const BEHAVIOR_ENTITY_IDENTITY_VERSION = 'v2';

/**
 * Scope a stable tuple to the Behavior output and its declared entity type.
 * The full exact tuple stays in entity metadata; the indexed identity is a
 * fixed-size digest so every contract-valid tuple fits PostgreSQL B-tree keys.
 */
export function formatBehaviorEntityIdentity(
  watcherId: number,
  outputName: string,
  entityTypeSlug: string,
  stableKey: string
): string {
  const scopedTuple = `${watcherId}::${outputName}::${entityTypeSlug}::${stableKey}`;
  const digest = createHash('sha256').update(scopedTuple, 'utf8').digest('hex');
  return `${BEHAVIOR_ENTITY_IDENTITY_VERSION}::${digest}`;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function encodeComponent(field: string, value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error(`Stable key field '${field}' must be present and non-null.`);
  }

  let type: 's' | 'i' | 'b';
  let raw: string;
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new Error(`Stable key field '${field}' must be non-blank.`);
    }
    type = 's';
    raw = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Stable key field '${field}' must be a safe integer.`);
    }
    type = 'i';
    raw = String(value);
  } else if (typeof value === 'boolean') {
    type = 'b';
    raw = value ? 'true' : 'false';
  } else {
    throw new Error(
      `Stable key field '${field}' must be a string, safe integer, or boolean scalar.`
    );
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_STABLE_KEY_COMPONENT_BYTES) {
    throw new Error(
      `Stable key field '${field}' must be at most ${MAX_STABLE_KEY_COMPONENT_BYTES} bytes.`
    );
  }
  return `${encode(field)}.${type}.${encode(raw)}`;
}

function encodeStableKeyComponents(
  row: Record<string, unknown>,
  keyFields: readonly string[]
): string[] {
  if (keyFields.length === 0 || keyFields.length > MAX_STABLE_KEY_FIELDS) {
    throw new Error(
      `Stable keys require between 1 and ${MAX_STABLE_KEY_FIELDS} fields.`
    );
  }
  if (new Set(keyFields).size !== keyFields.length) {
    throw new Error('Stable key fields must be unique.');
  }
  for (const field of keyFields) {
    if (field.length === 0 || field.length > MAX_STABLE_KEY_FIELD_LENGTH) {
      throw new Error(
        `Stable key field names must be between 1 and ${MAX_STABLE_KEY_FIELD_LENGTH} characters.`
      );
    }
  }
  return keyFields.map((field) => encodeComponent(field, row[field]));
}

/** Validate the exact scalar and UTF-8 byte contract used to encode a stable key. */
export function validateStableKeyComponents(
  row: Record<string, unknown>,
  keyFields: readonly string[]
): void {
  encodeStableKeyComponents(row, keyFields);
}

/**
 * Compute one Behavior-scoped stable key without adding transport-only fields
 * to the model's output or the entity's metadata.
 */
export function computeStableKey(
  row: Record<string, unknown>,
  keyFields: readonly string[]
): string {
  return `${STABLE_KEY_VERSION}~${encodeStableKeyComponents(row, keyFields).join('~')}`;
}
