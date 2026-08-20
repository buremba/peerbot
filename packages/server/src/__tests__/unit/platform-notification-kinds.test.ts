/**
 * Conformance for the platform notification kind registry.
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
import {
	ENTITY_CHANGE_APPROVAL_KIND,
	PLATFORM_NOTIFICATION_KINDS,
} from "../../utils/platform-notification-kinds";
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

const entries = Object.entries(PLATFORM_NOTIFICATION_KINDS);

describe("platform notification kinds", () => {
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

/**
 * The web renderer lays a `context` strip out with a flex `gap`, which applies
 * between DIRECT children only. A separator is NOT a direct child — it is
 * grouped with the value it introduces inside a `span`, so that `gap` never
 * reaches between them and the page reads "· requested byCRM sync". Chat
 * normalises whitespace and so never shows the defect, which is exactly why
 * nothing but this pins it.
 *
 * A standalone label (`Operation`) IS a direct child and needs no trailing
 * space, so the rule is scoped to the literals that carry a separator.
 */
describe("context separators keep their trailing space", () => {
	const SEPARATOR = "·";

	function contextLiterals(node: unknown, inContext: boolean, out: string[]): void {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) contextLiterals(child, inContext, out);
			return;
		}
		const n = node as Record<string, unknown>;
		const here = inContext || n.type === "context";
		if (here && n.type === "text" && typeof n.content === "string") {
			out.push(n.content);
		}
		for (const [key, value] of Object.entries(n)) {
			if (key === "type" || key === "content") continue;
			contextLiterals(value, here, out);
		}
	}

	for (const [slug, kind] of Object.entries(PLATFORM_NOTIFICATION_KINDS)) {
		if (!kind.jsonTemplate) continue;
		it(`${slug}: every separator literal ends with a space`, () => {
			const literals: string[] = [];
			contextLiterals(kind.jsonTemplate, false, literals);
			const separators = literals.filter((text) => text.includes(SEPARATOR));
			// A kind whose strip has no separator has nothing to pin; one that has
			// them must have found them here.
			expect(separators.every((text) => text.endsWith(" "))).toBe(true);
		});
	}

	it("finds the separators it claims to be checking", () => {
		// Without this the suite above passes vacuously the moment the walk stops
		// reaching into `if`/`span`, which is exactly where separators live.
		const literals: string[] = [];
		contextLiterals(
			PLATFORM_NOTIFICATION_KINDS[ENTITY_CHANGE_APPROVAL_KIND].jsonTemplate,
			false,
			literals,
		);
		expect(literals.filter((text) => text.includes(SEPARATOR))).toEqual([
			"· ",
			"· requested by ",
		]);
	});
});
