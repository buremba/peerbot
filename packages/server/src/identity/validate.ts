/**
 * Runtime validation for the identity-engine schemas (T1).
 *
 * Every write boundary into the engine — connector ingest, rule-compile,
 * derivation insert, collision event — runs the relevant TypeBox schema and
 * throws on malformed input. The collapsed model puts a lot in `metadata
 * jsonb`, so without this discipline the engine silently corrupts.
 */

import {
	TypeCompiler,
	type ValueErrorIterator,
} from "@sinclair/typebox/compiler";
import type { TSchema, Static } from "@sinclair/typebox";
import {
	ClaimCollisionPayload,
	ConnectorFact,
	DerivedRelationshipMetadata,
	FactEventMetadata,
	RelationshipTypeIdentityMetadata,
} from "@lobu/connector-sdk";

const compiledFact = TypeCompiler.Compile(ConnectorFact);
const compiledFactEventMetadata = TypeCompiler.Compile(FactEventMetadata);
const compiledRelTypeMeta = TypeCompiler.Compile(
	RelationshipTypeIdentityMetadata,
);
const compiledDerivedRelMeta = TypeCompiler.Compile(
	DerivedRelationshipMetadata,
);
const compiledClaimCollision = TypeCompiler.Compile(ClaimCollisionPayload);

export class IdentitySchemaError extends Error {
	constructor(
		public readonly schemaName: string,
		public readonly errors: Array<{
			path: string;
			message: string;
			value: unknown;
		}>,
	) {
		const summary = errors
			.slice(0, 3)
			.map((e) => `${e.path || "<root>"}: ${e.message}`)
			.join("; ");
		const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
		super(`${schemaName} validation failed: ${summary}${more}`);
		this.name = "IdentitySchemaError";
	}
}

function collectErrors(iter: ValueErrorIterator): Array<{
	path: string;
	message: string;
	value: unknown;
}> {
	const errs: Array<{ path: string; message: string; value: unknown }> = [];
	for (const err of iter) {
		errs.push({ path: err.path, message: err.message, value: err.value });
		if (errs.length >= 16) break;
	}
	return errs;
}

function ensure<T extends TSchema>(
	schemaName: string,
	compiler: ReturnType<typeof TypeCompiler.Compile<T>>,
	value: unknown,
): asserts value is Static<T> {
	if (compiler.Check(value)) return;
	throw new IdentitySchemaError(
		schemaName,
		collectErrors(compiler.Errors(value)),
	);
}

export function validateConnectorFact(
	value: unknown,
): asserts value is Static<typeof ConnectorFact> {
	ensure("ConnectorFact", compiledFact, value);
}

export function validateFactEventMetadata(
	value: unknown,
): asserts value is Static<typeof FactEventMetadata> {
	ensure("FactEventMetadata", compiledFactEventMetadata, value);
}

export function validateRelationshipTypeIdentityMetadata(
	value: unknown,
): asserts value is Static<typeof RelationshipTypeIdentityMetadata> {
	ensure("RelationshipTypeIdentityMetadata", compiledRelTypeMeta, value);
}

export function validateDerivedRelationshipMetadata(
	value: unknown,
): asserts value is Static<typeof DerivedRelationshipMetadata> {
	ensure("DerivedRelationshipMetadata", compiledDerivedRelMeta, value);
}

export function validateClaimCollisionPayload(
	value: unknown,
): asserts value is Static<typeof ClaimCollisionPayload> {
	ensure("ClaimCollisionPayload", compiledClaimCollision, value);
}
