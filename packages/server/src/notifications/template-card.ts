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
	type ButtonElement,
	Card,
	type CardChild,
	type CardElement,
	CardText,
	Divider,
	Field,
	Fields,
	Image,
	LinkButton,
	type LinkButtonElement,
	Select,
	type SelectElement,
	SelectOption,
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
	| { kind: "field"; label: string; value: string }
	| { kind: "action"; element: ActionElement }
	| { kind: "block"; child: CardChild };

/** Anything Slack accepts inside an `actions` block. */
type ActionElement = ButtonElement | LinkButtonElement | SelectElement;

/**
 * Slack caps an actions block at 25 elements and rejects the whole message
 * past it. A template authors its buttons freely, so nothing upstream bounds
 * this.
 */
const MAX_ACTIONS = 25;
/** Prefix marking a button whose click routes to a template-declared action. */
export const TEMPLATE_ACTION_PREFIX = "template-action";

const str = (value: unknown, fallback = ""): string =>
	value === undefined || value === null ? fallback : String(value);

const buttonStyle = (value: unknown): "primary" | "danger" | undefined =>
	value === "primary" || value === "danger" ? value : undefined;

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
	component: (type, props, children, { actions }) => {
		if (PASSTHROUGH.has(type)) return children;
		if (type === "button") {
			const action = actions.onClick ?? actions.onPress ?? actions.onSubmit;
			// A button with no bound action cannot do anything when clicked, and a
			// dead control in an approval card is worse than an absent one.
			if (!action) return [];
			return [
				{
					kind: "action",
					element: Button({
						id: `${TEMPLATE_ACTION_PREFIX}:${action}`,
						label: clamp(str(props.label) || textOf(children) || action, 75),
						style: buttonStyle(props.style),
						value: str(props.value, action),
					}),
				},
			];
		}
		if (type === "link-button" || type === "link" || type === "a") {
			const url = str(props.url || props.href);
			if (!url) return [];
			return [
				{
					kind: "action",
					element: LinkButton({
						url,
						label: clamp(str(props.label) || textOf(children) || url, 75),
						style: buttonStyle(props.style),
					}),
				},
			];
		}
		if (type === "select") {
			const action = actions.onChange ?? actions.onSelect;
			if (!action || !Array.isArray(props.options)) return [];
			const options = (props.options as unknown[])
				.map((opt) => {
					const o = (opt ?? {}) as Record<string, unknown>;
					const value = str(o.value ?? o.label);
					return value
						? SelectOption({ label: clamp(str(o.label, value), 75), value })
						: null;
				})
				.filter((o): o is NonNullable<typeof o> => o !== null);
			if (options.length === 0) return [];
			return [
				{
					kind: "action",
					element: Select({
						id: `${TEMPLATE_ACTION_PREFIX}:${action}`,
						label: clamp(str(props.label) || str(props.placeholder) || action, 75),
						placeholder: str(props.placeholder) || undefined,
						options,
					}),
				},
			];
		}
		if (type === "image" || type === "img") {
			const url = str(props.url || props.src);
			return url
				? [{ kind: "block", child: Image({ url, alt: str(props.alt, "Image") }) }]
				: [];
		}
		if (type === "field") {
			return [
				{
					kind: "field",
					label: clamp(str(props.label), MAX_CELL_CHARS),
					value: clamp(str(props.value) || textOf(children), MAX_CELL_CHARS),
				},
			];
		}
		if (type === "fields") return children;
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
		// Text-ish leaves the chat card can carry faithfully as prose.
		if (type === "code" || type === "pre") {
			const body = textOf(children) || str(props.value);
			return body ? [{ kind: "text", text: `\`\`\`\n${body}\n\`\`\`` }] : [];
		}
		if (
			type === "markdown" ||
			type === "badge" ||
			type === "heading" ||
			type === "h1" ||
			type === "h2" ||
			type === "h3" ||
			type === "strong" ||
			type === "em" ||
			type === "label"
		) {
			const body = textOf(children) || str(props.children) || str(props.value);
			return body ? [{ kind: "text", text: body }] : [];
		}
		// Unknown component. Returning nothing marks it unsupported so the caller
		// can link out rather than present a partial record as complete.
		return [];
	},
};

function fragsToChildren(frags: Frag[]): {
	children: CardChild[];
	actions: ActionElement[];
} {
	const children: CardChild[] = [];
	const actions: ActionElement[] = [];
	let pendingText: string[] = [];
	let pendingFields: Array<{ label: string; value: string }> = [];

	const flushText = () => {
		const text = pendingText.join("\n").trim();
		pendingText = [];
		if (text) children.push(CardText(clamp(escapeSlackText(text), MAX_TEXT_CHARS)));
	};
	const flushFields = () => {
		const batch = pendingFields;
		pendingFields = [];
		if (batch.length === 0) return;
		children.push(
			Fields(
				// Slack rejects the message past 10 fields per section, and applies
				// its 2000-char cap to the RENDERED `*label*\nvalue`, so the two
				// share one budget.
				batch.slice(0, 10).map((f) => {
					const label = escapeSlackText(f.label);
					return Field({
						label,
						value:
							clamp(escapeSlackText(f.value), MAX_TEXT_CHARS - label.length) || "—",
					});
				}),
			),
		);
	};
	const flush = () => {
		flushText();
		flushFields();
	};

	for (const frag of frags) {
		if (frag.kind === "action") {
			actions.push(frag.element);
			continue;
		}
		if (frag.kind === "field") {
			flushText();
			pendingFields.push(frag);
			continue;
		}
		flushFields();
		if (frag.kind === "block") {
			flushText();
			children.push(frag.child);
			continue;
		}
		// A stray row/cell outside a table still carries data; keep it readable
		// rather than dropping it.
		if (frag.kind === "row") pendingText.push(frag.cells.join(": "));
		else pendingText.push(frag.text);
	}
	flush();
	return { children, actions };
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
	const { children, actions: templateActions } = fragsToChildren(
		walkTemplate(template, params.data, cardVisitor, unsupported),
	);
	if (children.length === 0 && templateActions.length === 0) return null;

	if (unsupported.size > 0) {
		children.push(
			CardText(
				`_This view uses ${[...unsupported].sort().join(", ")}, which chat cannot render — open it in Lobu for the full record._`,
			),
		);
	}

	const actions: ActionElement[] = [...templateActions];
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
	if (actions.length > 0) children.push(Actions(actions.slice(0, MAX_ACTIONS)));

	return Card({
		title: params.title,
		subtitle: params.subtitle,
		children,
	});
}
