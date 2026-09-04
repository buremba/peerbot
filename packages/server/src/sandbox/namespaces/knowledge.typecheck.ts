import type { PublicGetContentArgs } from "../../tools/get_content";
import type { PublicSearchArgs } from "../../tools/search";
import type {
	KnowledgeReadInput,
	KnowledgeSaveInput,
	KnowledgeSearchInput,
} from "./knowledge";

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

/**
 * @internal Compile-time fixture pinning `knowledge.search` to `SearchSchema`.
 *
 * Same `keyof` keying as the read fixture above, and for the same reason: the
 * fields are all optional, so assignability proves nothing.
 */
type HasSearchKey<K extends string> = K extends keyof KnowledgeSearchInput
	? true
	: false;

export type KnowledgeSearchInputContract = [
	// Schema filters the hand-listed interface had dropped.
	Assert<HasSearchKey<"title">>,
	Assert<HasSearchKey<"content_limit">>,
	Assert<HasSearchKey<"metadata_filter">>,
	Assert<HasSearchKey<"include_public_catalogs">>,
	Assert<HasSearchKey<"workspace">>,
	// Accepted by the handler but deliberately never advertised: a pre-computed
	// vector the content layer re-derives, and the caller's bound agent, which
	// is resolved from auth context rather than asserted by a client.
	Assert<HasSearchKey<"query_embedding"> extends false ? true : false>,
	Assert<HasSearchKey<"agent_id"> extends false ? true : false>,
];

/**
 * Exhaustive counterpart to the sampled asserts above: those name the fields
 * whose loss caused a real defect, this one catches ANY divergence. It needs no
 * upkeep — while the types stay derived it holds by construction, and it fails
 * the moment one is replaced by a hand-written interface.
 */
type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type KnowledgeInputKeysExhaustive = [
	Assert<ExactKeys<keyof KnowledgeReadInput, keyof PublicGetContentArgs>>,
	Assert<ExactKeys<keyof KnowledgeSearchInput, keyof PublicSearchArgs>>,
];
