import type { KnowledgeReadInput, KnowledgeSaveInput } from "./knowledge";

type Assert<T extends true> = T;
type Accepts<T> = T extends KnowledgeSaveInput ? true : false;
type Rejects<T> = T extends KnowledgeSaveInput ? false : true;

/** @internal Compile-time fixture for the payload_type/content contract. */
export type KnowledgeSaveInputContract = [
	Assert<
		Accepts<{
			semantic_type: "valuation";
			payload_type: "empty";
			metadata: { amount: number };
		}>
	>,
	Assert<Accepts<{ semantic_type: "note"; content: string }>>,
	Assert<Rejects<{ semantic_type: "note" }>>,
	Assert<Rejects<{ semantic_type: "note"; payload_type: "text" }>>,
];

/**
 * @internal Compile-time fixture pinning `knowledge.read` to the tool schema.
 *
 * Keyed on `keyof`, not assignability: every field is optional, so a stray
 * object still structurally extends the type and an `Accepts`/`Rejects` pair
 * would pass no matter what the interface declared.
 */
type HasReadKey<K extends string> = K extends keyof KnowledgeReadInput
	? true
	: false;

export type KnowledgeReadInputContract = [
	// `semantic_type` is the filter the empty-search guidance tells callers to
	// pass to `client.knowledge.read`; `entity_types` and `query` are schema
	// filters the hand-listed interface had dropped. All three must stay
	// declared.
	Assert<HasReadKey<"semantic_type">>,
	Assert<HasReadKey<"entity_types">>,
	Assert<HasReadKey<"query">>,
	// `getContent` reads `entity_ids` off the ROW, never off the input. Declaring
	// it told callers they could filter by it while results came back unfiltered.
	Assert<HasReadKey<"entity_ids"> extends false ? true : false>,
	// Accepted at the boundary but deliberately never an SDK affordance.
	Assert<HasReadKey<"mcp_activity_id"> extends false ? true : false>,
];
