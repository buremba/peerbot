/**
 * Chat cards for kind-bearing notifications.
 *
 * Chat builds its card from the kind's `metadataSchema` — a closed shape —
 * rather than walking the open-ended `json_template`, so the tests that matter
 * are: the fields match what the web default template shows (same order, same
 * labels, same values), the platform's hard limits are respected, and anything
 * chat cannot render resolves to a link instead of a guess.
 */

import { describe, expect, it } from "bun:test";
import { buildKindCard } from "../../notifications/template-card";
import {
	CONNECTOR_OPERATION_APPROVAL_KIND,
	PLATFORM_EVENT_KINDS,
} from "../../utils/platform-event-kinds";

const APPROVAL_KIND = PLATFORM_EVENT_KINDS[CONNECTOR_OPERATION_APPROVAL_KIND];

/** `label=value` for each field, in card order. */
function fields(card: ReturnType<typeof buildKindCard>): string[] {
	const out: string[] = [];
	for (const child of card?.children ?? []) {
		if (child.type === "fields") {
			for (const f of child.children) out.push(`${f.label}=${f.value}`);
		}
	}
	return out;
}

function links(card: ReturnType<typeof buildKindCard>): string[] {
	return (card?.children ?? [])
		.filter((c) => c.type === "link")
		.map((c) => (c as { url: string }).url);
}

const schema = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
});

describe("the connector-operation approval kind", () => {
	it("shows the operation, connection and input a decision needs", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND?.metadataSchema,
			jsonTemplate: APPROVAL_KIND?.jsonTemplate,
			data: {
				operation: "Run shell command",
				connection: "Mac Shell",
				input: { command: "git status --porcelain", cwd: "/Users/burakemre" },
			},
			title: 'Action "run" needs approval',
		});

		// The reported bug: the chat post named neither the operation nor its
		// arguments, so the approver could not decide from the notification.
		expect(fields(card)).toEqual([
			"Operation=Run shell command",
			"Connection=Mac Shell",
			"Input=Command: git status --porcelain; Cwd: /Users/burakemre",
		]);
		expect(card?.title).toBe('Action "run" needs approval');
	});

	it("orders fields by x-table-column, not object order", () => {
		const card = buildKindCard({
			metadataSchema: schema({
				last: { type: "string", title: "Last", "x-table-column": 9 },
				first: { type: "string", title: "First", "x-table-column": 1 },
			}),
			data: { last: "b", first: "a" },
		});
		expect(fields(card)).toEqual(["First=a", "Last=b"]);
	});

	it("uses the schema's label rules", () => {
		const card = buildKindCard({
			metadataSchema: schema({
				operation_key: { type: "string" },
				b: { type: "string", title: "Titled" },
				c: { type: "string", "x-table-label": "Override", title: "Ignored" },
			}),
			data: { operation_key: "1", b: "2", c: "3" },
		});
		expect(fields(card)).toEqual([
			"Operation Key=1",
			"Titled=2",
			"Override=3",
		]);
	});

	it("skips x-hidden fields", () => {
		const card = buildKindCard({
			metadataSchema: schema({
				shown: { type: "string" },
				secret: { type: "string", "x-hidden": true },
			}),
			data: { shown: "a", secret: "b" },
		});
		expect(fields(card)).toEqual(["Shown=a"]);
	});

	it("marks a missing value rather than dropping the field", () => {
		const card = buildKindCard({
			metadataSchema: schema({ a: { type: "string" }, b: { type: "string" } }),
			data: { a: "set" },
		});
		expect(fields(card)).toEqual(["A=set", "B=—"]);
	});
});

describe("linking out", () => {
	it("appends the event link when a url is given", () => {
		const card = buildKindCard({
			metadataSchema: schema({ a: { type: "string" } }),
			data: { a: "1" },
			url: "https://lobu.dev/o/acme/runs/42",
		});
		expect(links(card)).toEqual(["https://lobu.dev/o/acme/runs/42"]);
	});

	it("does not render an authored jsonTemplate — chat links out instead", () => {
		// An authored template usually exists to get a chart or entity board,
		// which has no chat equivalent. Guessing at it is worse than the body +
		// its link, so the card is declined entirely.
		const card = buildKindCard({
			metadataSchema: schema({ a: { type: "string" } }),
			jsonTemplate: { type: "bar-chart" },
			data: { a: "1" },
			url: "https://lobu.dev/o/acme/events/7",
		});
		expect(card).toBeNull();
	});

	it("declines when the schema has no usable fields", () => {
		expect(buildKindCard({ metadataSchema: null, data: {} })).toBeNull();
		expect(buildKindCard({ metadataSchema: schema({}), data: {} })).toBeNull();
	});
});

describe("chat platform limits", () => {
	/**
	 * Slack rejects the ENTIRE message when a section carries more than 10
	 * fields or a field longer than 2000 chars — so an unclamped card costs the
	 * notification its delivery, not just its formatting.
	 */
	const wide = (count: number, chars: number) => {
		const properties: Record<string, unknown> = {};
		const data: Record<string, unknown> = {};
		for (let i = 1; i <= count; i++) {
			properties[`f${i}`] = { type: "string", "x-table-column": i };
			data[`f${i}`] = "x".repeat(chars);
		}
		return buildKindCard({
			metadataSchema: schema(properties),
			data,
			url: "https://lobu.dev/o/acme/events/7",
		});
	};

	it("caps fields at 10 and still links to the whole thing", () => {
		const card = wide(15, 3);
		expect(fields(card).length).toBe(10);
		expect(links(card).length).toBe(1);
	});

	it("truncates an oversized value", () => {
		const card = wide(1, 4000);
		const value = fields(card)[0]?.split("=")[1] ?? "";
		expect(value.length).toBeLessThanOrEqual(1800);
		expect(value.endsWith("…")).toBe(true);
	});
});
