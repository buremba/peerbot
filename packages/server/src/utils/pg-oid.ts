/**
 * Postgres type-OID helpers shared by the read paths that surface column
 * metadata to callers (query_sql, execute-external-source). One source of truth
 * so the OID→name map and the column-identifier guard don't drift.
 */

/** Postgres type OID → a human-readable type name, for API column metadata. */
export const PG_OID_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

export function oidToTypeName(oid: number): string {
  return PG_OID_TYPE_MAP[oid] ?? 'unknown';
}

/** A safe, unquoted SQL column identifier (sort/search column allowlist). */
export const COLUMN_NAME_RE = /^[a-zA-Z_]\w*$/;
