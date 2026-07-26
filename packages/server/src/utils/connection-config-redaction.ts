/**
 * Redaction for `connections.config` on every serialization boundary.
 *
 * `connections.config` is written VERBATIM — the create/update path splits it
 * by FEED SCOPE (`splitConfigByFeedScope`), never by secrecy — so a Slack bot
 * token, a webhook bearer token, or a Postgres `DATABASE_URL` lands in the row
 * as plaintext. Every read path that serializes a connection to a caller must
 * therefore pass its `config` through {@link redactConnectionConfig} first.
 *
 * Two layers, in this order:
 *
 *  1. SCHEMA-DRIVEN (primary, precise). Connectors already declare which of
 *     their option/auth fields are secret, in two existing conventions:
 *       - `options_schema.properties.<key>.format === "password"`
 *         (discord `botToken`, webhook `token`, slack, telegram, …)
 *       - `auth_schema.methods[].fields[].secret === true` on an `env_keys`
 *         method (postgres `DATABASE_URL`, github, producthunt)
 *     Those declarations are the source of truth: a correctly annotated
 *     connector gets exact redaction with no name guessing.
 *
 *  2. KEYNAME HEURISTIC (backstop, recursive). `config` is free-form JSONB and
 *     most connectors are NOT fully annotated — a user can put anything under
 *     any key at any depth, and legacy rows predate the schemas entirely. So
 *     the schema pass is followed by `deepRedactSecrets` from @lobu/core: the
 *     SAME denylist the config-audit snapshots and the CLI manifest hash use.
 *     There is exactly one denylist in the repo; extend it there, never here.
 *
 * Values are REPLACED with {@link REDACTED_SENTINEL}, not deleted, so the UI
 * can still render "this field is SET" and a form can show a filled input.
 * (The `connect-setup-continuation` resume-call builder deliberately OMITS
 * instead — a sentinel inside an EXECUTABLE sdk call could be replayed as if
 * it were a real credential. That reasoning does not apply to a read-only
 * serializer, which is why this module uses the sentinel.)
 */

import { deepRedactSecrets, REDACTED_SENTINEL } from "@lobu/core";
import { getDb, pgTextArray } from "../db/client";

export { REDACTED_SENTINEL };

/**
 * Secret field keys declared by a connector definition, in the two existing
 * conventions. Top-level `config` keys only — nesting under them is handled by
 * the recursive keyname backstop.
 */
export type ConnectorSecretKeys = ReadonlySet<string>;

/** Collect `options_schema.properties.<key>.format === 'password'` keys. */
function optionPasswordKeys(optionsSchema: unknown): string[] {
	if (!optionsSchema || typeof optionsSchema !== "object") return [];
	const properties = (optionsSchema as Record<string, unknown>).properties;
	if (!properties || typeof properties !== "object") return [];
	const keys: string[] = [];
	for (const [key, spec] of Object.entries(
		properties as Record<string, unknown>,
	)) {
		if (
			spec &&
			typeof spec === "object" &&
			(spec as Record<string, unknown>).format === "password"
		) {
			keys.push(key);
		}
	}
	return keys;
}

/** Collect `auth_schema.methods[].fields[].secret === true` keys. */
function authSecretFieldKeys(authSchema: unknown): string[] {
	if (!authSchema || typeof authSchema !== "object") return [];
	const methods = (authSchema as Record<string, unknown>).methods;
	if (!Array.isArray(methods)) return [];
	const keys: string[] = [];
	for (const method of methods) {
		if (!method || typeof method !== "object") continue;
		const fields = (method as Record<string, unknown>).fields;
		if (!Array.isArray(fields)) continue;
		for (const field of fields) {
			if (!field || typeof field !== "object") continue;
			const record = field as Record<string, unknown>;
			if (record.secret === true && typeof record.key === "string") {
				keys.push(record.key);
			}
		}
	}
	return keys;
}

/**
 * Declared secret keys for one connector's schemas. Pure — pass the schemas
 * you already have on hand (handleGet selects `cd.auth_schema`) instead of
 * re-querying.
 */
export function connectorSecretKeysFromSchemas(params: {
	optionsSchema?: unknown;
	authSchema?: unknown;
}): ConnectorSecretKeys {
	return new Set([
		...optionPasswordKeys(params.optionsSchema),
		...authSecretFieldKeys(params.authSchema),
	]);
}

/**
 * Load declared secret keys for a set of connector keys in ONE query.
 *
 * List endpoints serialize many connections across a handful of connectors, so
 * this is batched by design — a per-row `getScopedConnectorDefinition` would
 * reintroduce the N+1 the list query was explicitly tuned to avoid.
 *
 * A connector with no active definition in this org yields an empty set; the
 * keyname backstop still applies, so an unknown connector is never LESS
 * redacted than an annotated one, only less precise.
 */
export async function loadConnectorSecretKeys(
	organizationId: string,
	connectorKeys: readonly string[],
): Promise<Map<string, ConnectorSecretKeys>> {
	const byConnector = new Map<string, ConnectorSecretKeys>();
	const unique = [...new Set(connectorKeys.filter(Boolean))];
	if (unique.length === 0) return byConnector;

	const sql = getDb();
	const rows = await sql`
    SELECT DISTINCT ON (key) key, options_schema, auth_schema
    FROM connector_definitions
    WHERE organization_id = ${organizationId}
      AND status = 'active'
      AND key = ANY(${pgTextArray(unique)}::text[])
    ORDER BY key, updated_at DESC
  `;

	for (const row of rows as unknown as Array<{
		key: string;
		options_schema: unknown;
		auth_schema: unknown;
	}>) {
		byConnector.set(
			row.key,
			connectorSecretKeysFromSchemas({
				optionsSchema: row.options_schema,
				authSchema: row.auth_schema,
			}),
		);
	}
	return byConnector;
}

/**
 * Redact a single `connections.config` value.
 *
 * Schema-declared keys first (exact), then the shared recursive keyname walk
 * (backstop, any depth, plus embedded `scheme://user:pass@host` credentials).
 * Non-secret values pass through byte-identical.
 *
 * Returns the input unchanged when it is not an object (null config stays
 * null) so callers can pipe a raw row value straight through.
 */
export function redactConnectionConfig(
	config: unknown,
	declaredSecretKeys?: ConnectorSecretKeys,
): unknown {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return config;
	}

	const walked = deepRedactSecrets(config) as Record<string, unknown>;
	if (!declaredSecretKeys || declaredSecretKeys.size === 0) return walked;

	for (const key of declaredSecretKeys) {
		if (walked[key] != null) walked[key] = REDACTED_SENTINEL;
	}
	return walked;
}

/**
 * Redact `row.config` in place-free fashion, returning a NEW row object.
 *
 * The house serializer shape is `{ ...row }`, so this is the one-liner every
 * connection read path applies before spreading. Rows without a `config` key
 * are returned untouched.
 */
export function redactConnectionRow<T extends Record<string, unknown>>(
	row: T,
	declaredSecretKeys?: ConnectorSecretKeys,
): T {
	if (!("config" in row)) return row;
	return {
		...row,
		config: redactConnectionConfig(row.config, declaredSecretKeys),
	};
}

/**
 * Batch form: redact `config` on every row, resolving each row's declared
 * secret keys from its own `connector_key`. One query for the whole page.
 */
export async function redactConnectionRows<T extends Record<string, unknown>>(
	organizationId: string,
	rows: T[],
): Promise<T[]> {
	if (rows.length === 0) return rows;
	const secretKeysByConnector = await loadConnectorSecretKeys(
		organizationId,
		rows.map((row) => String(row.connector_key ?? "")),
	);
	return rows.map((row) =>
		redactConnectionRow(
			row,
			secretKeysByConnector.get(String(row.connector_key ?? "")),
		),
	);
}
