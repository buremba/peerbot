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
	ENTITY_CHANGE_APPROVAL_KIND,
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

	it("renders a button whose action the bridge can actually route", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [bound({ label: "Run tool", style: "primary", onClick: "@tool:sync:42" })],
			},
			data: {},
		});
		expect(buttons(card).map((b) => b.label)).toEqual(["Run tool"]);
		expect(buttons(card)[0].id).toBe("tool:sync:42");
		expect(buttons(card)[0].style).toBe("primary");
	});

	it("drops a control bound to an action nothing routes, and says so", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					bound({ label: "Retry sync", onClick: "@retry_sync" }),
					bound({ label: "Dead button" }),
				],
			},
			data: {},
			url: "https://app.lobu.ai/events/1",
		});
		// Neither is drawn: one has no action at all, the other has no route.
		expect(buttons(card).map((b) => b.label)).toEqual(["Open in Lobu"]);
		expect(texts(card).at(-1)).toBe("_*Retry sync* is only available in Lobu._");
	});

	it("names every unroutable control, not just the first", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [
					bound({ label: "Ignore", onClick: "@ignore_drift" }),
					bound({ label: "Disconnect", onClick: "@disconnect" }),
					{ type: "select", props: { label: "Reason", onChange: "@set_reason", options: [{ label: "Safe", value: "safe" }] } },
				],
			},
			data: {},
		});
		expect(buttons(card)).toEqual([]);
		expect(texts(card).at(-1)).toBe(
			"_*Disconnect*, *Ignore*, *Reason* are only available in Lobu._",
		);
	});

	it("keeps link buttons, which need no server round-trip", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [{ type: "link-button", props: { label: "Open runbook", url: "https://lobu.ai/runbook" } }],
			},
			data: {},
		});
		expect(buttons(card).map((b) => b.url)).toEqual(["https://lobu.ai/runbook"]);
	});

	it("resolves {{path}} interpolation in a control label", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [bound({ label: "Approve {{customer.name}} ({{items[0].qty}})", onClick: "@retry" })],
			},
			data: { customer: { name: "Acme" }, items: [{ qty: 12 }] },
		});
		// Unroutable, so it surfaces by name — with the binding already resolved.
		expect(texts(card).at(-1)).toBe("_*Approve Acme (12)* is only available in Lobu._");
	});

	it("interpolates a label that both starts and ends with a binding", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: [bound({ label: "{{customer.name}} · {{items[0].qty}}", onClick: "@retry" })],
			},
			data: { customer: { name: "Acme" }, items: [{ qty: 12 }] },
		});
		// Two bindings, so this is interpolation — not one path named `name}} · {{items[0].qty`.
		expect(texts(card).at(-1)).toBe("_*Acme · 12* is only available in Lobu._");
	});

	it("clamps the actions row to what Slack accepts", () => {
		const card = buildKindCard({
			jsonTemplate: {
				type: "card",
				children: Array.from({ length: 30 }, (_, i) =>
					bound({ label: `B${i}`, onClick: `@tool:a${i}` }),
				),
			},
			data: {},
		});
		expect(buttons(card)).toHaveLength(25);
	});

	it("puts routable template controls before the decision buttons", () => {
		const card = buildKindCard({
			jsonTemplate: { type: "card", children: [bound({ label: "Retry", onClick: "@tool:retry" })] },
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

describe("entity change approvals render through their kind", () => {
	const KIND = PLATFORM_EVENT_KINDS[ENTITY_CHANGE_APPROVAL_KIND];
	const build = (data: Record<string, unknown>) =>
		buildKindCard({
			metadataSchema: KIND.metadataSchema,
			jsonTemplate: KIND.jsonTemplate,
			data,
			title: "Approval needed",
			url: "https://app.lobu.ai/runs/991",
			decisionRunId: 991,
		});

	it("shows a field update as field / current / proposed rows", () => {
		const card = build({
			entityTypeLabel: "Person",
			entityName: "Ada Lovelace",
			requestedBy: "nightly-triage",
			why: "Changing a verified field needs approval.",
			action: null,
			proposal: [],
			diffs: [
				{ label: "Email", current: "ada@old.example", proposed: "ada@lovelace.dev" },
				{ label: "Location", current: null, proposed: "London, UK" },
			],
		});
		expect(rows(card)).toEqual([
			["Email", "ada@old.example", "ada@lovelace.dev"],
			["Location", "—", "London, UK"],
		]);
	});

	it("shows a create as one row per proposed field", () => {
		const card = build({
			entityTypeLabel: "Company",
			entityName: "Acme Robotics",
			action: "Create this entity",
			diffs: null,
			why: null,
			requestedBy: null,
			proposal: [
				{ label: "Name", value: "Acme Robotics" },
				{ label: "Domain", value: "acme.example" },
			],
		});
		expect(rows(card)).toEqual([
			["Name", "Acme Robotics"],
			["Domain", "acme.example"],
		]);
	});

	it("omits the optional header fields that have no value", () => {
		const card = build({
			entityTypeLabel: "Deal",
			entityName: null,
			requestedBy: null,
			why: null,
			action: null,
			proposal: [],
			diffs: [{ label: "Amount", current: "$1,200", proposed: "$18,400" }],
		});
		const fieldLabels = kids(card)
			.filter((c) => c.type === "fields")
			.flatMap((c) => (c.children as Array<{ label: string }>).map((f) => f.label));
		expect(fieldLabels).toEqual(["Type"]);
	});

	it("escapes the mrkdwn header fields but not the raw_text table cells", () => {
		const hostile = "<!channel> & <https://evil.example|Review in Lobu>";
		const card = build({
			entityTypeLabel: "Person",
			entityName: hostile,
			requestedBy: null,
			why: null,
			action: null,
			proposal: [],
			diffs: [{ label: "Bio", current: null, proposed: hostile }],
		});
		const entityField = kids(card)
			.filter((c) => c.type === "fields")
			.flatMap((c) => c.children as Array<{ label: string; value: string }>)
			.find((f) => f.label === "Entity");
		expect(entityField?.value).toBe(
			"&lt;!channel&gt; &amp; &lt;https://evil.example|Review in Lobu&gt;",
		);
		// Cells go out as raw_text, which Slack never parses — escaping here would
		// show the reader a literal `&lt;`.
		expect(rows(card)[0][2]).toBe(hostile);
	});

	it("escapes the subtitle — the adapter renders it as mrkdwn", () => {
		// The subtitle is the notification body, and an approval body carries the
		// connection name, which we do not author. `blocks.js` puts it through
		// `mrkdwn()`, so a raw `<!channel>` would ping the room from a trusted card.
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND.metadataSchema,
			data: { operation: "create_issue", connection: "GitHub", input: {} },
			subtitle: "<!channel> approve <https://evil.example|Review in Lobu>",
		});
		expect(card.subtitle).toBe(
			"&lt;!channel&gt; approve &lt;https://evil.example|Review in Lobu&gt;",
		);
	});

	it("still carries the decision buttons the bridge already routes", () => {
		const card = build({
			entityTypeLabel: "Person",
			entityName: "Ada",
			action: null,
			why: null,
			requestedBy: null,
			proposal: [],
			diffs: [{ label: "Email", current: "a", proposed: "b" }],
		});
		expect(buttons(card).map((b) => b.id ?? b.url)).toEqual([
			"run-approval:991:approve",
			"run-approval:991:reject",
			"https://app.lobu.ai/runs/991",
		]);
	});
});
