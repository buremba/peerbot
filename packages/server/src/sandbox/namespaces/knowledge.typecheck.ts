import type { KnowledgeSaveInput } from "./knowledge";

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
