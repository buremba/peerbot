/**
 * Admin tool surface (manage_*, watcher reads, knowledge reads, notify).
 *
 * Exposed uniformly on every surface — MCP `tools/list`, the REST proxy
 * (`POST /api/:orgSlug/:toolName`), the ClientSDK namespaces, and the CLI.
 * There is no visibility flag: reach is decided purely by per-action access
 * tier x member role x `mcp:*` scope (see `auth/tool-access.ts`).
 */

import type { TSchema } from "@sinclair/typebox";
import type { Env } from "../../index";
import { GetContentSchema, getContent } from "../get_content";
import { GetWatcherSchema, getWatcher } from "../get_watchers";
import type { ToolAnnotations, ToolContext, ToolDefinition } from "../registry";
import { ManageAgentsSchema, manageAgents } from "./manage_agents";
import {
	ManageAuthProfilesSchema,
	manageAuthProfiles,
} from "./manage_auth_profiles";
import { ManageCatalogSchema, manageCatalog } from "./manage_catalog";
import {
	ManageClassifiersSchema,
	manageClassifiers,
} from "./manage_classifiers";
import {
	ManageConnectionsSchema,
	manageConnections,
} from "./manage_connections";
import { ManageEntitySchema, manageEntity } from "./manage_entity";
import {
	ManageEntitySchemaSchema,
	manageEntitySchema,
} from "./manage_entity_schema";
import { ManageFeedsSchema, manageFeeds } from "./manage_feeds";
import { ManageOperationsSchema, manageOperations } from "./manage_operations";
import { ManageSchedulesSchema, manageSchedules } from "./manage_schedules";
import {
	ManageViewTemplatesSchema,
	manageViewTemplates,
} from "./manage_view_templates";
import {
	ListWatchersSchema,
	listWatchers,
	ManageWatchersSchema,
	manageWatchers,
} from "./manage_watchers";
import { NotifySchema, notify } from "./notify";

interface AdminToolEntry {
	name: string;
	description: string;
	schema: TSchema;
	handler: (args: any, env: Env, ctx: ToolContext) => Promise<unknown>;
	/** Defaults to `{ destructiveHint: false }`. */
	annotations?: ToolAnnotations;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const WRITE: ToolAnnotations = { destructiveHint: false };

const ENTRIES: AdminToolEntry[] = [
	{
		name: "manage_entity",
		description: "Entity management. SDK alternative: client.entities.",
		schema: ManageEntitySchema,
		handler: manageEntity,
	},
	{
		name: "manage_entity_schema",
		description:
			"Entity-type schema management. SDK alternative: client.entitySchema.",
		schema: ManageEntitySchemaSchema,
		handler: manageEntitySchema,
	},
	{
		name: "manage_connections",
		description: "Connection management. SDK alternative: client.connections.",
		schema: ManageConnectionsSchema,
		handler: manageConnections,
	},
	{
		name: "manage_catalog",
		description: "Global catalog manifests and org/agent installed inventory.",
		schema: ManageCatalogSchema,
		handler: manageCatalog,
		annotations: READ_ONLY,
	},
	{
		name: "manage_agents",
		description: "Agent management (incl. the org system agent pointer).",
		schema: ManageAgentsSchema,
		handler: manageAgents,
	},
	{
		name: "manage_feeds",
		description: "Feed management. SDK alternative: client.feeds.",
		schema: ManageFeedsSchema,
		handler: manageFeeds,
	},
	{
		name: "manage_auth_profiles",
		description:
			"Auth-profile management. SDK alternative: client.authProfiles.",
		schema: ManageAuthProfilesSchema,
		handler: manageAuthProfiles,
	},
	{
		name: "manage_operations",
		description:
			"Operation execution / approval. SDK alternative: client.operations.",
		schema: ManageOperationsSchema,
		handler: manageOperations,
		annotations: { destructiveHint: false, openWorldHint: true },
	},
	{
		name: "notify",
		description:
			"Send a notification to org users (admins / all / specific user ids).",
		schema: NotifySchema,
		handler: notify,
		annotations: { destructiveHint: false },
	},
	{
		name: "manage_schedules",
		description:
			"Create / list / pause / cancel recurring or one-shot scheduled jobs. Supports send_notification and wake_agent action types. Per-row attribution lets you trace what scheduled it and from where.",
		schema: ManageSchedulesSchema,
		handler: manageSchedules,
		annotations: { destructiveHint: false },
	},
	{
		name: "manage_watchers",
		description: "Watcher management. SDK alternative: client.watchers.",
		schema: ManageWatchersSchema,
		handler: manageWatchers,
	},
	{
		name: "list_watchers",
		description: "List watchers. SDK alternative: client.watchers.list.",
		schema: ListWatchersSchema,
		handler: listWatchers,
		annotations: READ_ONLY,
	},
	{
		name: "get_watcher",
		description:
			"Watcher detail + windows. SDK alternative: client.watchers.get.",
		schema: GetWatcherSchema,
		handler: getWatcher,
		annotations: READ_ONLY,
	},
	{
		name: "read_knowledge",
		description:
			"Read content/memory. SDK alternatives: search_memory, client.knowledge.search.",
		schema: GetContentSchema,
		handler: getContent,
		annotations: READ_ONLY,
	},
	{
		name: "manage_classifiers",
		description: "Classifier management. SDK alternative: client.classifiers.",
		schema: ManageClassifiersSchema,
		handler: manageClassifiers,
	},
	{
		name: "manage_view_templates",
		description:
			"View-template management. SDK alternative: client.viewTemplates.",
		schema: ManageViewTemplatesSchema,
		handler: manageViewTemplates,
	},
];

export const ADMIN_TOOLS: ToolDefinition[] = ENTRIES.map((entry) => ({
	name: entry.name,
	description: entry.description,
	inputSchema: entry.schema,
	annotations: entry.annotations ?? WRITE,
	handler: entry.handler,
}));
