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
};

export function resolvePlatformEventKind(
	semanticType: string,
): EventKindDefinition | null {
	return PLATFORM_EVENT_KINDS[semanticType] ?? null;
}
