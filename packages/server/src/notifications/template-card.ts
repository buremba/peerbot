/**
 * Build the chat card for a kind-bearing notification.
 *
 * WHY NOT RENDER THE `json_template`: the DSL's component vocabulary is
 * deliberately open — `validate-json-template` refuses to allowlist it because
 * "the renderer's component set is extended app-side (entity-board,
 * entity-table, charts, …)". Walking it here would be a second renderer that
 * can never be faithful, that drifts every time the DSL grows, and that no
 * visual test covers. So chat reads the one input it CAN handle completely:
 * the kind's `metadataSchema`, a closed shape of properties + annotations.
 *
 * That is also the common case. `jsonTemplate` is optional and, per its own
 * docs, "when absent, rendering falls back to a default synthesized from
 * `metadataSchema`" — the schema-derived field table. A kind that DOES author a
 * template usually did so to get a component chat has no equivalent for, which
 * is exactly when guessing is worse than linking out.
 *
 * Ordering, hiding (`x-hidden`) and labelling (`x-table-label` / `title`) come
 * from `orderedSchemaFields`, the same helper the web/MCP default template
 * uses, so the surfaces agree by construction rather than by convention.
 *
 * Anything chat cannot show — an authored template, fields past the platform
 * cap, a truncated value — resolves the same way: show what fits and link to
 * the event.
 */
import { formatValue } from "@lobu/core/json-template";
import {
	Actions,
	Button,
	Card,
	type CardChild,
	type CardElement,
	Field,
	Fields,
	LinkButton,
} from "chat";
import { orderedSchemaFields } from "../utils/default-entity-template";

/**
 * Slack rejects the ENTIRE message when a section carries more than 10 fields
 * or a field longer than 2000 characters, so an unclamped card costs the
 * notification its delivery, not just its formatting. A schema is authored
 * freely, so nothing upstream bounds this.
 */
const MAX_FIELDS = 10;
const MAX_FIELD_CHARS = 1800;

function clamp(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function buildKindCard(params: {
	metadataSchema?: Record<string, unknown> | null;
	/** Presence means the kind authored its own template — chat links out. */
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
	if (params.jsonTemplate) return null;

	const schemaFields = orderedSchemaFields(params.metadataSchema);
	if (!schemaFields) return null;

	// No format directive, matching the default template's bare `data` bindings:
	// the point is that chat shows what the Memory view shows, so chat must not
	// reformat what the web leaves raw. Objects still get formatValue's compact
	// line-item text, which is how an operation's input becomes readable.
	const fields = schemaFields
		.map(({ key, label }) =>
			Field({
				label: clamp(label, MAX_FIELD_CHARS),
				value: clamp(formatValue(params.data[key]) || "—", MAX_FIELD_CHARS),
			}),
		)
		.filter((field) => field.label);
	if (fields.length === 0) return null;

	const children: CardChild[] = [Fields(fields.slice(0, MAX_FIELDS))];

	// Buttons and the link share one Actions row: a decision card should offer
	// the decision first and the full record second, not bury Approve under a
	// paragraph of fields.
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

	return Card({ title: params.title, subtitle: params.subtitle, children });
}
