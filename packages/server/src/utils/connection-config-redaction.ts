/**
 * Redaction for `connections.config` on every serialization boundary.
 *
 * `connections.config` is written VERBATIM — the create/update path splits it
 * by FEED SCOPE (`splitConfigByFeedScope`), never by secrecy — so connector
 * options such as Slack bot tokens and webhook bearer tokens land in the row
 * as plaintext. Free-form and legacy rows may carry other credentials too.
 * Every read path that serializes a connection to a caller must therefore pass
 * its `config` through {@link redactConnectionConfig} first.
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
 *     TypeScript serializers share this one denylist. The SQL-side mirror for
 *     query_sql is pinned against it by `table-schema-redaction.test.ts`.
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
 * Declared secret keys for ONE feed, from its connector's
 * `feeds_schema[feed_key].configSchema.properties.<k>.format === "password"`.
 *
 * `FeedDefinition.configSchema` is `Record<string, unknown>` — unconstrained —
 * so a custom connector may declare a feed-scoped credential under any name.
 * No shipped connector does today, but the redaction contract must not exempt
 * a declaration site just because nothing currently uses it.
 */
export function feedSecretKeysFromSchema(
	feedsSchema: unknown,
	feedKey: string,
): ConnectorSecretKeys {
	if (!feedsSchema || typeof feedsSchema !== "object") return new Set();
	const definition = (feedsSchema as Record<string, unknown>)[feedKey];
	if (!definition || typeof definition !== "object") return new Set();
	return new Set(
		optionPasswordKeys((definition as Record<string, unknown>).configSchema),
	);
}

/**
 * Batch form: resolve each row's feed-declared secret keys from its own
 * `connector_key` + `feed_key`, in ONE query for the whole page.
 *
 * Rows must carry `feed_key` and `connector_key` (the manage_feeds queries
 * already join the connection for `connector_key`).
 */
export async function loadFeedSecretKeys(
	organizationId: string,
	rows: ReadonlyArray<{ connector_key?: unknown; feed_key?: unknown }>,
): Promise<Map<string, ConnectorSecretKeys>> {
	const byConnectorFeed = new Map<string, ConnectorSecretKeys>();
	const connectorKeys = [
		...new Set(rows.map((r) => String(r.connector_key ?? "")).filter(Boolean)),
	];
	if (connectorKeys.length === 0) return byConnectorFeed;

	const sql = getDb();
	const definitions = await sql`
    SELECT DISTINCT ON (key) key, feeds_schema
    FROM connector_definitions
    WHERE organization_id = ${organizationId}
      AND status = 'active'
      AND key = ANY(${pgTextArray(connectorKeys)}::text[])
    ORDER BY key, updated_at DESC
  `;
	const schemaByConnector = new Map<string, unknown>(
		(
			definitions as unknown as Array<{ key: string; feeds_schema: unknown }>
		).map((row) => [row.key, row.feeds_schema]),
	);

	for (const row of rows) {
		const connectorKey = String(row.connector_key ?? "");
		const feedKey = String(row.feed_key ?? "");
		if (!connectorKey || !feedKey) continue;
		const cacheKey = `${connectorKey}\u0000${feedKey}`;
		if (byConnectorFeed.has(cacheKey)) continue;
		byConnectorFeed.set(
			cacheKey,
			feedSecretKeysFromSchema(schemaByConnector.get(connectorKey), feedKey),
		);
	}
	return byConnectorFeed;
}

/** Key into the {@link loadFeedSecretKeys} map for a row. */
export function feedSecretKeyLookup(row: {
	connector_key?: unknown;
	feed_key?: unknown;
}): string {
	return `${String(row.connector_key ?? "")}\u0000${String(row.feed_key ?? "")}`;
}

/**
 * Load declared secret keys for a set of connector keys in ONE query.
 *
 * List endpoints serialize many connections across a handful of connectors, so
 * this is batched by design — a per-row `getScopedConnectorDefinition` would
 * reintroduce the N+1 the list query was explicitly tuned to avoid.
 *
 * A connector with no active definition in this org yields an empty set; the
 * keyname and URI backstops still apply, but schema-only secret names cannot be
 * recognized without the definition.
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
 * Arrays use the heuristic walk (schema declarations describe top-level object
 * fields). Other non-object values pass through unchanged.
 */
export function redactConnectionConfig(
	config: unknown,
	declaredSecretKeys?: ConnectorSecretKeys,
): unknown {
	if (!config || typeof config !== "object") {
		return config;
	}
	if (Array.isArray(config)) return deepRedactSecrets(config);

	if (!declaredSecretKeys || declaredSecretKeys.size === 0) {
		return deepRedactSecrets(config);
	}

	const withDeclaredRedaction = { ...(config as Record<string, unknown>) };
	for (const key of declaredSecretKeys) {
		if (withDeclaredRedaction[key] != null) {
			withDeclaredRedaction[key] = REDACTED_SENTINEL;
		}
	}

	return deepRedactSecrets(withDeclaredRedaction);
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

// ============================================
// Write side — undoing the redaction
// ============================================

/**
 * Does this value carry a redaction sentinel this module could have produced?
 *
 * Two shapes, because the read path emits two:
 *  - the whole value replaced (`"__LOBU_REDACTED__"`), and
 *  - a URI whose userinfo was replaced
 *    (`"postgres://__LOBU_REDACTED__@db.internal:5432/app"`), which
 *    {@link redactUriCredentials} produces for connection strings under
 *    non-secret keys.
 *
 * A bare equality check catches only the first, so it can silently overwrite a
 * redacted connection string with the placeholder form.
 */
function isRedactedValue(value: unknown): boolean {
	return typeof value === "string" && value.includes(REDACTED_SENTINEL);
}

/**
 * Restore redacted values in an INCOMING config from what is already stored.
 *
 * INVARIANT: on the write side a sentinel means "unchanged", never a literal
 * value. Clients round-trip config (the Owletto editor spreads
 * `connection.config` and PATCHes it back; agents do the same via run_sdk), so
 * without this the sentinel would overwrite the live credential — silent data
 * loss, worse than the leak the redaction prevents. Rotation still works: new
 * plaintext carries no sentinel.
 *
 * Preserve was chosen over rejecting the write because the API is public and
 * already in use; a 400 would break shipped clients for doing the obvious
 * read-modify-write.
 *
 * Walks objects and arrays to match the read path's depth, and treats a string
 * that CONTAINS a sentinel as redacted so the URI form is covered too. A
 * sentinel with no stored counterpart is dropped rather than persisted.
 *
 * Callers must pass the value they are actually writing against — restoring
 * from a stale snapshot rolls back a concurrent rotation, so read the row under
 * the same lock/transaction as the write.
 */
export function restoreRedactedConfig(
	incoming: unknown,
	stored: unknown,
): unknown {
	if (Array.isArray(incoming)) {
		const storedArray = Array.isArray(stored) ? stored : [];
		return incoming.map((item, index) =>
			restoreRedactedConfig(item, storedArray[index]),
		);
	}

	if (incoming && typeof incoming === "object") {
		const storedObject =
			stored && typeof stored === "object" && !Array.isArray(stored)
				? (stored as Record<string, unknown>)
				: {};
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			incoming as Record<string, unknown>,
		)) {
			const restored = restoreRedactedConfig(value, storedObject[key]);
			// Drop a sentinel that has nothing to restore from, rather than
			// persisting the placeholder text as if it were a real value.
			if (restored === undefined) continue;
			out[key] = restored;
		}
		return out;
	}

	if (isRedactedValue(incoming)) {
		return stored === undefined ? undefined : stored;
	}
	return incoming;
}
