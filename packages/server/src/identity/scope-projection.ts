/**
 * Reserved event-metadata projections for tenant-scoped identity attribution.
 *
 * Events remain append-only, so read-time identity recall and metric alias
 * resolution cannot recover a tenant key from a later entity row unless the
 * key observed during ingestion rides on the event too. Connector payloads are
 * allowed to use arbitrary ordinary metadata keys; the `__lobu_` prefix is the
 * server-owned protocol namespace and these fields are rebuilt from attached
 * identities before an event is persisted.
 */
export const IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY =
	"__lobu_identity_scope_keys";
export const IDENTITY_SCOPE_BY_ALIAS_METADATA_KEY = "__lobu_alias_scope_keys";
export const SCOPED_IDENTITY_ALIASES_METADATA_KEY =
	"__lobu_scoped_identity_aliases";

/** Mirrors `COALESCE(entity_identities.scope_key, '')` in read-time SQL. */
export const ORGANIZATION_SCOPE_PROJECTION = "";

export type ScopedIdentityAliasProjection = {
	namespace: string;
	identifier: string;
	scopeKey: string;
};

export function parseScopedIdentityAliasProjections(
	value: unknown,
): ScopedIdentityAliasProjection[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item))
			return [];
		const record = item as Record<string, unknown>;
		if (
			typeof record.namespace !== "string" ||
			typeof record.identifier !== "string" ||
			typeof record.scopeKey !== "string" ||
			!record.namespace ||
			!record.identifier
		) {
			return [];
		}
		return [
			{
				namespace: record.namespace,
				identifier: record.identifier,
				scopeKey: record.scopeKey,
			},
		];
	});
}

export function scopedIdentityAliasProjectionKey(
	projection: ScopedIdentityAliasProjection,
): string {
	return JSON.stringify([
		projection.namespace,
		projection.identifier,
		projection.scopeKey,
	]);
}
