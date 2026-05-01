/**
 * ClientSDK method metadata, keyed by dotted path. Drives the `search` MCP
 * tool, the read-only SDK filter (`access`), and the BANNED_PATHS guard.
 */

export type MethodAccess = "read" | "write" | "external";

export interface MethodMetadata {
  summary: string;
  access: MethodAccess;
  throws?: readonly string[];
  /** Single-line copy-pasteable snippet. */
  example?: string;
  /** Multi-line example surfaced by `search` for hot-path methods. */
  usageExample?: string;
  /** Cost hint: 'cheap' | 'normal' | 'expensive'. Normal if omitted. */
  cost?: "cheap" | "normal" | "expensive";
}

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
    example: "const entity = await client.entities.get(42);",
    usageExample: `export default async (_ctx, client) => {
  const entity = await client.entities.get(42);
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
    access: "write",
  },
  "entities.link": {
    summary: "Create a relationship between two entities.",
    access: "write",
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
    summary: "Fuzzy search entities by name, optionally filtered by type.",
    access: "read",
    example: "const hits = await client.entities.search('acme', { limit: 5 });",
    usageExample: `// Resolve a free-text mention into entity ids before linking knowledge to it.
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
    summary: "List entity types in the organization.",
    access: "read",
  },
  "entitySchema.getType": {
    summary: "Get an entity type by slug.",
    access: "read",
  },
  "entitySchema.createType": {
    summary: "Create an entity type.",
    access: "write",
  },
  "entitySchema.updateType": {
    summary: "Update an entity type.",
    access: "write",
  },
  "entitySchema.deleteType": {
    summary: "Delete an entity type.",
    access: "write",
  },
  "entitySchema.auditType": {
    summary: "List historical changes to an entity type.",
    access: "read",
  },
  "entitySchema.listRelTypes": {
    summary: "List relationship types.",
    access: "read",
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
  },
  "entitySchema.addRule": {
    summary:
      "Add an allowed source/target entity-type rule to a relationship type.",
    access: "write",
  },
  "entitySchema.removeRule": {
    summary: "Remove a rule from a relationship type.",
    access: "write",
  },
  "entitySchema.listRules": {
    summary: "List rules attached to a relationship type.",
    access: "read",
  },

  // knowledge
  "knowledge.search": {
    summary: "Semantic + structured search over stored knowledge events.",
    access: "read",
    example: "const hits = await client.knowledge.search({ query: 'revenue update', limit: 10 });",
    usageExample: `// Pull recent revenue updates across all watcher windows.
export default async (_ctx, client) => {
  return client.knowledge.search({ query: 'revenue update', limit: 10 });
};`,
  },
  "knowledge.save": {
    summary: "Persist a knowledge event, optionally associated with entities.",
    access: "write",
    example: "await client.knowledge.save({ entity_ids: [42], content: 'CEO confirmed Q4 revenue ...', semantic_type: 'fact' });",
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

  // watchers
  "watchers.manage": {
    summary:
      "Raw manage_watchers action wrapper. Prefer named methods such as watchers.trigger or watchers.createVersion.",
    access: "external",
    example: "await client.watchers.manage({ action: 'trigger', watcher_id: '42' });",
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
  },
  "watchers.create": {
    summary: "Create a watcher with prompt, extraction schema, and sources.",
    access: "write",
    throws: ["EntityNotFound", "InvalidExtractionSchema"],
    example: "await client.watchers.create({ entity_id: 42, prompt: '...', extraction_schema: {...} });",
    usageExample: `// Stand up a watcher that extracts pricing facts from a customer's site.
export default async (_ctx, client) => {
  return client.watchers.create({
    entity_id: 42,
    prompt: 'Extract current pricing.',
    extraction_schema: { price: { type: 'number' } },
    sources: [{ name: 'home', query: 'https://example.com/pricing' }],
  });
};`,
  },
  "watchers.update": {
    summary: "Update watcher config (schedule, agent, model, sources).",
    access: "write",
  },
  "watchers.createVersion": {
    summary: "Create a new watcher template version.",
    access: "write",
  },
  "watchers.upgrade": {
    summary: "Move a watcher to another template version.",
    access: "write",
  },
  "watchers.trigger": {
    summary: "Trigger an immediate watcher run and dispatch it to its assigned agent.",
    access: "external",
    example: "await client.watchers.trigger(42);",
    usageExample: `export default async (_ctx, client) => {
  return client.watchers.trigger(42);
};`,
  },
  "watchers.delete": {
    summary: "Delete one or more watchers.",
    access: "write",
  },
  "watchers.setReactionScript": {
    summary:
      "Attach a raw TS reaction script (fires on window completion). Empty string removes it.",
    access: "write",
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
    access: "write",
  },
  "watchers.getFeedback": {
    summary: "Read field-level feedback for a watcher, optionally scoped to a window.",
    access: "read",
  },
  "watchers.createFromVersion": {
    summary: "Create watchers for multiple entities from an existing watcher version.",
    access: "write",
  },

  // connections
  "connections.manage": {
    summary: "Raw manage_connections action wrapper. Prefer named methods.",
    access: "external",
  },
  "connections.list": {
    summary: "List configured connections in the current organization.",
    access: "read",
  },
  "connections.listConnectorDefinitions": {
    summary: "List connector definitions installed in this organization.",
    access: "read",
  },
  "connections.get": { summary: "Get a connection by id.", access: "read" },
  "connections.create": {
    summary:
      "Create a connection manually (for connectors that do not require OAuth).",
    access: "write",
  },
  "connections.connect": {
    summary:
      "Start an OAuth / auth-profile flow. Returns a connect_url to share with the user.",
    access: "write",
  },
  "connections.update": {
    summary: "Update connection config or auth profile.",
    access: "write",
  },
  "connections.delete": { summary: "Delete a connection.", access: "write" },
  "connections.reauthenticate": {
    summary: "Start a fresh auth flow for an existing connection.",
    access: "write",
  },
  "connections.test": {
    summary: "Test connection credentials (sends an external probe).",
    access: "external",
  },
  "connections.installConnector": {
    summary: "Install a connector definition into this organization.",
    access: "write",
  },
  "connections.uninstallConnector": {
    summary: "Uninstall a connector definition.",
    access: "write",
  },
  "connections.toggleConnectorLogin": {
    summary: "Enable/disable the login-with-connector flow.",
    access: "write",
  },
  "connections.updateConnectorAuth": {
    summary: "Update org-wide auth config for a connector.",
    access: "write",
  },
  "connections.updateConnectorDefaultConfig": {
    summary: "Update a connector definition's default connection config.",
    access: "write",
  },
  "connections.setConnectorEntityLinkOverrides": {
    summary: "Set connector-level entity-link overrides.",
    access: "write",
  },
  "connections.updateConnectorDefaultRepairAgent": {
    summary: "Set or clear the connector's default repair agent.",
    access: "write",
  },

  // operations
  "operations.manage": {
    summary: "Raw manage_operations action wrapper. Prefer named methods.",
    access: "external",
  },
  "operations.listAvailable": {
    summary: "List operations exposed by the active connections.",
    access: "read",
  },
  "operations.execute": {
    summary: "Execute a connector action. Sends an external request.",
    access: "external",
    cost: "expensive",
  },
  "operations.listRuns": {
    summary: "List past operation runs.",
    access: "read",
  },
  "operations.getRun": { summary: "Get a single run by id.", access: "read" },
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
  "feeds.list": { summary: "List data-sync feeds.", access: "read" },
  "feeds.get": { summary: "Get a feed by id.", access: "read" },
  "feeds.create": {
    summary: "Create a data-sync feed for a connection.",
    access: "write",
  },
  "feeds.update": { summary: "Update a feed.", access: "write" },
  "feeds.delete": { summary: "Delete a feed.", access: "write" },
  "feeds.trigger": {
    summary: "Trigger an immediate sync for a feed (external side-effect).",
    access: "external",
  },

  // authProfiles
  "authProfiles.manage": {
    summary: "Raw manage_auth_profiles action wrapper. Prefer named methods.",
    access: "external",
  },
  "authProfiles.list": {
    summary: "List reusable auth profiles.",
    access: "read",
  },
  "authProfiles.get": {
    summary: "Get an auth profile by slug.",
    access: "read",
  },
  "authProfiles.test": {
    summary: "Test auth-profile credentials.",
    access: "external",
  },
  "authProfiles.create": {
    summary: "Create an auth profile.",
    access: "write",
  },
  "authProfiles.update": {
    summary: "Update an auth profile.",
    access: "write",
  },
  "authProfiles.delete": {
    summary: "Delete an auth profile.",
    access: "write",
  },

  // classifiers
  "classifiers.manage": {
    summary: "Raw manage_classifiers action wrapper. Prefer named methods.",
    access: "write",
  },
  "classifiers.list": {
    summary: "List classifier templates.",
    access: "read",
  },
  "classifiers.create": {
    summary: "Create a classifier template.",
    access: "write",
  },
  "classifiers.createVersion": {
    summary: "Create a new version of an existing classifier.",
    access: "write",
  },
  "classifiers.getVersions": {
    summary: "List versions of a classifier.",
    access: "read",
  },
  "classifiers.setCurrentVersion": {
    summary: "Promote a version to current.",
    access: "write",
  },
  "classifiers.generateEmbeddings": {
    summary: "Generate embeddings for attribute values (cost-heavy).",
    access: "write",
    cost: "expensive",
  },
  "classifiers.delete": {
    summary: "Delete a classifier.",
    access: "write",
  },
  "classifiers.classify": {
    summary:
      "Apply a manual classification to one or many content records (single or batch).",
    access: "write",
  },

  // viewTemplates
  "viewTemplates.manage": {
    summary: "Raw manage_view_templates action wrapper. Prefer named methods.",
    access: "write",
  },
  "viewTemplates.get": {
    summary: "Get the active view template for a resource.",
    access: "read",
  },
  "viewTemplates.set": {
    summary: "Create or update a view template.",
    access: "write",
  },
  "viewTemplates.rollback": {
    summary: "Roll back to a previous template version.",
    access: "write",
  },
  "viewTemplates.removeTab": {
    summary: "Remove a named tab from a template.",
    access: "write",
  },

  // top-level
  query: {
    summary:
      "Run a read-only SQL query against the organization-scoped virtual tables. No positional parameters — use Handlebars {{query.name}} substitutions inside the SQL when you need values.",
    access: "read",
    example: "const rows = await client.query(\"SELECT id, name FROM entities WHERE entity_type = 'company'\");",
    usageExample: `// Run a one-off SQL read scoped to the bound organization.
export default async (_ctx, client) => {
  return client.query("SELECT id, name FROM entities WHERE entity_type = 'company' LIMIT 10");
};`,
  },
  org: {
    summary:
      "Return a new SDK bound to a different organization the caller is a member of (OAuth on /mcp only). Throws CrossOrgAccessDenied on scoped endpoints, on PAT auth, or when the caller is not a member.",
    access: "read",
    example: "const otherSdk = await client.org('acme'); const rows = await otherSdk.entities.list();",
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
