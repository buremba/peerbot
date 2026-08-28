/**
 * Event-side tenant keys for identity attribution, keyed by namespace.
 *
 * Events are append-only, so recall and metric joins need the tenant key that
 * was observed with the event. Connector payloads cannot author this reserved
 * field; attribution rebuilds it from the resolved identity tuple.
 */
export const IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY =
	"__lobu_identity_scope_keys";

export function isIdentityScopeProjectionMetadataKey(key: string): boolean {
	return key === IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY;
}

export function stripIdentityScopeProjectionMetadata(
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	if (!metadata) return metadata ?? undefined;
	if (!Object.hasOwn(metadata, IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY)) {
		return metadata;
	}
	const clean = { ...metadata };
	delete clean[IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY];
	return clean;
}

/** Mirrors `COALESCE(entity_identities.scope_key, '')` in read-time SQL. */
export const ORGANIZATION_SCOPE_PROJECTION = "";
