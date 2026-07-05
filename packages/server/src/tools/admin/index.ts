/**
 * Admin tool surface (manage_*, watcher reads, knowledge reads, notify).
 *
 * REST + MCP `tools/call` dispatch surface (`POST /api/:orgSlug/:toolName`).
 * Omitted from MCP `tools/list` — agents reach these via `query_sdk` / `run_sdk`
 * and the ClientSDK namespaces. Per-action access tier x member role x `mcp:*`
 * scope still governs execution (`auth/tool-access.ts`).
 */

import type { TSchema } from "@sinclair/typebox";
import type { Env } from "../../index";
import { GetContentSchema, GetContentResultSchema, getContent } from "../get_content";
import { GetWatcherSchema, GetWatcherResultSchema, getWatcher } from "../get_watchers";
import type { ToolAnnotations, ToolContext, ToolDefinition } from "../registry";
import { ManageAgentsSchema, manageAgents } from "./manage_agents";
import {
	ManageAuthProfilesResultSchema,
	ManageAuthProfilesSchema,
	manageAuthProfiles,
} from "./manage_auth_profiles";
import { ManageCatalogResultSchema, ManageCatalogSchema, manageCatalog } from "./manage_catalog";
import {
	ManageClassifiersResultSchema,
	ManageClassifiersSchema,
	manageClassifiers,
} from "./manage_classifiers";
import {
	ManageConnectionsResultSchema,
	ManageConnectionsSchema,
	manageConnections,
} from "./manage_connections";
import { ManageEntitySchema, ManageEntityResultSchema, manageEntity } from "./manage_entity";
import {
	ManageEntitySchemaResultSchema,
	ManageEntitySchemaSchema,
	manageEntitySchema,
} from "./manage_entity_schema";
import { ManageFeedsResultSchema, ManageFeedsSchema, manageFeeds } from "./manage_feeds";
import {
	ManageOperationsResultSchema,
	ManageOperationsSchema,
	manageOperations,
} from "./manage_operations";
import { ManageSchedulesSchema, manageSchedules } from "./manage_schedules";
import {
	ManageViewTemplatesResultSchema,
	ManageViewTemplatesSchema,
	manageViewTemplates,
} from "./manage_view_templates";
import {
	ListWatchersSchema,
	listWatchers,
	ListWatchersResultSchema,
	ManageWatchersSchema,
	manageWatchers,
	ManageWatchersResultSchema,
} from "./manage_watchers";
import { NotifySchema, notify } from "./notify";

interface AdminToolEntry {
	name: string;
	description: string;
	schema: TSchema;
	handler: (args: any, env: Env, ctx: ToolContext) => Promise<unknown>;
	/** Defaults to `{ destructiveHint: false, idempotentHint: false }`. */
	annotations?: ToolAnnotations;
	/**
	 * TypeBox schema describing the tool's structured result; surfaced as
	 * `outputSchema` on the MCP tool listing and paired with `structuredContent`
	 * on `tools/call`. Hand-derive the TS result type via `Static<>` from the
	 * same schema so there's one source of truth.
	 */
	resultSchema?: TSchema;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const WRITE: ToolAnnotations = { destructiveHint: false, idempotentHint: false };
// Tools whose action union includes an irreversible action (delete / remove /
// clear / cancel). MCP hints are per-tool, not per-action, so the conservative
// correct answer for any tool that can destroy data is destructiveHint: true.
const DESTRUCTIVE: ToolAnnotations = { destructiveHint: true, idempotentHint: false };

const WRITE_WITH_TITLE = (title: string): ToolAnnotations => ({ ...WRITE, title });
const DESTRUCTIVE_WITH_TITLE = (title: string): ToolAnnotations => ({ ...DESTRUCTIVE, title });
const READ_ONLY_WITH_TITLE = (title: string): ToolAnnotations => ({ ...READ_ONLY, title });

const ENTRIES: AdminToolEntry[] = [
	{
		name: "manage_entity",
		description: "Entity management. SDK alternative: client.entities.",
		schema: ManageEntitySchema,
		resultSchema: ManageEntityResultSchema,
		handler: manageEntity,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage entities"),
	},
	{
		name: "manage_entity_schema",
		description:
			"Entity-type schema management. SDK alternative: client.entitySchema.",
		schema: ManageEntitySchemaSchema,
		resultSchema: ManageEntitySchemaResultSchema,
		handler: manageEntitySchema,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage entity schemas"),
	},
	{
		name: "manage_connections",
		description:
			"Connection and connector lifecycle. Workflow: browse via `manage_catalog`, install with action `install_connector`, then `connect` (creates a connection + auth link in one call; returns a connect_url for the user — poll `get` until status='active'). Also: list/get/update/delete connections, channel binding, connector config. Note: some connectors auto-register from a paired device (Chrome extension / Mac app advertising a capability) and appear in `list` without an explicit install. SDK alternative: client.connections.",
		schema: ManageConnectionsSchema,
		resultSchema: ManageConnectionsResultSchema,
		handler: manageConnections,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage connections"),
	},
	{
		name: "manage_catalog",
		description:
			"Browse installable connectors, skills, and watcher templates. Use `list_catalog` to see available (manifest) entries — each connector entry's `detail.source_uri` feeds into `manage_connections` action `install_connector`. Use `list_installed` with `include_catalog: true` to see installed + available with `installed`/`installable` flags. Read-only. SDK alternative: client.catalog.",
		schema: ManageCatalogSchema,
		resultSchema: ManageCatalogResultSchema,
		handler: manageCatalog,
		// Read-only today (only list_catalog / list_installed actions). If a
		// write action (install / uninstall / purge) is added here, drop
		// READ_ONLY and pick WRITE or DESTRUCTIVE to match — clients and approval
		// UIs trust readOnlyHint to skip confirmation.
		annotations: READ_ONLY_WITH_TITLE("Manage catalog"),
	},
	{
		name: "manage_agents",
		description:
			"Agent management (incl. the org system agent pointer). SDK alternative: client.agents.",
		schema: ManageAgentsSchema,
		handler: manageAgents,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage agents"),
	},
	{
		name: "manage_feeds",
		description: "Feed management. SDK alternative: client.feeds.",
		schema: ManageFeedsSchema,
		resultSchema: ManageFeedsResultSchema,
		handler: manageFeeds,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage feeds"),
	},
	{
		name: "manage_auth_profiles",
		description:
			"Auth-profile management. SDK alternative: client.authProfiles.",
		schema: ManageAuthProfilesSchema,
		resultSchema: ManageAuthProfilesResultSchema,
		handler: manageAuthProfiles,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage auth profiles"),
	},
	{
		name: "manage_operations",
		description:
			"Operation execution / approval. SDK alternative: client.operations.",
		schema: ManageOperationsSchema,
		resultSchema: ManageOperationsResultSchema,
		handler: manageOperations,
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, title: "Manage operations" },
	},
	{
		name: "notify",
		description:
			"Send a notification to org users (admins / all / specific user ids).",
		schema: NotifySchema,
		handler: notify,
		annotations: WRITE_WITH_TITLE("Send notification"),
	},
	{
		name: "manage_schedules",
		description:
			"Create / list / pause / cancel recurring or one-shot scheduled jobs. Supports send_notification and wake_agent action types. Per-row attribution lets you trace what scheduled it and from where. SDK alternative: client.schedules.",
		schema: ManageSchedulesSchema,
		handler: manageSchedules,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage schedules"),
	},
	{
		name: "manage_watchers",
		description: "Watcher management. SDK alternative: client.watchers.",
		schema: ManageWatchersSchema,
		resultSchema: ManageWatchersResultSchema,
		handler: manageWatchers,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage watchers"),
	},
	{
		name: "list_watchers",
		description: "List watchers. SDK alternative: client.watchers.list.",
		schema: ListWatchersSchema,
		resultSchema: ListWatchersResultSchema,
		handler: listWatchers,
		annotations: READ_ONLY_WITH_TITLE("List watchers"),
	},
	{
		name: "get_watcher",
		description:
			"Watcher detail + windows. SDK alternative: client.watchers.get.",
		schema: GetWatcherSchema,
		resultSchema: GetWatcherResultSchema,
		handler: getWatcher,
		annotations: READ_ONLY_WITH_TITLE("Get watcher"),
	},
	{
		name: "read_knowledge",
		description:
			"Read content/memory. SDK alternatives: search_memory, client.knowledge.search.",
		schema: GetContentSchema,
		resultSchema: GetContentResultSchema,
		handler: getContent,
		annotations: READ_ONLY_WITH_TITLE("Read knowledge"),
	},
	{
		name: "manage_classifiers",
		description: "Classifier management. SDK alternative: client.classifiers.",
		schema: ManageClassifiersSchema,
		resultSchema: ManageClassifiersResultSchema,
		handler: manageClassifiers,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage classifiers"),
	},
	{
		name: "manage_view_templates",
		description:
			"View-template management. SDK alternative: client.viewTemplates.",
		schema: ManageViewTemplatesSchema,
		resultSchema: ManageViewTemplatesResultSchema,
		handler: manageViewTemplates,
		annotations: DESTRUCTIVE_WITH_TITLE("Manage view templates"),
	},
];

export const ADMIN_TOOLS: ToolDefinition[] = ENTRIES.map((entry) => ({
	name: entry.name,
	description: entry.description,
	inputSchema: entry.schema,
	annotations: entry.annotations ?? WRITE,
	...(entry.resultSchema && { outputSchema: entry.resultSchema }),
	handler: entry.handler,
}));
