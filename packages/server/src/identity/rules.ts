import { createHash } from "node:crypto";
import type { AutoCreateWhenRule } from "@lobu/connector-sdk";
import { validateRelationshipTypeIdentityMetadata } from "./validate";

function canonicaliseRules(rules: AutoCreateWhenRule[]): string {
	return JSON.stringify(
		rules
			.map((r) => ({
				sourceNamespace: r.sourceNamespace,
				targetField: r.targetField,
				assuranceRequired: r.assuranceRequired,
				matchStrategy: r.matchStrategy,
			}))
			.sort((a, b) =>
				a.sourceNamespace === b.sourceNamespace
					? a.targetField.localeCompare(b.targetField)
					: a.sourceNamespace.localeCompare(b.sourceNamespace),
			),
	);
}

export function ruleHashFor(rules: AutoCreateWhenRule[]): string {
	return createHash("sha256").update(canonicaliseRules(rules)).digest("hex");
}

/**
 * Build the metadata blob that lands on `entity_relationship_types.metadata`
 * for a public-catalog rule. Validates the result so seeders / test fixtures
 * never persist a malformed shape — bad rules are caught at write, not at
 * the next ingest pass.
 */
export function compileRulesMetadata(
	rules: AutoCreateWhenRule[],
	ruleVersion: number,
): {
	autoCreateWhen: AutoCreateWhenRule[];
	ruleVersion: number;
	ruleHash: string;
} {
	const metadata = {
		autoCreateWhen: rules,
		ruleVersion,
		ruleHash: ruleHashFor(rules),
	};
	validateRelationshipTypeIdentityMetadata(metadata);
	return metadata;
}
