/**
 * Build the chat card for a kind-bearing notification.
 *
 * ONE PIPELINE: kind -> json_template -> card. `resolveEntityRender` already
 * yields a template for every kind — the authored `json_template` when there is
 * one, otherwise the default synthesized from `metadataSchema` — so chat reads
 * the same tree the web and MCP surfaces render. Nothing here looks at
 * `metadataSchema`; deriving a second layout from it is what made chat and web
 * disagree by construction.
 *
 * `walkTemplate` (in `@lobu/core/json-template`) owns every structural decision
 * — path resolution, `if` truthiness, `each` scoping, the string shorthand — so
 * this file only decides how a node BECOMES Slack/Teams/GChat card content.
 *
 * A template may invoke components chat has no equivalent for (entity-board,
 * charts). Those are collected as `unsupported` rather than guessed at, and the
 * card links out to the full record instead of quietly showing a subset.
 */
import {
	type TemplateNode,
	type TemplateVisitor,
	walkTemplate,
} from "@lobu/core/json-template";
import {
	Actions,
	Button,
	Card,
	type CardChild,
	type CardElement,
	CardText,
	Divider,
	LinkButton,
	Table,
} from "chat";
import { resolveEntityRender } from "../utils/default-entity-template";

/** Slack degrades a table past these to an ASCII code fence; keep it native. */
const MAX_ROWS = 100;
const MAX_COLS = 20;
/** No documented cap on a table cell; stay well inside the 2000 mrkdwn limit. */
const MAX_CELL_CHARS = 400;
const MAX_TEXT_CHARS = 1900;

/**
 * Escape text bound for Slack **mrkdwn**.
 *
 * Load-bearing: a card renders a connector operation's INPUT, which the agent
 * controls. Unescaped, `<!channel>` pings the room from inside a trusted
 * approval card and `<https://evil|Review in Lobu>` renders a link spoofing the
 * genuine one.
 *
 * NOT applied to table cells: the Slack adapter emits those as `raw_text`,
 * which is not parsed for entities, so escaping there would render a literal
 * `&lt;` to the reader.
 */
export function escapeSlackText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function clamp(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * What the walk emits. Cells and rows are intermediate: a `td` cannot know
 * whether it is inside a table until its `tr`, and a `tr` cannot become a card
 * child on its own.
 */
type Frag =
	| { kind: "text"; text: string }
	| { kind: "cell"; text: string }
	| { kind: "row"; cells: string[] }
	| { kind: "block"; child: CardChild };

/** Layout-only wrappers: they carry no content of their own, so pass through. */
const PASSTHROUGH = new Set([
	"card",
	"card-content",
	"card-header",
	"card-body",
	"div",
	"span",
	"p",
	"section",
	"tbody",
	"thead",
	"fragment",
]);

const textOf = (frags: Frag[]): string =>
	frags
		.map((f) => (f.kind === "text" || f.kind === "cell" ? f.text : ""))
		.join("")
		.trim();

const cardVisitor: TemplateVisitor<Frag> = {
	text: (content) => [{ kind: "text", text: content }],
	value: (rendered) => [{ kind: "text", text: rendered }],
	component: (type, _props, children) => {
		if (PASSTHROUGH.has(type)) return children;
		if (type === "th" || type === "td") {
			return [{ kind: "cell", text: clamp(textOf(children), MAX_CELL_CHARS) }];
		}
		if (type === "tr") {
			const cells = children
				.filter((c): c is Extract<Frag, { kind: "cell" }> => c.kind === "cell")
				.map((c) => c.text);
			return cells.length > 0 ? [{ kind: "row", cells }] : [];
		}
		if (type === "table") {
			const rows = children
				.filter((c): c is Extract<Frag, { kind: "row" }> => c.kind === "row")
				.map((c) => c.cells)
				.slice(0, MAX_ROWS);
			if (rows.length === 0) return [];
			const width = Math.min(
				rows.reduce((w, r) => Math.max(w, r.length), 0),
				MAX_COLS,
			);
			// Slack's native table always renders its first row as the header, and
			// the default entity template has no `thead` — its `th` is a per-row
			// label in column 0. Blank headers keep the shape rectangular without
			// inventing column names the template never declared.
			return [
				{
					kind: "block",
					child: Table({
						headers: Array.from({ length: width }, () => ""),
						rows: rows.map((r) =>
							Array.from({ length: width }, (_, i) => r[i] ?? ""),
						),
					}),
				},
			];
		}
		if (type === "divider" || type === "hr") {
			return [{ kind: "block", child: Divider() }];
		}
		// Unknown component. Returning nothing marks it unsupported so the caller
		// can link out rather than present a partial record as complete.
		return [];
	},
};

function fragsToChildren(frags: Frag[]): CardChild[] {
	const children: CardChild[] = [];
	let pending: string[] = [];
	const flush = () => {
		const text = pending.join("\n").trim();
		pending = [];
		if (text) children.push(CardText(clamp(escapeSlackText(text), MAX_TEXT_CHARS)));
	};
	for (const frag of frags) {
		if (frag.kind === "block") {
			flush();
			children.push(frag.child);
			continue;
		}
		// A stray row/cell outside a table still carries data; keep it readable
		// rather than dropping it.
		if (frag.kind === "row") pending.push(frag.cells.join(": "));
		else pending.push(frag.text);
	}
	flush();
	return children;
}

export function buildKindCard(params: {
	metadataSchema?: Record<string, unknown> | null;
	jsonTemplate?: Record<string, unknown> | null;
	data: Record<string, unknown>;
	title?: string;
	subtitle?: string;
	/** Permalink to the event, so the full rendering is always one click away. */
	url?: string | null;
	/**
	 * Run this card can decide. When set, the card carries Approve/Reject; the
	 * click is authorized in `interaction-bridge` against a Slack identity that
	 * maps to an org admin/owner, and executes through the same
	 * `manage_operations approve|reject` the web review uses.
	 */
	decisionRunId?: number | null;
}): CardElement | null {
	const template = resolveEntityRender(
		params.jsonTemplate ?? null,
		params.metadataSchema,
	) as TemplateNode | null;
	if (!template) return null;

	const unsupported = new Set<string>();
	const children = fragsToChildren(
		walkTemplate(template, params.data, cardVisitor, unsupported),
	);
	if (children.length === 0) return null;

	if (unsupported.size > 0) {
		children.push(
			CardText(
				`_This view uses ${[...unsupported].sort().join(", ")}, which chat cannot render — open it in Lobu for the full record._`,
			),
		);
	}

	const actions = [];
	if (params.decisionRunId) {
		actions.push(
			Button({
				id: `run-approval:${params.decisionRunId}:approve`,
				label: "Approve",
				style: "primary",
				value: "approve",
			}),
			Button({
				id: `run-approval:${params.decisionRunId}:reject`,
				label: "Reject",
				style: "danger",
				value: "reject",
			}),
		);
	}
	if (params.url) {
		actions.push(
			LinkButton({
				url: params.url,
				label: params.decisionRunId ? "Review in Lobu" : "Open in Lobu",
			}),
		);
	}
	if (actions.length > 0) children.push(Actions(actions));

	return Card({
		title: params.title,
		subtitle: params.subtitle,
		children,
	});
}
