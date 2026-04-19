/**
 * Admin Tools Module
 *
 * This module exports all admin-related tools and their schemas.
 *
 * Consolidated admin tools surface:
 * - manage_entity: entity CRUD + relationship actions
 * - manage_entity_schema: entity type + relationship type schema actions
 * - manage_connections: connection + connector actions
 * - manage_feeds: data sync feed actions
 * - manage_auth_profiles: reusable auth profile actions
 * - manage_watchers: watcher instance actions + versioning
 * - manage_classifiers: classifier template + manual classification actions
 */

import type { Static } from '@sinclair/typebox';
import type { Env } from '../../index';
import type { ToolContext, ToolDefinition } from '../registry';
import { ManageAuthProfilesSchema, manageAuthProfiles } from './manage_auth_profiles';
import { ManageClassifiersSchema, manageClassifiers } from './manage_classifiers';
import { ManageConnectionsSchema, manageConnections } from './manage_connections';
import { ManageEntitySchema, manageEntity } from './manage_entity';
import { ManageEntitySchemaSchema, manageEntitySchema } from './manage_entity_schema';
import { ManageFeedsSchema, manageFeeds } from './manage_feeds';
import { ManageOperationsSchema, manageOperations } from './manage_operations';
import { ManageViewTemplatesSchema, manageViewTemplates } from './manage_view_templates';
import { ManageWatchersSchema, manageWatchers } from './manage_watchers';
import { QuerySqlSchema, querySql } from './query_sql';

// ============================================
// Admin Tool Definitions
// ============================================

export const ADMIN_TOOLS: ToolDefinition[] = [
  {
    name: 'manage_entity',
    description:
      'Entity management and relationships. Actions: create (new entity), update (modify metadata), list (browse with filters), get (view details), delete (remove entity), link (create relationship between entities), unlink (soft-delete relationship), update_link (change metadata/confidence/source), list_links (browse entity relationships).',
    inputSchema: ManageEntitySchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageEntitySchema>, env: Env, ctx: ToolContext) => {
      return await manageEntity(args, env, ctx);
    },
  },
  {
    name: 'manage_entity_schema',
    description:
      'Manage entity type definitions and relationship type definitions. Set schema_type="entity_type" for entity types or schema_type="relationship_type" for relationship types. Entity type actions: list, get, create, update, delete, audit. Relationship type actions: list, get, create, update, delete, add_rule, remove_rule, list_rules.',
    inputSchema: ManageEntitySchemaSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageEntitySchemaSchema>, env: Env, ctx: ToolContext) => {
      return await manageEntitySchema(args, env, ctx);
    },
  },
  {
    name: 'manage_connections',
    description:
      'Manage integration connections and connectors.\n\n' +
      'To set up a new connection: use action="connect" with the connector_key. ' +
      'This returns a connect_url — share it with the user to open in their browser for authentication. ' +
      'Then poll with action="get" until status="active". ' +
      'NEVER fabricate URLs — always use the connect_url from the response.\n\n' +
      'Actions: list, list_connector_definitions, get, create, connect, update, delete, test, install_connector, uninstall_connector, update_connector_auth, toggle_connector_login.',
    inputSchema: ManageConnectionsSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageConnectionsSchema>, env: Env, ctx: ToolContext) => {
      return await manageConnections(args, env, ctx);
    },
  },
  {
    name: 'manage_feeds',
    description:
      'Manage data sync feeds for connections. Actions: list_feeds, get_feed, create_feed, update_feed, delete_feed, trigger_feed.',
    inputSchema: ManageFeedsSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageFeedsSchema>, env: Env, ctx: ToolContext) => {
      return await manageFeeds(args, env, ctx);
    },
  },
  {
    name: 'manage_auth_profiles',
    description:
      'Manage reusable auth profiles for connector authentication. Actions: list_auth_profiles, get_auth_profile, test_auth_profile, create_auth_profile, update_auth_profile, delete_auth_profile.',
    inputSchema: ManageAuthProfilesSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageAuthProfilesSchema>, env: Env, ctx: ToolContext) => {
      return await manageAuthProfiles(args, env, ctx);
    },
  },
  {
    name: 'manage_operations',
    description:
      'Discover and execute connector-backed operations. Operations can be local connector actions, upstream MCP tools, or OpenAPI-derived HTTP operations. Actions: list_available, execute, list_runs, get_run, approve, reject.',
    inputSchema: ManageOperationsSchema,
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (args: Static<typeof ManageOperationsSchema>, env: Env, ctx: ToolContext) => {
      return await manageOperations(args, env, ctx);
    },
  },
  {
    name: 'manage_watchers',
    description: `Manage self-contained watchers with versioned analysis configs. Actions: create (new watcher with prompt/schema/sources), update (model/schedule), create_version (new version with updated config), upgrade (switch to a version), complete_window (submit LLM output), delete, set_reaction_script, get_versions, get_version_details, get_component_reference, submit_feedback, get_feedback.

WATCHER CONFIG: prompt (Handlebars), extraction_schema (JSON Schema), sources (SQL queries — auto-incremental if referencing events table), json_template (UI rendering), keying_config, classifiers, condensation_prompt, reactions_guidance.

EXECUTION WORKFLOW: Use read_knowledge(watcher_id, since/until) to fetch prompt_rendered + extraction_schema + window_token + reactions_guidance + available_operations, run your LLM externally, then submit extracted_data via complete_window.

REACTION SCRIPTS: Use set_reaction_script to attach TypeScript that auto-executes after complete_window. Script receives ReactionContext + ReactionSDK for entities, actions, content, and notifications.

FEEDBACK: Use submit_feedback(watcher_id, window_id, corrections, notes) to correct extraction fields. Use get_feedback(watcher_id) to retrieve corrections. Corrections are automatically injected into future prompts.`,
    inputSchema: ManageWatchersSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageWatchersSchema>, env: Env, ctx: ToolContext) => {
      return await manageWatchers(args, env, ctx);
    },
  },
  {
    name: 'manage_classifiers',
    description:
      'Manage classifier templates and manual classifications. Template actions: create, create_version, list, get_versions, set_current_version, generate_embeddings, delete. Manual classification: classify (single or batch content classification with classifier_slug + value). Enable classifiers per entity via manage_entity(action="update", enabled_classifiers=[...]).',
    inputSchema: ManageClassifiersSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageClassifiersSchema>, env: Env, ctx: ToolContext) => {
      return await manageClassifiers(args, env, ctx);
    },
  },
  {
    name: 'manage_view_templates',
    description:
      'Manage view templates for entity types and individual entities. One tool for all template operations. Actions: set (create/update template), get (view current + history), rollback (revert to previous version), remove_tab (delete a named tab). Specify resource_type (entity_type/entity) and resource_id (entity type slug or entity id). Templates can include a data_sources key with named SQL queries that execute server-side. Queries run against org-scoped virtual tables (entities, events, connections, watchers, event_classifications) or entity type slugs as table names. Results are returned as template_data in resolve_path.',
    inputSchema: ManageViewTemplatesSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageViewTemplatesSchema>, env: Env, ctx: ToolContext) => {
      return await manageViewTemplates(args, env, ctx);
    },
  },
  {
    name: 'query_sql',
    description:
      'Execute paginated, sortable, searchable read-only SQL queries. Table references are auto-scoped to your organization. Do NOT include ORDER BY/LIMIT/OFFSET or positional parameters in your SQL.',
    inputSchema: QuerySqlSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: Static<typeof QuerySqlSchema>, env: Env, ctx: ToolContext) => {
      return await querySql(args, env, ctx);
    },
  },
];
