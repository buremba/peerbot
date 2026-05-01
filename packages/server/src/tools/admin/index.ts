/**
 * Internal REST/CLI tool surface.
 *
 * External MCP clients see the small `search`/`query`/`run`/`save_knowledge`/...
 * surface from `registry.ts`. The frontend, owletto-cli, and other REST/session
 * callers reach the named handlers below by `name` via `POST /api/:orgSlug/:toolName`.
 *
 * `restToolProxy` sets `allowInternalTools=true` (since the request didn't come
 * in over `/mcp`), so `internal: true` tools are reachable by REST but hidden
 * from MCP `tools/list`.
 */

import type { TSchema } from '@sinclair/typebox';
import type { Env } from '../../index';
import { GetContentSchema, getContent } from '../get_content';
import { GetWatcherSchema, getWatcher } from '../get_watchers';
import type { ToolAnnotations, ToolContext, ToolDefinition } from '../registry';
import { ManageAuthProfilesSchema, manageAuthProfiles } from './manage_auth_profiles';
import { ManageClassifiersSchema, manageClassifiers } from './manage_classifiers';
import { ManageConnectionsSchema, manageConnections } from './manage_connections';
import { ManageEntitySchema, manageEntity } from './manage_entity';
import { ManageEntitySchemaSchema, manageEntitySchema } from './manage_entity_schema';
import { ManageFeedsSchema, manageFeeds } from './manage_feeds';
import { ManageOperationsSchema, manageOperations } from './manage_operations';
import { ManageViewTemplatesSchema, manageViewTemplates } from './manage_view_templates';
import {
  ListWatchersSchema,
  ManageWatchersSchema,
  listWatchers,
  manageWatchers,
} from './manage_watchers';

interface InternalToolEntry {
  name: string;
  description: string;
  schema: TSchema;
  handler: (args: any, env: Env, ctx: ToolContext) => Promise<unknown>;
  /** Defaults to `{ destructiveHint: false }`. */
  annotations?: ToolAnnotations;
  /**
   * `true` (default) hides from MCP `tools/list` — REST/session callers can
   * still reach it. `false` keeps it on the public MCP surface.
   */
  internal?: boolean;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const WRITE: ToolAnnotations = { destructiveHint: false };

const ENTRIES: InternalToolEntry[] = [
  {
    name: 'manage_entity',
    description: 'Entity management. SDK alternative: client.entities.',
    schema: ManageEntitySchema,
    handler: manageEntity,
  },
  {
    name: 'manage_entity_schema',
    description: 'Entity-type schema management. SDK alternative: client.entitySchema.',
    schema: ManageEntitySchemaSchema,
    handler: manageEntitySchema,
  },
  {
    name: 'manage_connections',
    description: 'Connection management. SDK alternative: client.connections.',
    schema: ManageConnectionsSchema,
    handler: manageConnections,
  },
  {
    name: 'manage_feeds',
    description: 'Feed management. SDK alternative: client.feeds.',
    schema: ManageFeedsSchema,
    handler: manageFeeds,
  },
  {
    name: 'manage_auth_profiles',
    description: 'Auth-profile management. SDK alternative: client.authProfiles.',
    schema: ManageAuthProfilesSchema,
    handler: manageAuthProfiles,
  },
  {
    name: 'manage_operations',
    description: 'Operation execution / approval. SDK alternative: client.operations.',
    schema: ManageOperationsSchema,
    handler: manageOperations,
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'manage_watchers',
    description: 'Watcher management. SDK alternative: client.watchers.',
    schema: ManageWatchersSchema,
    handler: manageWatchers,
  },
  {
    name: 'list_watchers',
    description: 'List watchers. SDK alternative: client.watchers.list.',
    schema: ListWatchersSchema,
    handler: listWatchers,
    annotations: READ_ONLY,
  },
  {
    name: 'get_watcher',
    description: 'Watcher detail + windows. SDK alternative: client.watchers.get.',
    schema: GetWatcherSchema,
    handler: getWatcher,
    annotations: READ_ONLY,
  },
  {
    name: 'read_knowledge',
    description:
      'Read content/knowledge. SDK alternatives: search_knowledge, client.knowledge.search.',
    schema: GetContentSchema,
    handler: getContent,
    annotations: READ_ONLY,
  },
  {
    name: 'manage_classifiers',
    description: 'Classifier management. SDK alternative: client.classifiers.',
    schema: ManageClassifiersSchema,
    handler: manageClassifiers,
  },
  {
    name: 'manage_view_templates',
    description: 'View-template management. SDK alternative: client.viewTemplates.',
    schema: ManageViewTemplatesSchema,
    handler: manageViewTemplates,
  },
];

export const INTERNAL_REST_TOOLS: ToolDefinition[] = ENTRIES.map((entry) => ({
  name: entry.name,
  description: entry.description,
  inputSchema: entry.schema,
  annotations: entry.annotations ?? WRITE,
  internal: entry.internal ?? true,
  handler: entry.handler,
}));
