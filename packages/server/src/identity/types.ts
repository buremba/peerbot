/**
 * Engine-internal types. SDK-facing contracts live in
 * `@lobu/connector-sdk` (`identity-types.ts`); import those directly.
 */

/**
 * Output of the engine's per-account ingest pass.
 */
export interface IngestResult {
	/** events.id for each fact-typed event written or extended. */
	factEventIds: number[];
	/** events.id for facts that were superseded during this pass. */
	supersededEventIds: number[];
	/** entity_relationships.id for each derivation written. */
	derivedRelationshipIds: number[];
	/** entity_relationships.id for derivations revoked during this pass. */
	revokedRelationshipIds: number[];
	/** events.id of pending claim_collision rows surfaced this pass. */
	collisionEventIds: number[];
	/** Soft-skipped rules with reason — informational, not errors. */
	skippedRules: Array<{ ruleId: string; reason: string }>;
}

/**
 * Engine config knobs read from env. Most callers don't override.
 */
export interface EngineOptions {
	/**
	 * When true, the engine writes fact events but does NOT write derivations
	 * or revocations. Used for shadow-mode rollouts. Defaults to env
	 * IDENTITY_ENGINE_SHADOW=='true' (any other value = off).
	 */
	shadow?: boolean;
}
