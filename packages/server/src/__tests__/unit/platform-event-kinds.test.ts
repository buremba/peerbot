/**
 * Conformance for the platform event kind registry.
 *
 * Every kind here is a contract between a trigger that writes `payloadData` and
 * a template that reads it, and nothing at runtime tells you when the two drift
 * — a path that stops resolving renders as a blank cell, not an error. These
 * tests are that missing feedback.
 *
 * They reuse the production validator (`validateJsonTemplate`) rather than
 * re-checking node shape, so a change to the DSL's rules reaches the registry
 * automatically instead of via a second copy of the same knowledge.
 */

import { STRUCTURAL_NODE_TYPES } from "@lobu/core/json-template";
import { describe, expect, it } from "bun:test";
import { PLATFORM_EVENT_KINDS } from "../../utils/platform-event-kinds";
import { validateJsonTemplate } from "../../utils/validate-json-template";

type Node = Record<string, unknown>;

/** Root data keys a template reads, ignoring keys an enclosing `each` binds. */
function boundRoots(node: unknown, scoped: Set<string>, out: Set<string>): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) boundRoots(child, scoped, out);
		return;
	}
	const n = node as Node;
	const root = (path: string) => path.split(/[.[]/)[0];
	const record = (path: unknown) => {
		if (typeof path !== "string" || !path) return;
		const key = root(path);
		if (!scoped.has(key)) out.add(key);
	};

	if (n.type === "data") record(n.path);
	if (n.type === "if") {
		record(n.condition);
		boundRoots(n.then, scoped, out);
		boundRoots(n.else, scoped, out);
		return;
	}
	if (n.type === "each") {
		record(n.items);
		const inner = new Set(scoped);
		if (typeof n.as === "string") {
			inner.add(n.as);
			inner.add(`${n.as}Index`);
		}
		boundRoots(n.render, inner, out);
		return;
	}
	// `{{path}}` bindings inside component props read data too.
	for (const value of Object.values(n.props ?? {})) {
		if (typeof value !== "string") continue;
		for (const [, path] of value.matchAll(/\{\{(.+?)\}\}/g)) record(path.trim());
	}
	boundRoots(n.children, scoped, out);
}

const entries = Object.entries(PLATFORM_EVENT_KINDS);

describe("platform event kinds", () => {
	it("declares at least the families the triggers emit", () => {
		expect(entries.length).toBeGreaterThanOrEqual(5);
	});

	for (const [name, kind] of entries) {
		describe(name, () => {
			it("declares a metadataSchema with properties", () => {
				const properties = (kind.metadataSchema as { properties?: unknown } | undefined)
					?.properties;
				expect(properties && typeof properties === "object").toBe(true);
				expect(Object.keys(properties as object).length).toBeGreaterThan(0);
			});

			it("has a description, so the kind is legible where it is listed", () => {
				expect(typeof kind.description).toBe("string");
				expect((kind.description ?? "").length).toBeGreaterThan(0);
			});

			if (kind.jsonTemplate) {
				it("passes the production json_template validator", () => {
					expect(() => validateJsonTemplate(kind.jsonTemplate)).not.toThrow();
				});

				it("only binds paths its own metadataSchema declares", () => {
					const declared = new Set(
						Object.keys(
							((kind.metadataSchema as { properties?: object })?.properties ??
								{}) as object,
						),
					);
					const used = new Set<string>();
					boundRoots(kind.jsonTemplate, new Set(), used);
					const undeclared = [...used].filter((key) => !declared.has(key));
					expect(undeclared).toEqual([]);
				});
			}
		});
	}
});

describe("the validator and the renderers agree on the DSL", () => {
	it("validates every structural node type the renderers walk", () => {
		// A type added to STRUCTURAL_NODE_TYPES without a validator case would
		// fall through to the permissive component branch, so a malformed one
		// would save fine and fail silently at render — the exact failure mode
		// validate-json-template exists to prevent.
		for (const type of STRUCTURAL_NODE_TYPES) {
			expect(() => validateJsonTemplate({ type })).toThrow();
		}
	});

	it("still accepts an unknown component type, which is the point", () => {
		expect(() =>
			validateJsonTemplate({ type: "entity-board", props: { boardId: "q3" } }),
		).not.toThrow();
	});
});
