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

/** URLs of link buttons in the card's Actions row. */
function links(card: ReturnType<typeof buildKindCard>): string[] {
	const out: string[] = [];
	for (const child of card?.children ?? []) {
		if (child.type !== "actions") continue;
		for (const a of child.children) {
			if ("url" in a && typeof a.url === "string") out.push(a.url);
		}
	}
	return out;
}

/** `id|label` of each decision button. */
function buttons(card: ReturnType<typeof buildKindCard>): string[] {
	const out: string[] = [];
	for (const child of card?.children ?? []) {
		if (child.type !== "actions") continue;
		for (const a of child.children) {
			if ("id" in a && typeof a.id === "string") out.push(`${a.id}|${a.label}`);
		}
	}
	return out;
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

	it("truncates an oversized value within the shared field budget", () => {
		const card = wide(1, 4000);
		const [label, value] = (fields(card)[0] ?? "").split("=");
		expect((label?.length ?? 0) + (value?.length ?? 0)).toBeLessThanOrEqual(1900);
		expect(value?.endsWith("…")).toBe(true);
	});
});

describe("decision buttons", () => {
	/**
	 * The ids are the contract with `interaction-bridge`'s `run-approval:` click
	 * handler — it parses runId and decision straight out of them, so a rename
	 * here silently produces buttons that do nothing.
	 */
	it("renders Approve/Reject bound to the run", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND?.metadataSchema,
			data: { operation: "Run shell command", connection: "Mac Shell", input: { command: "ls" } },
			title: 'Action "run" needs approval',
			url: "https://app.lobu.dev/o/acme/runs/4821",
			decisionRunId: 4821,
		});
		expect(buttons(card)).toEqual([
			"run-approval:4821:approve|Approve",
			"run-approval:4821:reject|Reject",
		]);
		expect(links(card)).toEqual(["https://app.lobu.dev/o/acme/runs/4821"]);
	});

	it("omits buttons when there is no run to decide", () => {
		const card = buildKindCard({
			metadataSchema: APPROVAL_KIND?.metadataSchema,
			data: { operation: "x", connection: "y", input: {} },
			url: "https://app.lobu.dev/o/acme/events/7",
		});
		expect(buttons(card)).toEqual([]);
		expect(links(card)).toEqual(["https://app.lobu.dev/o/acme/events/7"]);
	});
});

describe("Slack mrkdwn injection", () => {
	/**
	 * This card renders a connector operation's INPUT, which the agent controls.
	 * Unescaped, `<!channel>` pings the room from inside a trusted approval card
	 * and `<https://evil|Review in Lobu>` renders a link that spoofs the real
	 * review link sitting right next to it.
	 */
	const injected = (value: string) =>
		fields(
			buildKindCard({
				metadataSchema: { type: "object", properties: { a: { type: "string", title: "A" } } },
				data: { a: value },
			}),
		)[0] ?? "";

	it("neutralises a channel-wide ping", () => {
		expect(injected("ping <!channel> now")).toBe("A=ping &lt;!channel&gt; now");
	});

	it("neutralises a spoofed review link", () => {
		expect(injected("<https://evil.example|Review in Lobu>")).toBe(
			"A=&lt;https://evil.example|Review in Lobu&gt;",
		);
	});

	it("escapes ampersands before angle brackets, not after", () => {
		// `&` first, else `<` → `&lt;` would be re-escaped into `&amp;lt;`.
		expect(injected("a & <b>")).toBe("A=a &amp; &lt;b&gt;");
	});

	it("escapes the label too", () => {
		const card = buildKindCard({
			metadataSchema: { type: "object", properties: { a: { type: "string", title: "<!here>" } } },
			data: { a: "v" },
		});
		expect(fields(card)[0]).toBe("&lt;!here&gt;=v");
	});
});

describe("the field budget is shared, not per-part", () => {
	/**
	 * Slack's 2000-char cap applies to the RENDERED field (`*label*\nvalue`).
	 * Clamping label and value independently is how a long label plus a long
	 * value produced a 3600-char field and lost the entire message.
	 */
	const rendered = (labelChars: number, valueChars: number) => {
		const card = buildKindCard({
			metadataSchema: { type: "object", properties: { a: { type: "string", title: "L".repeat(labelChars) } } },
			data: { a: "v".repeat(valueChars) },
		});
		const f = fields(card)[0] ?? "";
		// `label=value` in the helper; Slack renders `*label*\nvalue` — same budget.
		return f.length;
	};

	it("keeps a long label AND long value inside one field budget", () => {
		expect(rendered(2000, 4000)).toBeLessThanOrEqual(2000);
	});

	it("still gives a short label the full remaining budget", () => {
		expect(rendered(5, 4000)).toBeGreaterThan(1500);
	});

	it("renders a whitespace-only value as unset", () => {
		const card = buildKindCard({
			metadataSchema: { type: "object", properties: { a: { type: "string", title: "A" } } },
			data: { a: "   \t " },
		});
		expect(fields(card)).toEqual(["A=—"]);
	});
});
