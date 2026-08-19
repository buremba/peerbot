/**
 * Event kinds the PLATFORM emits, as opposed to the ones an org authors in
 * `$member.event_kinds`.
 *
 * Event-kind resolution is otherwise entirely org-authored, which is right for
 * content an org models itself. But a notification the platform raises — an
 * approval, say — has a shape the platform owns and every org shares, and it
 * cannot require each org to have declared a kind before it renders. Declaring
 * it here gives it the same treatment as any other kind on every surface at
 * once: the Memory view, MCP apps, and chat all resolve through
 * `resolveEventKindDefinition`.
 *
 * These are a FALLBACK, consulted only after entity-type and `$member` kinds,
 * so an org that declares the same slug still wins and can restyle it.
 *
 * Prefer a `metadataSchema` to a hand-authored `jsonTemplate`: the schema alone
 * yields the default field table (`buildDefaultEntityTemplate`), which is what
 * these notifications want, and it stays declarative.
 */
import type { EventKindDefinition } from "./event-kind-validation";

export const CONNECTOR_OPERATION_APPROVAL_KIND = "connector_operation_approval";
export const ENTITY_CHANGE_APPROVAL_KIND = "entity_change_approval";
export const CONNECTION_AUTHORIZATION_KIND = "connection_authorization_needed";
export const BROWSER_SESSION_EXPIRED_KIND = "browser_session_expired";
export const INVITATION_RECEIVED_KIND = "invitation_received";

export const PLATFORM_EVENT_KINDS: Readonly<
	Record<string, EventKindDefinition>
> = {
	/**
	 * A connector operation queued behind approval. Before this existed the chat
	 * post said only that *an* action needed approval — never which operation, on
	 * which connection, with what input — so the decision could not be made from
	 * the notification.
	 */
	[CONNECTOR_OPERATION_APPROVAL_KIND]: {
		description: "A connector operation waiting for a human decision.",
		metadataSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					title: "Operation",
					"x-table-column": 1,
				},
				connection: {
					type: "string",
					title: "Connection",
					"x-table-column": 2,
				},
				input: {
					type: "object",
					title: "Input",
					"x-table-column": 3,
				},
			},
		},
	},
	/**
	 * An entity create / update / delete / merge waiting for a decision.
	 *
	 * This kind authors a `jsonTemplate` rather than leaning on the schema
	 * default, because the interesting content is a LIST — the proposed fields,
	 * or the before/after of each changed one — and a list is what `each`
	 * exists for. The alternative was a second bespoke formatter, which is the
	 * thing this pipeline replaced.
	 */
	[ENTITY_CHANGE_APPROVAL_KIND]: {
		description: "An entity change waiting for a human decision.",
		metadataSchema: {
			type: "object",
			properties: {
				action: { type: "string", title: "Action" },
				entityTypeLabel: { type: "string", title: "Type" },
				entityName: { type: "string", title: "Entity" },
				requestedBy: { type: "string", title: "Requested by" },
				why: { type: "string", title: "Why approval is needed" },
				diffs: { type: "array", title: "Changes", "x-hidden": true },
				proposal: { type: "array", title: "Proposal", "x-hidden": true },
			},
		},
		/**
		 * `text` nodes are literals — the DSL interpolates `{{path}}` in component
		 * PROPS only, matching owletto's renderer — so every value here is bound
		 * with a `data` node. Scalars go in a `fields` block (Slack lays them out
		 * side by side) and the list goes in the table, which is the one thing a
		 * field list cannot show well.
		 */
		jsonTemplate: {
			type: "card",
			children: [
				{
					type: "fields",
					children: [
						{
							type: "if",
							condition: "action",
							then: {
								type: "field",
								props: { label: "Action" },
								children: [{ type: "data", path: "action" }],
							},
						},
						{
							type: "field",
							props: { label: "Type" },
							children: [{ type: "data", path: "entityTypeLabel", fallback: "—" }],
						},
						{
							type: "if",
							condition: "entityName",
							then: {
								type: "field",
								props: { label: "Entity" },
								children: [{ type: "data", path: "entityName" }],
							},
						},
						{
							type: "if",
							condition: "requestedBy",
							then: {
								type: "field",
								props: { label: "Requested by" },
								children: [{ type: "data", path: "requestedBy" }],
							},
						},
						{
							type: "if",
							condition: "why",
							then: {
								type: "field",
								props: { label: "Why approval is needed" },
								children: [{ type: "data", path: "why" }],
							},
						},
					],
				},
				{
					type: "table",
					props: { caption: "Proposed change" },
					children: [
						{
							type: "tbody",
							children: [
								// An update: one row per changed field, current then proposed.
								{
									type: "each",
									items: "diffs",
									as: "d",
									render: {
										type: "tr",
										children: [
											{ type: "th", children: [{ type: "data", path: "d.label" }] },
											{ type: "td", children: [{ type: "data", path: "d.current", fallback: "—" }] },
											{ type: "td", children: [{ type: "data", path: "d.proposed", fallback: "—" }] },
										],
									},
								},
								// A create / delete / merge: one row per proposed field.
								{
									type: "each",
									items: "proposal",
									as: "p",
									render: {
										type: "tr",
										children: [
											{ type: "th", children: [{ type: "data", path: "p.label" }] },
											{ type: "td", children: [{ type: "data", path: "p.value", fallback: "—" }] },
										],
									},
								},
							],
						},
					],
				},
			],
		},
	},
	/**
	 * A connection that cannot sync until someone authorizes it.
	 *
	 * Schema-only, no authored template: these are a handful of scalars, which
	 * is exactly the case the default table was synthesized for. Authoring a
	 * template here would be a second layout to keep in step for no gain.
	 */
	[CONNECTION_AUTHORIZATION_KIND]: {
		description: "A connection waiting for OAuth authorization.",
		metadataSchema: {
			type: "object",
			properties: {
				connector: { type: "string", title: "Connector", "x-table-column": 1 },
				status: { type: "string", title: "Status", "x-table-column": 2 },
			},
		},
	},

	[BROWSER_SESSION_EXPIRED_KIND]: {
		description: "A connector whose stored browser session has expired.",
		metadataSchema: {
			type: "object",
			properties: {
				connector: { type: "string", title: "Connector", "x-table-column": 1 },
				status: { type: "string", title: "Status", "x-table-column": 2 },
				fix: { type: "string", title: "How to fix it", "x-table-column": 3 },
			},
		},
	},

	[INVITATION_RECEIVED_KIND]: {
		description: "An invitation to join an organization.",
		metadataSchema: {
			type: "object",
			properties: {
				organization: { type: "string", title: "Organization", "x-table-column": 1 },
				invitedBy: { type: "string", title: "Invited by", "x-table-column": 2 },
			},
		},
	},
};

export function resolvePlatformEventKind(
	semanticType: string,
): EventKindDefinition | null {
	return PLATFORM_EVENT_KINDS[semanticType] ?? null;
}
