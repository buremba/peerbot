/**
 * Chat cards for kind-bearing notifications.
 *
 * There is ONE pipeline: kind -> `resolveEntityRender` -> `walkTemplate` ->
 * card. So the tests that matter are: the template's structure survives the
 * walk (a `tr` becomes a row, `if`/`each` behave as the web renderer does), the
 * platform's escaping rules are applied per destination, and a component chat
 * cannot draw resolves to a link instead of a silent partial record.
 *
 * There is deliberately no "chat matches web" parity test any more: both read
 * the same `resolveEntityRender` output, so agreement is structural rather than
 * something an assertion could drift away from.
 */

import { describe, expect, it } from "bun:test";
import { buildKindCard } from "../../notifications/template-card";
import {
	CONNECTOR_OPERATION_APPROVAL_KIND,
	PLATFORM_EVENT_KINDS,
} from "../../utils/platform-event-kinds";

const APPROVAL_KIND = PLATFORM_EVENT_KINDS[CONNECTOR_OPERATION_APPROVAL_KIND];

type Card = NonNullable<ReturnType<typeof buildKindCard>>;
const kids = (card: Card | null) =>
	(card?.children ?? []) as Array<Record<string, unknown>>;

/**
 * Data rows of the first table. The card AST keeps `headers` separate from
 * `rows` — it is the Slack adapter that prepends the header row — so these are
 * already the data rows.
 */
function rows(card: Card | null): string[][] {
	const table = kids(card).find((c) => c.type === "table");
	return (table?.rows as string[][]) ?? [];
}
const texts = (card: Card | null) =>
	kids(card)
		.filter((c) => c.type === "text")
		.map((c) => c.content as string);
const buttons = (card: Card | null) =>
	kids(card)
		.filter((c) => c.type === "actions")
		.flatMap((c) => c.children as Array<Record<string, unknown>>);

const schema = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
});

describe("default template (no authored json_template)", () => {
	it("renders one row per schema field, label then value", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			data: {
				operation: "create_issue",
				connection: "GitHub",
				input: { title: "Fix it" },
			},
		});
		expect(rows(card)).toEqual([
			["Operation", "create_issue"],
			["Connection", "GitHub"],
			["Input", "Title: Fix it"],
		]);
	});

	it("honours x-table-column order, x-table-label, title and x-hidden", () => {
		const card = buildKindCard({
			metadataSchema: schema({
				later: { type: "string", "x-table-column": 2, title: "Later" },
				first: { type: "string", "x-table-column": 1, title: "First" },
				secret: { type: "string", "x-hidden": true, title: "Secret" },
				renamed: { type: "string", "x-table-column": 3, "x-table-label": "Renamed" },
			}),
			data: { first: "a", later: "b", secret: "nope", renamed: "c" },
		});
		expect(rows(card)).toEqual([
			["First", "a"],
			["Later", "b"],
			["Renamed", "c"],
		]);
	});

	it("falls back to the template's placeholder for a missing value", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			data: { operation: "x", connection: null, input: undefined },
		});
		expect(rows(card)).toEqual([
			["Operation", "x"],
			["Connection", "—"],
			["Input", "—"],
		]);
	});

	it("returns null when there is no template to render", () => {
		expect(buildKindCard({ metadataSchema: null, data: {} })).toBeNull();
		expect(buildKindCard({ metadataSchema: schema({}), data: {} })).toBeNull();
	});
});

describe("authored json_template", () => {
	it("is rendered rather than skipped", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			jsonTemplate: {
				type: "card",
				children: [
					{ type: "text", content: "Deploy approval" },
					{
						type: "table",
						children: [
							{
								type: "tbody",
								children: [
									{
										type: "tr",
										children: [
											{ type: "th", children: [{ type: "text", content: "Service" }] },
											{ type: "td", children: [{ type: "data", path: "operation" }] },
										],
									},
								],
							},
						],
					},
				],
			},
			data: { operation: "deploy" },
		});
		expect(texts(card)).toEqual(["Deploy approval"]);
		expect(rows(card)).toEqual([["Service", "deploy"]]);
	});

	it("takes the if branch matching the data, like the web renderer", () => {
		const template = {
			type: "card",
			children: [
				{
					type: "if",
					condition: "urgent",
					then: { type: "text", content: "URGENT" },
					else: { type: "text", content: "routine" },
				},
			],
		};
		expect(
			texts(buildKindCard({ jsonTemplate: template, data: { urgent: true } })),
		).toEqual(["URGENT"]);
		expect(
			texts(buildKindCard({ jsonTemplate: template, data: { urgent: false } })),
		).toEqual(["routine"]);
	});

	it("iterates each with the loop variable in scope", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					{
						type: "table",
						children: [
							{
								type: "each",
								items: "lines",
								as: "r",
								render: {
									type: "tr",
									children: [
										{ type: "th", children: [{ type: "data", path: "r.name" }] },
										{ type: "td", children: [{ type: "data", path: "r.qty" }] },
									],
								},
							},
						],
					},
				],
			},
			data: { lines: [{ name: "Widgets", qty: 12 }, { name: "Gadgets", qty: 3 }] },
		});
		expect(rows(card)).toEqual([
			["Widgets", "12"],
			["Gadgets", "3"],
		]);
	});

	it("substitutes the loop variable in the each string shorthand", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					{ type: "each", items: "tags", as: "t", render: "- {{t}}" },
				],
			},
			data: { tags: ["alpha", "beta"] },
		});
		expect(texts(card)).toEqual(["- alpha\n- beta"]);
	});

	it("names components it cannot draw and links out instead of guessing", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					{ type: "text", content: "Rollup" },
					{ type: "entity-board", props: { boardId: "q3" } },
					{ type: "bar-chart", props: {} },
				],
			},
			data: {},
			url: "https://app.lobu.ai/events/1",
		});
		const note = texts(card).at(-1) ?? "";
		expect(note).toContain("bar-chart, entity-board");
		expect(note).toContain("open it in Lobu");
		expect(buttons(card)).toHaveLength(1);
	});
});

describe("Slack escaping is per destination", () => {
	const hostile = "<!channel> & <https://evil.example|Review in Lobu>";

	it("leaves table cells unescaped — the adapter emits them as raw_text", () => {
		const card = buildKindCard({
			metadataSchema: schema({ v: { type: "string", title: "V" } }),
			data: { v: hostile },
		});
		// Escaping here would show the reader a literal `&lt;`.
		expect(rows(card)).toEqual([["V", hostile]]);
	});

	it("escapes free text, which the adapter emits as mrkdwn", () => {
		const card = buildKindCard({
			jsonTemplate: { type: "card", children: [{ type: "text", content: hostile }] },
			data: {},
		});
		expect(texts(card)[0]).toBe(
			"&lt;!channel&gt; &amp; &lt;https://evil.example|Review in Lobu&gt;",
		);
	});
});

describe("decision actions", () => {
	it("carries Approve/Reject bound to the run, plus the review link", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			data: { operation: "run" },
			url: "https://app.lobu.ai/events/1",
			decisionRunId: 77,
		});
		expect(buttons(card).map((b) => b.id ?? b.url)).toEqual([
			"run-approval:77:approve",
			"run-approval:77:reject",
			"https://app.lobu.ai/events/1",
		]);
		expect(buttons(card).map((b) => b.style)).toEqual([
			"primary",
			"danger",
			undefined,
		]);
	});

	it("offers only the link when there is no run to decide", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			data: { operation: "run" },
			url: "https://app.lobu.ai/events/1",
		});
		expect(buttons(card).map((b) => b.label)).toEqual(["Open in Lobu"]);
	});

	it("omits the actions row entirely with no run and no url", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			data: { operation: "run" },
		});
		expect(buttons(card)).toEqual([]);
	});
});

describe("platform limits", () => {
	it("clamps a cell so a huge value cannot cost the message its delivery", () => {
		const card = buildKindCard({
			metadataSchema: schema({ v: { type: "string", title: "V" } }),
			data: { v: "x".repeat(6000) },
		});
		const cell = rows(card)[0][1];
		expect(cell.length).toBeLessThanOrEqual(400);
		expect(cell.endsWith("…")).toBe(true);
	});

	it("keeps every row rectangular so Slack accepts the table", () => {
		const card = buildKindCard({
			metadataSchema: schema({
				a: { type: "string", title: "A" },
				b: { type: "string", title: "B" },
			}),
			data: { a: "1", b: "2" },
		});
		const table = kids(card).find((c) => c.type === "table") as {
			headers: string[];
			rows: string[][];
		};
		const width = table.headers.length;
		expect(width).toBe(2);
		for (const row of table.rows) expect(row).toHaveLength(width);
	});
});

describe("template-declared controls", () => {
	const bound = (props: Record<string, unknown>) => ({ type: "button", props });

	it("renders a bound button, and drops one that cannot do anything", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					bound({ label: "Retry sync", style: "primary", onClick: "@retry_sync" }),
					bound({ label: "Dead button" }),
				],
			},
			data: {},
		});
		expect(buttons(card).map((b) => b.label)).toEqual(["Retry sync"]);
		expect(buttons(card)[0].id).toBe("template-action:retry_sync");
		expect(buttons(card)[0].style).toBe("primary");
	});

	it("resolves {{path}} interpolation in a button label", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [bound({ label: "Approve {{customer.name}} ({{items[0].qty}})", onClick: "@go" })],
			},
			data: { customer: { name: "Acme" }, items: [{ qty: 12 }] },
		});
		expect(buttons(card)[0].label).toBe("Approve Acme (12)");
	});

	it("drops a select with no options and keeps one with them", () => {
		const withOpts = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					{ type: "select", props: { label: "Reason", onChange: "@set_reason", options: [{ label: "Safe", value: "safe" }] } },
					{ type: "select", props: { label: "Empty", onChange: "@x", options: [] } },
				],
			},
			data: {},
		});
		expect(buttons(withOpts)).toHaveLength(1);
		expect(buttons(withOpts)[0].id).toBe("template-action:set_reason");
	});

	it("clamps the actions row to what Slack accepts", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: Array.from({ length: 30 }, (_, i) =>
					bound({ label: `B${i}`, onClick: `@a${i}` }),
				),
			},
			data: {},
		});
		expect(buttons(card)).toHaveLength(25);
	});

	it("puts template controls before the decision buttons", () => {
		const card = buildKindCard({
			jsonTemplate: { type: "card", children: [bound({ label: "Retry", onClick: "@retry" })] },
			data: {},
			url: "https://app.lobu.ai/events/1",
			decisionRunId: 9001,
		});
		expect(buttons(card).map((b) => b.label)).toEqual([
			"Retry",
			"Approve",
			"Reject",
			"Review in Lobu",
		]);
	});
});

describe("structural edge cases", () => {
	it("takes the else branch when the condition path is missing", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [{ type: "if", condition: "nope.deep.path", then: { type: "text", content: "THEN" }, else: { type: "text", content: "ELSE" } }],
			},
			data: {},
		});
		expect(texts(card)).toEqual(["ELSE"]);
	});

	it("emits no table at all for an empty each", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					{ type: "text", content: "No rows." },
					{ type: "table", children: [{ type: "tbody", children: [{ type: "each", items: "none", as: "x", render: { type: "tr", children: [{ type: "td", children: [{ type: "data", path: "x" }] }] } }] }] },
				],
			},
			data: { none: [] },
		});
		expect(kids(card).some((c) => c.type === "table")).toBe(false);
	});

	it("pads ragged rows so Slack accepts the table", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [{ type: "table", children: [{ type: "tbody", children: [
					{ type: "tr", children: [{ type: "td", children: [{ type: "text", content: "a" }] }, { type: "td", children: [{ type: "text", content: "b" }] }, { type: "td", children: [{ type: "text", content: "c" }] }] },
					{ type: "tr", children: [{ type: "td", children: [{ type: "text", content: "d" }] }] },
				] }] }],
			},
			data: {},
		});
		expect(rows(card)).toEqual([["a", "b", "c"], ["d", "", ""]]);
	});

	it("nests each inside each with both scopes in view", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [{ type: "table", children: [{ type: "tbody", children: [
					{ type: "each", items: "groups", as: "g", render: { type: "each", items: "g.rows", as: "r", render: { type: "tr", children: [
						{ type: "th", children: [{ type: "data", path: "g.name" }] },
						{ type: "td", children: [{ type: "data", path: "r" }] },
					] } } },
				] }] }],
			},
			data: { groups: [{ name: "G1", rows: ["x", "y"] }, { name: "G2", rows: ["z"] }] },
		});
		expect(rows(card)).toEqual([["G1", "x"], ["G1", "y"], ["G2", "z"]]);
	});
});
