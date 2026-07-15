/**
 * ClientSDK method metadata, keyed by dotted path. Drives the `search_sdk` MCP
 * tool, the read-only SDK filter (`access`), and the BANNED_PATHS guard.
 */

export type MethodAccess = "read" | "write" | "external" | "admin";

export interface MethodMetadata {
	summary: string;
	access: MethodAccess;
	/** Exact callable signature when the method shape is easy to misinfer. */
	signature?: string;
	throws?: readonly string[];
	/** Single-line copy-pasteable snippet. */
	example?: string;
	/** Multi-line example surfaced by `search_sdk` for hot-path methods. */
	usageExample?: string;
	/** Cost hint: 'cheap' | 'normal' | 'expensive'. Normal if omitted. */
	cost?: "cheap" | "normal" | "expensive";
}

/** Runtime helpers passed through `ctx`, not dispatchable ClientSDK methods. */
export const RUNTIME_HELPER_METADATA: Record<string, MethodMetadata> = {
	"ctx.sleep": {
		summary:
			"Pause a sandbox script for 0–30000ms. The wait aborts at the script's overall timeout; use it between SDK reads when polling.",
		access: "read",
		example: "await ctx.sleep(1000);",
		usageExample: `// Poll a run without exposing unrestricted timer globals.
export default async (ctx, client) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const run = await client.operations.getRun(123);
    if (run.status !== 'pending') return run;
    await ctx.sleep(1000);
  }
  throw new Error('Run did not finish in time');
};`,
	},
};

export const METHOD_METADATA: Record<string, MethodMetadata> = {
	// organizations
	"organizations.list": {
		summary:
			"List organizations the authenticated user belongs to, plus public orgs they can read.",
		access: "read",
		example: "const orgs = await client.organizations.list();",
	},
	"organizations.current": {
		summary: "Return the session's current organization context.",
		access: "read",
		example: "const org = await client.organizations.current();",
	},

	// entities
	"entities.manage": {
		summary: "Raw manage_entity action wrapper. Prefer named methods.",
		access: "write",
	},
	"entities.list": {
		summary:
			"List entities in the current organization with optional filters. Returns `{ action, entities, metadata }` where `entities` is the page and `metadata` carries `total_count`, `has_more`, `limit`, `offset`.",
		access: "read",
		signature: "entities.list(input?: { entity_type?: string; parent_id?: number; search?: string; limit?: number; offset?: number }): Promise<unknown>",
		example:
			"const { entities } = await client.entities.list({ entity_type: 'company' });",
		usageExample: `// All companies in the workspace, newest first.
export default async (_ctx, client) => {
  const { entities, metadata } = await client.entities.list({
    entity_type: 'company',
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  return { count: metadata.total_count, page: entities };
};`,
	},
	"entities.get": {
		summary: "Fetch a single entity by id.",
		access: "read",
		throws: ["EntityNotFound"],
		example: "const entity = await client.entities.get({ entity_id: 42 });",
		usageExample: `export default async (_ctx, client) => {
  const entity = await client.entities.get({ entity_id: 42 });
  return { id: entity.id, name: entity.name, type: entity.entity_type };
};`,
	},
	"entities.create": {
		summary:
			"Create an entity with metadata validated against the entity type schema.",
		access: "write",
		throws: ["EntityTypeNotFound", "ValidationError"],
		example:
			"await client.entities.create({ type: 'company', name: 'Acme', metadata: {} });",
	},
	"entities.update": {
		summary: "Update an existing entity.",
		access: "write",
	},
	"entities.delete": {
		summary: "Delete an entity, optionally cascading to descendants.",
		access: "admin",
		example:
			"await client.entities.delete({ entity_id: 42, force_delete_tree: true });",
	},
	"entities.link": {
		summary: "Create a relationship between two entities.",
		access: "write",
		example:
			"await client.entities.link({ from_entity_id: 42, to_entity_id: 43, relationship_type_slug: 'customer_of' });",
	},
	"entities.unlink": {
		summary: "Soft-delete an entity relationship.",
		access: "write",
	},
	"entities.updateLink": {
		summary: "Update metadata / confidence on an existing relationship.",
		access: "write",
	},
	"entities.listLinks": {
		summary: "List relationships for an entity.",
		access: "read",
	},
	"entities.search": {
		summary:
			"Fuzzy search entities by name. POSITIONAL signature: search(query: string, options?: { limit?: number }). The query is the first positional argument — passing an object like { query: '...' } throws (the handler calls query.slice).",
		access: "read",
		example: "const hits = await client.entities.search('acme', { limit: 5 });",
		usageExample: `// Resolve a free-text mention into entity ids before linking knowledge to it.
// First arg is the query string; second is options. Do NOT pass { query }.
export default async (_ctx, client) => {
  return client.entities.search('Acme', { limit: 5 });
};`,
	},

	// entitySchema
	"entitySchema.manage": {
		summary: "Raw manage_entity_schema action wrapper. Prefer named methods.",
		access: "write",
	},
	"entitySchema.listTypes": {
		summary:
			"List entity types. Defaults to accessible (current org plus public schemas); pass list_scope: 'organization' for only the bound org.",
		access: "read",
		signature:
			"entitySchema.listTypes(input?: { list_scope?: 'accessible' | 'organization' }): Promise<unknown>",
	},
	"entitySchema.getType": {
		summary: "Get an entity type by slug.",
		access: "read",
	},
	"entitySchema.createType": {
		summary:
			"Create an entity type. The metadata shape goes in `metadata_schema` (a JSON Schema), NOT `properties` — a top-level `properties` key is silently ignored.",
		access: "write",
		example:
			"await client.entitySchema.createType({ slug: 'widget', name: 'Widget', metadata_schema: { type: 'object', properties: { color: { type: 'string' } } } });",
	},
	"entitySchema.updateType": {
		summary: "Update an entity type.",
		access: "write",
	},
	"entitySchema.deleteType": {
		summary: "Delete an entity type.",
		access: "write",
		example: "await client.entitySchema.deleteType({ slug: 'widget' });",
	},
	"entitySchema.auditType": {
		summary: "List historical changes to an entity type.",
		access: "read",
	},
	"entitySchema.listRelTypes": {
		summary:
			"List relationship types. Defaults to accessible (current org plus public schemas); pass list_scope: 'organization' for only the bound org.",
		access: "read",
		signature:
			"entitySchema.listRelTypes(input?: { list_scope?: 'accessible' | 'organization' }): Promise<unknown>",
	},
	"entitySchema.getRelType": {
		summary: "Get a relationship type by slug.",
		access: "read",
	},
	"entitySchema.createRelType": {
		summary: "Create a relationship type.",
		access: "write",
	},
	"entitySchema.updateRelType": {
		summary: "Update a relationship type.",
		access: "write",
	},
	"entitySchema.deleteRelType": {
		summary: "Delete a relationship type.",
		access: "write",
		example:
			"await client.entitySchema.deleteRelType({ slug: 'works-at' });",
	},
	"entitySchema.addRule": {
		summary:
			"Add an allowed source/target entity-type rule to a relationship type.",
		access: "admin",
	},
	"entitySchema.removeRule": {
		summary: "Remove a rule from a relationship type.",
		access: "admin",
	},
	"entitySchema.listRules": {
		summary: "List rules attached to a relationship type.",
		access: "read",
		example:
			"const rules = await client.entitySchema.listRules({ slug: 'works-at' });",
	},

	// knowledge
	"knowledge.search": {
		summary: "Semantic + structured search over stored knowledge events.",
		access: "read",
		example:
			"const hits = await client.knowledge.search({ query: 'revenue update', limit: 10 });",
		usageExample: `// Pull recent revenue updates across all watcher windows.
export default async (_ctx, client) => {
  return client.knowledge.search({ query: 'revenue update', limit: 10 });
};`,
	},
	"knowledge.save": {
		summary: "Persist a knowledge event, optionally associated with entities.",
		access: "write",
		example:
			"await client.knowledge.save({ entity_ids: [42], content: 'CEO confirmed Q4 revenue ...', semantic_type: 'fact' });",
		usageExample: `// Append a new fact. Pass \`supersedes_event_id\` to replace prior facts.
export default async (_ctx, client) => {
  return client.knowledge.save({ entity_ids: [42], content: 'CEO confirmed Q4 revenue $1.2M.', semantic_type: 'fact' });
};`,
	},
	"knowledge.read": {
		summary: "Read a knowledge event by id, or watcher-window context.",
		access: "read",
	},
	"knowledge.delete": {
		summary:
			"Soft-delete one or more knowledge events your org owns by writing a tombstone superseding event. The original is hidden from default search/query/read paths via the `current_event_records` view; the full row stays on disk and is recoverable via `include_superseded`. Only events with `events.organization_id = caller` are touched — cross-org events visible via entity/connection bridges are reported in `not_found_ids`, and events already superseded come back as `already_superseded_ids`. Returns `{ deleted_ids, tombstone_ids, not_found_ids, already_superseded_ids }`. Pair with `knowledge.save({ supersedes_event_id, content: ... })` when you want to *replace* an event rather than just hide it.",
		access: "write",
		example: "await client.knowledge.delete(2321593);",
		usageExample: `// Hide a smoke-test write that should not have landed.
export default async (_ctx, client) => {
  const result = await client.knowledge.delete({
    event_ids: [2321593, 2321594],
    reason: 'smoke test cleanup',
  });
  return result;
};`,
	},

	// agents — admin tier for discovery; agent_config write-policy further
	// gates list/get (read) and create/update/delete for agent principals.
	"agents.manage": {
		summary: "Raw manage_agents action wrapper. Prefer named methods.",
		access: "admin",
	},
	"agents.list": {
		summary:
			"List agents the principal may read (agent_config read; default all). Requires admin tier.",
		access: "admin",
		example: "const { agents } = await client.agents.list();",
	},
	"agents.get": {
		summary:
			"Fetch one agent by id when agent_config read allows that target. Requires admin tier.",
		access: "admin",
		example: "const { agent } = await client.agents.get('builder');",
	},
	"agents.create": {
		summary:
			"Create an agent (queued for approval when invoked by an agent principal). Requires admin tier + agent_config create.",
		access: "admin",
		example:
			"await client.agents.create({ agent_id: 'researcher', name: 'Researcher' });",
	},
	"agents.update": {
		summary:
			"Update agent fields (may queue for approval). Requires admin tier + agent_config update.",
		access: "admin",
	},
	"agents.delete": {
		summary:
			"Delete an agent (may queue for approval). Requires admin tier + agent_config delete.",
		access: "admin",
	},
	"agents.setSystemAgent": {
		summary: "Point organization.system_agent_id at an agent. Requires admin.",
		access: "admin",
		example: "await client.agents.setSystemAgent('builder');",
	},

	// schedules
	"schedules.manage": {
		summary: "Raw manage_schedules action wrapper. Prefer named methods.",
		access: "admin",
	},
	"schedules.list": {
		summary: "List scheduled jobs with optional filters. Requires admin.",
		access: "admin",
		example:
			"const { schedules } = await client.schedules.list({ agent_id: 'builder' });",
	},
	"schedules.create": {
		summary:
			"Create a one-shot or recurring schedule (send_notification or wake_agent). Requires admin.",
		access: "admin",
		example: `await client.schedules.create({
  description: 'Follow up in 1h',
  run_at: '2026-07-05T12:00:00Z',
  payload: { type: 'wake_agent', agent_id: 'builder', prompt: 'Check inbox' },
});`,
	},
	"schedules.update": {
		summary: "Patch a schedule (next run, cron, wake_agent prompt). Requires admin.",
		access: "admin",
	},
	"schedules.pause": {
		summary: "Pause or resume a schedule. Requires admin.",
		access: "admin",
	},
	"schedules.cancel": {
		summary: "Permanently delete a schedule. Requires admin.",
		access: "admin",
		example: "await client.schedules.cancel({ id: 'schedule-id' });",
	},

	// notifications
	"notifications.send": {
		summary:
			"Send a notification to org users. Writes an `agent_message` notification (in-app inbox) and fans it out to the org's active bot connections (Slack/Telegram) — the way a watcher reaction surfaces its digest to a chat channel. Pass an optional `card` (a `chat` CardElement) for rich cross-platform rendering, and `watcher_source` when firing from a reaction.",
		access: "write",
		example:
			"await client.notifications.send({ title: 'Weekly funnel digest', body: '3 new leads...', watcher_source: { watcher_id: ctx.window.watcher_id, window_id: ctx.window.id } });",
		usageExample: `// Push a watcher digest to the org's Slack/Telegram connections + inbox.
export default async (ctx, client) => {
  await client.notifications.send({
    title: 'Weekly funnel digest',
    body: 'Top action: send the Acme pilot offer\\nNew leads: 3',
    watcher_source: { watcher_id: ctx.window.watcher_id, window_id: ctx.window.id },
  });
};`,
	},

	// watchers
	"watchers.manage": {
		summary:
			"Raw manage_watchers action wrapper. Prefer named methods such as watchers.trigger or watchers.createVersion.",
		access: "external",
		example:
			"await client.watchers.manage({ action: 'trigger', watcher_id: '42' });",
	},
	"watchers.list": {
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
	"watchers.get": {
		summary: "Fetch a watcher by id.",
		access: "read",
		throws: ["WatcherNotFound"],
		example: "const watcher = await client.watchers.get({ watcher_id: '42' });",
	},
	"watchers.create": {
		summary:
			"Create a watcher. REQUIRES slug, prompt, and agent_id (the executing agent — a watcher without one is a zombie row). The output contract is not authored here: set keying_config.entity_type so extraction derives from that entity type's metadata_schema, or omit it for a free-form summary watcher. Each sources[].query must be a read-only SELECT/WITH projecting an `id` column (it runs against org-scoped virtual tables, NOT a URL). entity_id is optional (omit for an org-scoped watcher).",
		access: "admin",
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
	"watchers.update": {
		summary: "Update watcher config (schedule, agent, model, sources).",
		access: "admin",
	},
	"watchers.createVersion": {
		summary: "Create a new watcher template version.",
		access: "admin",
	},
	"watchers.trigger": {
		summary:
			"Trigger an immediate watcher run and dispatch it to its assigned agent.",
		access: "external",
		example: "await client.watchers.trigger({ watcher_id: '42' });",
		usageExample: `export default async (_ctx, client) => {
  return client.watchers.trigger({ watcher_id: '42' });
};`,
	},
	"watchers.delete": {
		summary: "Delete one or more watchers.",
		access: "admin",
		example: "await client.watchers.delete({ watcher_ids: ['42'] });",
	},
	"watchers.setReactionScript": {
		summary:
			"Attach a raw TS reaction script (fires on window completion). Empty string removes it.",
		access: "admin",
		throws: ["CompileError"],
	},
	"watchers.completeWindow": {
		summary:
			"Submit LLM-extracted data for a watcher window. Requires a signed window_token.",
		access: "write",
	},
	"watchers.getVersions": {
		summary: "List template versions for a watcher.",
		access: "read",
	},
	"watchers.getVersionDetails": {
		summary: "Fetch a specific watcher template version.",
		access: "read",
	},
	"watchers.getComponentReference": {
		summary: "Return watcher UI/component reference documentation.",
		access: "read",
	},
	"watchers.submitFeedback": {
		summary: "Submit field-level corrections for a watcher window.",
		access: "admin",
	},
	"watchers.getFeedback": {
		summary:
			"Read field-level feedback for a watcher, optionally scoped to a window.",
		access: "read",
	},
	"watchers.createFromVersion": {
		summary:
			"Create watchers for multiple entities from an existing watcher version.",
		access: "admin",
	},

	// connections
	"connections.manage": {
		summary: "Raw manage_connections action wrapper. Prefer named methods.",
		access: "external",
	},
	"connections.list": {
		summary: "List configured connections in the current organization.",
		access: "read",
		signature: "connections.list(input?: { connector_key?: string; status?: string; setup_attempt_id?: string; limit?: number; offset?: number }): Promise<unknown>",
	},
	"catalog.listCatalog": {
		summary: "List global catalog entries (connectors, skills, watchers).",
		access: "read",
		signature: "catalog.listCatalog(input?: { kinds?: Array<'connectors' | 'skills'> }): Promise<unknown> // not paginated",
	},
	"catalog.listInstalled": {
		summary: "List installed org or agent resources.",
		access: "read",
	},
	"connections.get": {
		summary: "Get a connection by id.",
		access: "read",
		signature: "connections.get(connection_id: number): Promise<unknown>",
		example: "await client.connections.get(42);",
	},
	"connections.create": {
		summary:
			"Create from an existing auth profile. Setup gaps return a structured setup_required continuation with next_action and an optional resume_call/completion_check.",
		access: "write",
	},
	"connections.connect": {
		summary:
			"Recommended connector setup entry point. Handles every auth family; setup gaps return a structured setup_required continuation with resolved URLs and directly callable next steps.",
		access: "admin",
	},
	"connections.update": {
		summary: "Update connection config or auth profile.",
		access: "write",
	},
	"connections.delete": {
		summary: "Delete a connection.",
		access: "admin",
		signature: "connections.delete(connection_id: number): Promise<unknown>",
		example: "await client.connections.delete(42);",
	},
	"connections.reauthenticate": {
		summary:
			"Start a fresh auth flow for an existing OAuth-account or interactive connection. Returns connect_url for OAuth or auth_run_id for interactive pairing.",
		access: "write",
		signature:
			"connections.reauthenticate(connection_id: number): Promise<unknown>",
		example: "await client.connections.reauthenticate(42);",
	},
	"connections.test": {
		summary: "Test connection credentials (sends an external probe).",
		access: "external",
		signature: "connections.test(connection_id: number): Promise<unknown>",
		example: "await client.connections.test(42);",
	},
	"connections.installConnector": {
		summary:
			"Enable a reviewed catalog connector with connector_id, or install a connector definition from an explicit source.",
		access: "admin",
	},
	"connections.uninstallConnector": {
		summary: "Uninstall a connector definition.",
		access: "admin",
	},
	"connections.toggleConnectorLogin": {
		summary: "Enable/disable the login-with-connector flow.",
		access: "admin",
	},
	"connections.updateConnectorAuth": {
		summary: "Update org-wide auth config for a connector.",
		access: "admin",
	},
	"connections.updateConnectorDefaultConfig": {
		summary: "Update a connector definition's default connection config.",
		access: "admin",
	},
	"connections.updateConnectorDefaultRepairAgent": {
		summary: "Set or clear the connector's default repair agent.",
		access: "admin",
	},

	// operations
	"operations.manage": {
		summary: "Raw manage_operations action wrapper. Prefer named methods.",
		access: "external",
	},
	"operations.listAvailable": {
		summary:
			"Search declared connector capabilities, including disconnected connectors. Returns readiness plus every visible execution target; backend configuration is never exposed.",
		access: "read",
	},
	"operations.execute": {
		summary:
			"Execute a connector action. OBJECT signature: execute({ connection_id: number, operation_key: string, input?: object, watcher_source?: { watcher_id: number, window_id: number } }). connector_key is not accepted. Sends an external request.",
		access: "external",
		cost: "expensive",
		example:
			"await client.operations.execute({ connection_id: 42, operation_key: 'create_issue', input: { title: 'Follow up' } });",
	},
	"operations.listRuns": {
		summary: "List past operation runs.",
		access: "read",
	},
	"operations.getRun": {
		summary: "Get a single run by id.",
		access: "read",
		signature: "operations.getRun(run_id: number): Promise<unknown>",
		example: "const run = await client.operations.getRun(123);",
	},
	"operations.approve": {
		summary: "Approve a pending run that required human approval.",
		access: "write",
	},
	"operations.reject": {
		summary: "Reject a pending run.",
		access: "write",
	},

	// feeds
	"feeds.manage": {
		summary: "Raw manage_feeds action wrapper. Prefer named methods.",
		access: "external",
	},
	"feeds.list": {
		summary: "List data-sync feeds.",
		access: "read",
		signature: "feeds.list(input?: { connection_id?: number; status?: string; limit?: number; offset?: number }): Promise<unknown>",
	},
	"feeds.get": {
		summary:
			"Get a feed by id. Collected feeds return feed metadata and recent runs, not stored records; search collected records with knowledge.search/search_memory or client.query. Virtual feeds return live rows.",
		access: "read",
		signature: "feeds.get(input: { feed_id: number; limit?: number }): Promise<unknown>",
		example: "const feed = await client.feeds.get({ feed_id: 42 });",
	},
	"feeds.readMany": {
		summary:
			"Read several feeds in parallel with per-feed successes/failures. Collected feeds return metadata and recent runs; virtual feeds return live rows. Search collected records with knowledge.search/search_memory or client.query.",
		access: "read",
		signature: "feeds.readMany(input: { feed_ids: number[]; limit?: number }): Promise<unknown>",
		example: "const feeds = await client.feeds.readMany({ feed_ids: [42, 43], limit: 25 });",
	},
	"feeds.create": {
		summary: "Create a data-sync feed for a connection.",
		access: "write",
	},
	"feeds.update": { summary: "Update a feed.", access: "write" },
	"feeds.delete": {
		summary: "Delete a feed.",
		access: "write",
		example: "await client.feeds.delete({ feed_id: 42 });",
	},
	"feeds.trigger": {
		summary: "Trigger an immediate sync for a feed (external side-effect).",
		access: "external",
		example: "await client.feeds.trigger({ feed_id: 42 });",
	},

	// authProfiles
	"authProfiles.manage": {
		summary: "Raw manage_auth_profiles action wrapper. Prefer named methods.",
		access: "external",
	},
	"authProfiles.list": {
		summary: "List reusable auth profiles.",
		access: "read",
		signature: "authProfiles.list(input?: { connector_key?: string; provider?: string; profile_kind?: AuthProfileKind }): Promise<unknown> // not paginated",
	},
	"authProfiles.get": {
		summary: "Get an auth profile by slug.",
		access: "admin",
		signature:
			"authProfiles.get(auth_profile_slug: string): Promise<unknown>",
		example:
			"await client.authProfiles.get('google-calendar-account');",
	},
	"authProfiles.test": {
		summary: "Test auth-profile credentials.",
		access: "external",
		signature:
			"authProfiles.test(auth_profile_slug: string): Promise<unknown>",
		example:
			"await client.authProfiles.test('google-calendar-account');",
	},
	"authProfiles.create": {
		summary: "Create an auth profile.",
		access: "write",
	},
	"authProfiles.update": {
		summary:
			"Update an auth profile. Set reconnect=true on an OAuth-account profile to issue a fresh connect_url.",
		access: "write",
		signature:
			"authProfiles.update(input: { auth_profile_slug: string; display_name?: string; slug?: string; credentials?: Record<string, string>; auth_data?: Record<string, unknown>; requested_scopes?: string[]; status?: string; reconnect?: boolean }): Promise<unknown>",
		example:
			"await client.authProfiles.update({ auth_profile_slug: 'google-calendar-account', reconnect: true });",
	},
	"authProfiles.delete": {
		summary: "Delete an auth profile.",
		access: "write",
		signature:
			"authProfiles.delete(auth_profile_slug: string, options?: { force?: boolean }): Promise<unknown>",
		example:
			"await client.authProfiles.delete('google-calendar-account');",
	},

	// classifiers
	"classifiers.manage": {
		summary: "Raw manage_classifiers action wrapper. Prefer named methods.",
		access: "write",
	},
	"classifiers.list": {
		summary: "List classifier templates.",
		access: "read",
		signature: "classifiers.list(input?: { entity_id?: number; status?: string }): Promise<unknown> // not paginated",
	},
	"classifiers.create": {
		summary: "Create a classifier template.",
		access: "admin",
	},
	"classifiers.generateEmbeddings": {
		summary: "Generate embeddings for attribute values (cost-heavy).",
		access: "admin",
		cost: "expensive",
	},
	"classifiers.delete": {
		summary: "Delete a classifier.",
		access: "admin",
		example: "await client.classifiers.delete({ classifier_id: 42 });",
	},
	"classifiers.classify": {
		summary:
			"Apply a manual classification to one or many content records (single or batch).",
		access: "admin",
	},

	// viewTemplates
	"viewTemplates.manage": {
		summary: "Raw manage_view_templates action wrapper. Prefer named methods.",
		access: "write",
	},
	"viewTemplates.get": {
		summary:
			"Get the active view template for a resource. Params: { resource_type: 'entity' | 'entity_type', resource_id, tab_name? } — resource_id is the entity id (number) for resource_type 'entity', or the entity-type slug (string) for 'entity_type'. Both resource_type and resource_id are required.",
		access: "read",
		example:
			"await client.viewTemplates.get({ resource_type: 'entity', resource_id: 42 });",
	},
	"viewTemplates.set": {
		summary:
			"Create or update a view template version. Params: { resource_type: 'entity' | 'entity_type', resource_id, json_template, tab_name?, tab_order?, change_notes? }. json_template is a DSL node tree (nodes: text | data | if | each | component; a `data` node takes an optional `format`: currency|date|url|enum|boolean|number|auto|text) and may nest a `data_sources` key of named read-only SQL queries. The node tree is validated on set — a malformed template is rejected, not stored.",
		access: "admin",
		example:
			"await client.viewTemplates.set({ resource_type: 'entity_type', resource_id: 'deal', tab_name: 'Pipeline', json_template: { type: 'div', data_sources: { rows: { query: \"SELECT name, metadata->>'arr' AS arr FROM entities WHERE entity_type = 'deal'\" } }, children: [ { type: 'each', items: 'rows', as: 'r', render: { type: 'card', children: [ { type: 'data', path: 'r.name' }, { type: 'data', path: 'r.arr', format: 'currency' } ] } } ] } });",
	},
	"viewTemplates.rollback": {
		summary: "Roll back to a previous template version.",
		access: "admin",
	},
	"viewTemplates.removeTab": {
		summary: "Remove a named tab from a template.",
		access: "admin",
	},

	// metrics — governed measures (prefer over client.query / query_sql)
	"metrics.list": {
		summary:
			"List declared metrics per entity type: measures, dimensions, and segments with descriptions. Keyword-search with `q`. Pair with `metrics.query`.",
		access: "read",
		signature: "metrics.list(input?: { entity_type?: string; q?: string }): Promise<unknown> // not paginated",
		example: "const { entity_types } = await client.metrics.list({ q: 'spend' });",
		usageExample: `// Discover governed measures before running one.
export default async (_ctx, client) => {
  const { entity_types } = await client.metrics.list({ entity_type: 'company' });
  return { types: entity_types.map((t) => t.entity_type) };
};`,
	},
	"metrics.query": {
		summary:
			"Run a declared measure for an entity type. Pass entity_type + measure; optional by, segment, entity_id. Prefer this over client.query when a measure exists.",
		access: "read",
		example:
			"await client.metrics.query({ entity_type: 'company', measure: 'spend', by: ['month'] });",
		usageExample: `export default async (_ctx, client) => {
  const { rows, row_count } = await client.metrics.query({
    entity_type: 'company',
    measure: 'spend',
    by: ['month'],
  });
  return { row_count, sample: rows[0] };
};`,
	},
	"metrics.series": {
		summary:
			"Run read-only time-bucketed SQL for sparklines. Returns { columns, rows } tabular output. Member-safe column allowlist; 5s timeout, 2000-row cap.",
		access: "read",
		example:
			'await client.metrics.series({ sql: "SELECT date_trunc(\\\'day\\\', created_at) AS bucket, COUNT(*)::int AS n FROM events GROUP BY 1 ORDER BY 1" });',
	},

	// top-level
	query: {
		summary:
			"Run a simple read-only SQL string scoped to the org (member-safe column allowlist). For pagination, connection pushdown, or virtual feeds use the `query_sql` MCP tool instead. Prefer `client.metrics.query` for declared measures.",
		access: "read",
		example:
			"const rows = await client.query(\"SELECT id, name FROM entities WHERE entity_type = 'company' LIMIT 10\");",
		usageExample: `// Simple SQL read — use query_sql for pagination/feeds.
export default async (_ctx, client) => {
  return client.query("SELECT id, name FROM entities WHERE entity_type = 'company' LIMIT 10");
};`,
	},
	org: {
		summary:
			"Return a new SDK bound to a different organization the caller is a member of (OAuth on /mcp only). Throws CrossOrgAccessDenied on scoped endpoints, on PAT auth, or when the caller is not a member.",
		access: "read",
		example:
			"const otherSdk = await client.org('acme'); const rows = await otherSdk.entities.list();",
		usageExample: `// Cross-org read of company entities (OAuth on /mcp only).
export default async (_ctx, client) => {
  const acme = await client.org('acme');
  return acme.entities.list({ entity_type: 'company' });
};`,
	},
	log: {
		summary:
			"Emit a structured log line (captured in the invocation audit row).",
		access: "read",
		cost: "cheap",
	},
};

/** Paths that must never appear as SDK methods. Enforced by the coverage test. */
export const BANNED_PATHS = [
	"execute",
	"client.execute",
	"sdk.execute",
] as const;
