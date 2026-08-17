import { describe, expect, it } from "vitest";
import {
	evaluateTransition,
	parseTransitionSpec,
	specFromMetadataSchema,
} from "../entity-transition-rules";

const INVOICE = parseTransitionSpec({
	field: "status",
	states: {
		draft: { to: ["issued", "cancelled"] },
		issued: {
			to: ["posted", "cancelled"],
			frozen: true,
			writableOnExit: { posted: ["einvoice_uuid"] },
		},
		posted: { to: [], frozen: true },
		cancelled: { to: [], frozen: true },
	},
});

function decide(
	committed: Record<string, unknown>,
	patch: Record<string, unknown>,
): string | null {
	return evaluateTransition({ spec: INVOICE, committed, patch });
}

describe("parseTransitionSpec", () => {
	it("accepts a minimal spec and defaults frozen/writableOnExit", () => {
		const spec = parseTransitionSpec({
			field: "state",
			states: { open: { to: [] } },
		});
		expect(spec.field).toBe("state");
		expect(spec.states.open.frozen).toBe(false);
		expect(spec.states.open.writableOnExit).toEqual({});
	});

	it.each([
		["a non-object", "nope"],
		["a missing field", { states: { a: { to: [] } } }],
		["an empty field", { field: "", states: { a: { to: [] } } }],
		["missing states", { field: "s" }],
		["empty states", { field: "s", states: {} }],
		["a non-object state", { field: "s", states: { a: 1 } }],
		[
			"a non-boolean frozen",
			{ field: "s", states: { a: { to: [], frozen: "y" } } },
		],
		["a non-array to", { field: "s", states: { a: { to: "b" } } }],
		["a non-string in to", { field: "s", states: { a: { to: [2] } } }],
		[
			"a non-object writableOnExit",
			{ field: "s", states: { a: { to: [], writableOnExit: [] } } },
		],
		[
			"a null writableOnExit",
			{ field: "s", states: { a: { to: [], writableOnExit: null } } },
		],
	])("rejects %s", (_label, raw) => {
		expect(() => parseTransitionSpec(raw)).toThrow();
	});

	it("rejects a `to` naming a state that does not exist", () => {
		expect(() =>
			parseTransitionSpec({ field: "s", states: { a: { to: ["ghost"] } } }),
		).toThrow(/unknown state "ghost"/);
	});

	it("rejects writableOnExit for a target that is not an outbound transition", () => {
		expect(() =>
			parseTransitionSpec({
				field: "s",
				states: {
					a: { to: ["b"], writableOnExit: { c: ["receipt"] } },
					b: { to: [] },
					c: { to: [] },
				},
			}),
		).toThrow(/non-transition target "c"/);
	});

	it("does not resolve a tenant state name through the prototype chain", () => {
		// State names are tenant data used as object keys. `constructor` must be an
		// ordinary (absent) state, not Object.prototype.constructor.
		const spec = parseTransitionSpec({
			field: "s",
			states: { real: { to: [] } },
		});
		expect(
			evaluateTransition({
				spec,
				committed: { s: "constructor" },
				patch: { anything: 1 },
			}),
		).toBeNull();
	});
});

describe("evaluateTransition", () => {
	it("allows a declared move", () => {
		expect(decide({ status: "draft" }, { status: "issued" })).toBeNull();
	});

	it("denies an undeclared move", () => {
		expect(decide({ status: "draft" }, { status: "posted" })).toMatch(
			/illegal transition draft -> posted/,
		);
	});

	it("denies any move out of a terminal state", () => {
		expect(decide({ status: "posted" }, { status: "draft" })).toMatch(
			/illegal transition/,
		);
	});

	it("denies editing a non-state field while frozen", () => {
		expect(decide({ status: "posted" }, { grand_total: 1 })).toMatch(
			/frozen in state "posted".*grand_total/,
		);
	});

	it("names every offending field, sorted, so the message is deterministic", () => {
		expect(decide({ status: "posted" }, { b: 1, a: 2 })).toMatch(
			/cannot write a, b$/,
		);
	});

	it("allows a writableOnExit field in the same write as its move", () => {
		expect(
			decide({ status: "issued" }, { status: "posted", einvoice_uuid: "x" }),
		).toBeNull();
	});

	it("scopes writableOnExit to the declared target, not any move", () => {
		expect(
			decide({ status: "issued" }, { status: "cancelled", einvoice_uuid: "x" }),
		).toMatch(/frozen in state "issued".*einvoice_uuid/);
	});

	it("does not grant writableOnExit when the state field is absent", () => {
		expect(decide({ status: "issued" }, { einvoice_uuid: "x" })).toMatch(
			/frozen in state "issued"/,
		);
	});

	it("tolerates a no-op rewrite of an unchanged field while frozen", () => {
		// Load-bearing, not a nicety: `patch.metadata` is the fully MERGED metadata
		// object, so every unchanged key is present on every write. Without deep
		// no-op tolerance a frozen row could never be written at all.
		expect(
			decide(
				{ status: "posted", totals: { net: 100, tax: 20 } },
				{ status: "posted", totals: { tax: 20, net: 100 } },
			),
		).toBeNull();
	});

	it.each([null, 7, undefined])(
		"denies replacing a declared state with non-string %s",
		(value) => {
			expect(decide({ status: "draft" }, { status: value })).toMatch(
				/state field "status" must be a string/,
			);
		},
	);

	it("covers reserved $-attributes, so a frozen entity cannot be renamed", () => {
		expect(decide({ status: "posted" }, { $name: "new" })).toMatch(
			/frozen in state "posted".*\$name/,
		);
	});

	it("abstains when the committed state is not declared", () => {
		// Adoption: adding a spec to a type with existing rows must not freeze every
		// row whose value predates it.
		expect(decide({ status: "legacy" }, { grand_total: 1 })).toBeNull();
	});

	it("abstains when the state field is absent or non-string", () => {
		expect(decide({}, { grand_total: 1 })).toBeNull();
		expect(decide({ status: 7 }, { grand_total: 1 })).toBeNull();
	});

	it("allows unrestricted edits in a non-frozen declared state", () => {
		expect(decide({ status: "draft" }, { grand_total: 1 })).toBeNull();
	});
});

describe("specFromMetadataSchema", () => {
	it("returns null when the type declares no x-transitions", () => {
		expect(specFromMetadataSchema({ type: "object" })).toBeNull();
		expect(specFromMetadataSchema(null)).toBeNull();
	});

	it("parses a schema held as a JSON string", () => {
		const spec = specFromMetadataSchema(
			JSON.stringify({
				"x-transitions": { field: "s", states: { a: { to: [] } } },
			}),
		);
		expect(spec?.field).toBe("s");
	});

	it("throws on a declared but malformed spec (fails closed)", () => {
		expect(() =>
			specFromMetadataSchema({ "x-transitions": { field: "s" } }),
		).toThrow(/states must be a non-empty object/);
	});
});
