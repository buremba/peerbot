/**
 * Watchers capability contract — the single source of truth for the
 * `manage_watchers` / `list_watchers` / `get_watcher` action tiers, public
 * readability, and the `client.watchers` SDK projection.
 *
 * ⚠️ Pure module: zero value imports (see kernel.ts header for why).
 */

import { defineCapability } from "./kernel";

type WatcherId = string | number;

function asWatcherIdString(value: WatcherId): string {
	return typeof value === "number" ? String(value) : value;
}

function normalizeWatcherId(
	input: Record<string, unknown> & { watcher_id?: WatcherId },
): Record<string, unknown> {
	return {
		...input,
		...(input.watcher_id !== undefined
			? { watcher_id: asWatcherIdString(input.watcher_id) }
			: {}),
	};
}

export const watchersCapability = defineCapability({
	key: "watchers",
	sdkNamespace: "watchers",
	tools: [
		{
			name: "manage_watchers",
			description: "Watcher management. SDK alternative: client.watchers.",
			actions: {
				create: { tier: "admin" },
				update: { tier: "admin" },
				create_version: { tier: "admin" },
				// `complete_window` is how watcher AGENTS report results — server-side
				// agent workers and device CLI runs (the Owletto Mac dispatcher wires
				// the gateway MCP into the spawned CLI; device tokens carry mcp:write,
				// not admin). The handler still enforces org/entity write access via
				// requireWatcherAccess; watcher ADMINISTRATION stays admin-tier.
				complete_window: { tier: "write" },
				trigger: { tier: "admin" },
				delete: { tier: "admin" },
				set_reaction_script: { tier: "admin" },
				get_versions: { tier: "read", publicRead: true },
				get_version_details: { tier: "read", publicRead: true },
				get_component_reference: { tier: "read", publicRead: true },
				submit_feedback: { tier: "admin" },
				get_feedback: { tier: "read", publicRead: true },
				list_promoted: { tier: "read" },
				create_from_version: { tier: "admin" },
			},
		},
		{
			name: "list_watchers",
			description: "List watchers. SDK alternative: client.watchers.list.",
			annotations: { readOnlyHint: true, idempotentHint: true },
			actions: null,
			publicRead: "all",
		},
		{
			name: "get_watcher",
			description:
				"Watcher detail + windows. SDK alternative: client.watchers.get.",
			annotations: { readOnlyHint: true, idempotentHint: true },
			actions: null,
			publicRead: "all",
		},
	],
	sdkMethods: [
		{
			method: "manage",
			tool: "manage_watchers",
			// No `action`: the raw escape hatch passes the caller's action through.
			mapInput: (input?: Record<string, unknown>) => input ?? {},
			docs: {
				summary:
					"Raw manage_watchers action wrapper. Prefer named methods such as watchers.trigger or watchers.createVersion.",
				access: "external",
				example:
					"await client.watchers.manage({ action: 'trigger', watcher_id: '42' });",
			},
		},
		{
			method: "list",
			tool: "list_watchers",
			mapInput: (filter?: Record<string, unknown>) => filter ?? {},
			docs: {
				summary:
					"List watchers, optionally filtered by entity. Returns `{ watchers: [...] }`.",
				access: "read",
				example:
					"const { watchers } = await client.watchers.list({ entity_id: 42 });",
				usageExample: `export default async (_ctx, client) => {
  const { watchers } = await client.watchers.list({ entity_id: 42 });
  return watchers;
};`,
			},
		},
		{
			method: "get",
			tool: "get_watcher",
			mapInput: (watcher_id: WatcherId) => ({
				watcher_id: asWatcherIdString(watcher_id),
			}),
			docs: {
				summary: "Fetch a watcher by id.",
				access: "read",
				throws: ["WatcherNotFound"],
			},
		},
		{
			method: "create",
			tool: "manage_watchers",
			action: "create",
			docs: {
				summary:
					"Create a watcher. REQUIRES slug, prompt, and agent_id (the executing agent — a watcher without one is a zombie row). The output contract is not authored here: set keying_config.entity_type so extraction derives from that entity type's metadata_schema, or omit it for a free-form summary watcher. Each sources[].query must be a read-only SELECT/WITH projecting an `id` column (it runs against org-scoped virtual tables, NOT a URL). entity_id is optional (omit for an org-scoped watcher).",
				access: "write",
				throws: ["EntityNotFound"],
				example:
					"await client.watchers.create({ slug: 'pricing', agent_id: 'agt_123', prompt: 'Extract pricing records from {{content}}.', keying_config: { entity_type: 'price', entity_path: 'prices', key_fields: ['sku'], key_output_field: 'price_key' }, sources: [{ name: 'content', query: 'SELECT id, content FROM events ORDER BY occurred_at DESC' }] });",
				usageExample: `// Stand up a watcher that extracts pricing entities from recent events.
// The output contract is derived from the \`price\` entity type metadata_schema;
// sources[].query is a read-only SELECT projecting \`id\` (a URL here would be rejected).
export default async (_ctx, client) => {
  return client.watchers.create({
    slug: 'pricing-watcher',
    agent_id: 'agt_123', // the agent that executes this watcher (required)
    prompt: 'Extract current pricing records from {{content}}.',
    keying_config: {
      entity_type: 'price',
      entity_path: 'prices',
      key_fields: ['sku'],
      key_output_field: 'price_key',
    },
    sources: [
      { name: 'content', query: 'SELECT id, content FROM events ORDER BY occurred_at DESC' },
    ],
  });
};`,
			},
		},
		{
			method: "update",
			tool: "manage_watchers",
			action: "update",
			mapInput: normalizeWatcherId,
			docs: {
				summary: "Update watcher config (schedule, agent, model, sources).",
				access: "write",
			},
		},
		{
			method: "createVersion",
			tool: "manage_watchers",
			action: "create_version",
			mapInput: normalizeWatcherId,
			docs: {
				summary: "Create a new watcher template version.",
				access: "write",
			},
		},
		{
			// Docs-only since the pre-contract SDK: METHOD_METADATA documented
			// `watchers.upgrade` but the namespace never implemented it. Kept
			// docs-only for search_sdk continuity until the method ships.
			method: "upgrade",
			tool: "manage_watchers",
			docsOnly: true,
			docs: {
				summary: "Move a watcher to another template version.",
				access: "write",
			},
		},
		{
			method: "trigger",
			tool: "manage_watchers",
			action: "trigger",
			mapInput: (watcher_id: WatcherId) => ({
				watcher_id: asWatcherIdString(watcher_id),
			}),
			docs: {
				summary:
					"Trigger an immediate watcher run and dispatch it to its assigned agent.",
				access: "external",
				example: "await client.watchers.trigger(42);",
				usageExample: `export default async (_ctx, client) => {
  return client.watchers.trigger(42);
};`,
			},
		},
		{
			method: "delete",
			tool: "manage_watchers",
			action: "delete",
			mapInput: (watcher_id: WatcherId | WatcherId[]) => ({
				watcher_ids: (Array.isArray(watcher_id)
					? watcher_id
					: [watcher_id]
				).map(asWatcherIdString),
			}),
			docs: {
				summary: "Delete one or more watchers.",
				access: "write",
			},
		},
		{
			method: "setReactionScript",
			tool: "manage_watchers",
			action: "set_reaction_script",
			mapInput: normalizeWatcherId,
			docs: {
				summary:
					"Attach a raw TS reaction script (fires on window completion). Empty string removes it.",
				access: "write",
				throws: ["CompileError"],
			},
		},
		{
			method: "completeWindow",
			tool: "manage_watchers",
			action: "complete_window",
			mapInput: normalizeWatcherId,
			docs: {
				summary:
					"Submit LLM-extracted data for a watcher window. Requires a signed window_token.",
				access: "write",
			},
		},
		{
			method: "getVersions",
			tool: "manage_watchers",
			action: "get_versions",
			mapInput: (watcher_id: WatcherId) => ({
				watcher_id: asWatcherIdString(watcher_id),
			}),
			docs: {
				summary: "List template versions for a watcher.",
				access: "read",
			},
		},
		{
			method: "getVersionDetails",
			tool: "manage_watchers",
			action: "get_version_details",
			mapInput: (
				input: WatcherId | { watcher_id: WatcherId; version?: number },
			) =>
				typeof input === "string" || typeof input === "number"
					? { watcher_id: asWatcherIdString(input) }
					: normalizeWatcherId(input),
			docs: {
				summary: "Fetch a specific watcher template version.",
				access: "read",
			},
		},
		{
			method: "getComponentReference",
			tool: "manage_watchers",
			action: "get_component_reference",
			mapInput: () => ({}),
			docs: {
				summary: "Return watcher UI/component reference documentation.",
				access: "read",
			},
		},
		{
			method: "submitFeedback",
			tool: "manage_watchers",
			action: "submit_feedback",
			mapInput: normalizeWatcherId,
			docs: {
				summary: "Submit field-level corrections for a watcher window.",
				access: "write",
			},
		},
		{
			method: "getFeedback",
			tool: "manage_watchers",
			action: "get_feedback",
			mapInput: normalizeWatcherId,
			docs: {
				summary:
					"Read field-level feedback for a watcher, optionally scoped to a window.",
				access: "read",
			},
		},
		{
			method: "createFromVersion",
			tool: "manage_watchers",
			action: "create_from_version",
			docs: {
				summary:
					"Create watchers for multiple entities from an existing watcher version.",
				access: "write",
			},
		},
	],
});
