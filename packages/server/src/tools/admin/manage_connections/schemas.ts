/**
 * TypeBox schemas and result types for the manage_connections tool.
 */

import { type Static, Type } from "@sinclair/typebox";
import { PaginationFields } from "../schemas/common-fields";

/** A channel binding as returned by list_channel_bindings. */
export interface ChannelBindingDto {
	connectionId?: string;
	platform: string;
	channelId: string;
	teamId?: string;
	/** Per-binding model override (a `provider/model` ref or "auto"), if set. */
	model?: string;
	createdAt: number;
}

const ChannelBindingDtoSchema = Type.Object({
	platform: Type.String(),
	channelId: Type.String(),
	teamId: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	createdAt: Type.Integer(),
});

const ConnectionFacetsSchema = Type.Object({
	data: Type.Boolean(),
	chat: Type.Boolean(),
	actions: Type.Boolean(),
	audience: Type.Boolean(),
});

// ============================================
// Schema
// ============================================

export const ListConnectorGroupsAction = Type.Object({
	action: Type.Literal("list_connector_groups"),
	entity_id: Type.Optional(
		Type.Number({
			description:
				"Filter to connectors that have a connection (or feed) linked to this entity.",
		}),
	),
});

export const ListAction = Type.Object({
	action: Type.Literal("list"),
	connector_key: Type.Optional(
		Type.String({ description: "Filter by connector key (e.g. google.gmail)" }),
	),
	status: Type.Optional(
		Type.String({
			description: "Filter by status: active, paused, error, revoked",
		}),
	),
	entity_id: Type.Optional(
		Type.Number({ description: "Filter by linked entity ID" }),
	),
	created_by: Type.Optional(
		Type.String({
			description: "Filter by user ID who created the connection",
		}),
	),
	connection_ids: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			description: "Filter to specific connection IDs",
		}),
	),
	...PaginationFields,
});

export const GetAction = Type.Object({
	action: Type.Literal("get"),
	connection_id: Type.Number({ description: "Connection ID" }),
});

const EntityLinkOverridesSchema = Type.Union(
	[
		Type.Null(),
		Type.Record(
			Type.String(),
			Type.Object({
				disable: Type.Optional(Type.Boolean()),
				retargetEntityType: Type.Optional(Type.String()),
				autoCreate: Type.Optional(Type.Boolean()),
				maskIdentities: Type.Optional(Type.Array(Type.String())),
			}),
		),
	],
	{
		description:
			"Per-entityType override of the connector's declared entityLinks rules (keyed by the rule's entityType). Applies at the connector-definition level for this org.",
	},
);

export const CreateAction = Type.Object({
	action: Type.Literal("create"),
	connector_key: Type.String({
		description: "Connector key (e.g. google.gmail)",
	}),
	display_name: Type.Optional(
		Type.String({ description: "Human-readable name" }),
	),
	slug: Type.Optional(
		Type.String({
			description:
				"Stable public identifier for the connection. Auto-generated from display_name when omitted.",
		}),
	),
	auth_profile_slug: Type.Optional(
		Type.String({
			description: "Reusable auth profile slug for runtime/account auth",
		}),
	),
	app_auth_profile_slug: Type.Optional(
		Type.String({
			description: "Reusable auth profile slug for OAuth app credentials",
		}),
	),
	config: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "Connection config",
		}),
	),
	created_by: Type.Optional(
		Type.String({
			description:
				"Override the connection owner (admin/owner only). Defaults to current user.",
		}),
	),
	device_worker_id: Type.Optional(
		// Nullable: serverless connections (no device) send `null`, not just omit.
		// The UI/serverless callers pass `device_worker_id: null` explicitly, which
		// a bare `Type.String` rejected ("Expected string"); `resolveDeviceBinding`
		// normalizes null/empty to serverless.
		Type.Union([Type.String(), Type.Null()], {
			description:
				"Run this connection's syncs/actions on a specific device worker (its device_workers.id) instead of the Lobu server (runs serverless). Null/omit runs serverless. Required for connectors that declare a required_capability. The device must belong to you or be granted to this org.",
		}),
	),
	entity_ids: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Entity IDs to tag this connection with (links the connection to entities)",
		}),
	),
	entity_link_overrides: Type.Optional(EntityLinkOverridesSchema),
});

export const UpdateAction = Type.Object({
	action: Type.Literal("update"),
	connection_id: Type.Number({ description: "Connection ID" }),
	display_name: Type.Optional(Type.String()),
	slug: Type.Optional(
		Type.String({
			description:
				"New stable slug for the connection (display_name changes never touch the slug)",
		}),
	),
	status: Type.Optional(
		Type.String({ description: "active, paused, error, revoked" }),
	),
	auth_profile_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	app_auth_profile_slug: Type.Optional(
		Type.Union([Type.String(), Type.Null()]),
	),
	config: Type.Optional(Type.Record(Type.String(), Type.Any())),
	entity_ids: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Entity IDs to tag this connection with. Pass [] (or null) to clear all links; omit to leave unchanged.",
		}),
	),
	device_worker_id: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description:
				"Reassign which device worker runs this connection. Null moves it back to the Lobu server, runs serverless (only allowed if the connector has no required_capability).",
		}),
	),
	replace_config: Type.Optional(
		Type.Boolean({
			description:
				"When true and `config` is provided, replace the stored connection config with exactly that object (declarative apply); when false/omitted, merge into the existing config (default).",
		}),
	),
});

export const ApplyChatConnectionAction = Type.Object({
	action: Type.Literal("apply_chat_connection"),
	stable_id: Type.String({
		description: "Stable declarative connection id used by lobu apply.",
	}),
	connector_key: Type.String({ description: "Chat connector key." }),
	display_name: Type.Optional(Type.String()),
	agent_id: Type.Optional(
		Type.String({
			description:
				"Declarative fallback agent. Channel bindings remain authoritative when present.",
		}),
	),
	config: Type.Record(Type.String(), Type.Any()),
	settings: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export const DeleteAction = Type.Object({
	action: Type.Literal("delete"),
	connection_id: Type.Number({ description: "Connection ID" }),
});

export const ReauthenticateAction = Type.Object({
	action: Type.Literal("reauthenticate"),
	connection_id: Type.Number({
		description:
			"Connection ID whose interactive auth profile should be re-paired via a new auth run.",
	}),
});

export const TestAction = Type.Object({
	action: Type.Literal("test"),
	connection_id: Type.Number({ description: "Connection ID to test" }),
});

export const InstallConnectorAction = Type.Object({
	action: Type.Literal("install_connector"),
	source_url: Type.Optional(
		Type.String({ description: "Direct URL to connector source file" }),
	),
	source_uri: Type.Optional(
		Type.String({
			description: "Local file source URI or path for connector installation",
		}),
	),
	source_code: Type.Optional(
		Type.String({
			description: "Inline TypeScript or pre-compiled JavaScript source code",
		}),
	),
	compiled: Type.Optional(
		Type.Boolean({
			description:
				"Set to true if source_code is already compiled JavaScript (skip compilation)",
		}),
	),
	mcp_url: Type.Optional(
		Type.String({
			description:
				"URL to a remote MCP server (Streamable HTTP). Probes the server directly, no compilation needed.",
		}),
	),
	auth_values: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Reusable auth values for env_keys and OAuth client keys. Stored as auth profiles.",
		}),
	),
	entity_link_overrides: Type.Optional(EntityLinkOverridesSchema),
});

export const UninstallConnectorAction = Type.Object({
	action: Type.Literal("uninstall_connector"),
	connector_key: Type.String({ description: "Connector key to uninstall" }),
});

export const ConnectAction = Type.Object({
	action: Type.Literal("connect"),
	connector_key: Type.String({
		description: "Connector key (e.g. google.gmail)",
	}),
	display_name: Type.Optional(
		Type.String({ description: "Human-readable name for the connection" }),
	),
	slug: Type.Optional(
		Type.String({
			description:
				"Stable public identifier for the connection. Auto-generated from display_name when omitted.",
		}),
	),
	auth_profile_slug: Type.Optional(
		Type.String({
			description: "Reusable auth profile slug for runtime/account auth",
		}),
	),
	app_auth_profile_slug: Type.Optional(
		Type.String({
			description: "Reusable auth profile slug for OAuth app credentials",
		}),
	),
	config: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "Connection config",
		}),
	),
	device_worker_id: Type.Optional(
		// Nullable for serverless connections — see CreateAction note.
		Type.Union([Type.String(), Type.Null()], {
			description:
				"Run this connection's syncs/actions on a specific device worker (its device_workers.id) instead of the Lobu server (runs serverless). Null/omit runs serverless. Required for connectors that declare a required_capability. The device must belong to you or be granted to this org.",
		}),
	),
	entity_ids: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Entity IDs to tag this connection with (links the connection to entities)",
		}),
	),
	entity_link_overrides: Type.Optional(EntityLinkOverridesSchema),
});

export const ToggleConnectorLoginAction = Type.Object({
	action: Type.Literal("toggle_connector_login"),
	connector_key: Type.String({
		description: "Connector key (e.g. github, google.gmail)",
	}),
	enabled: Type.Boolean({
		description: "Enable or disable this connector as a login provider",
	}),
});

export const UpdateConnectorAuthAction = Type.Object({
	action: Type.Literal("update_connector_auth"),
	connector_key: Type.String({
		description: "Connector key (e.g. reddit, google.gmail)",
	}),
	auth_values: Type.Record(Type.String(), Type.String(), {
		description: "Auth values to upsert (env_keys and OAuth client keys)",
	}),
});

export const UpdateConnectorDefaultConfigAction = Type.Object({
	action: Type.Literal("update_connector_default_config"),
	connector_key: Type.String({ description: "Connector key" }),
	default_connection_config: Type.Record(Type.String(), Type.Any(), {
		description: "Default connection config (action_modes, etc.)",
	}),
});

export const SetConnectorEntityLinkOverridesAction = Type.Object({
	action: Type.Literal("set_connector_entity_link_overrides"),
	connector_key: Type.String({ description: "Connector key" }),
	overrides: EntityLinkOverridesSchema,
});

export const UpdateConnectorDefaultRepairAgentAction = Type.Object({
	action: Type.Literal("update_connector_default_repair_agent"),
	connector_key: Type.String({ description: "Connector key" }),
	default_repair_agent_id: Type.Union([Type.String(), Type.Null()], {
		description:
			"Default repair agent ID for feeds of this connector. Null clears the default.",
	}),
});

// ============================================
// Channel-binding actions (folded from the retired /channels HTTP routes).
// A chat channel is bound to an agent through its connection; these actions
// live under manage_connections so channel management lives on the connections
// surface, not a bespoke channel island.
// ============================================

const CHANNEL_ID_DESC =
	"Platform channel id as the binding stores it (may be platform-prefixed, e.g. 'slack:C…').";

export const ListChannelBindingsAction = Type.Object({
	action: Type.Literal("list_channel_bindings"),
	agent_id: Type.String({
		description: "Agent whose channel bindings to list.",
	}),
});

export const BindChannelAction = Type.Object({
	action: Type.Literal("bind_channel"),
	agent_id: Type.String({ description: "Agent to bind the channel to." }),
	connection_id: Type.Number({
		description: "Chat connection that receives this channel's messages.",
	}),
	channel_id: Type.String({ description: CHANNEL_ID_DESC }),
	model: Type.Optional(
		Type.String({
			maxLength: 200,
			description:
				"Optional per-binding model override (a `provider/model` ref or \"auto\"). " +
				"Wins over the agent/org default for messages on this channel.",
		}),
	),
});

export const UnbindChannelAction = Type.Object({
	action: Type.Literal("unbind_channel"),
	agent_id: Type.String({ description: "Agent to unbind the channel from." }),
	connection_id: Type.Number({
		description: "Chat connection owning the binding.",
	}),
	channel_id: Type.String({ description: CHANNEL_ID_DESC }),
});

export const SyncChannelBindingsAction = Type.Object({
	action: Type.Literal("sync_channel_bindings"),
	agent_id: Type.String({
		description: "Agent whose declarative bindings to reconcile.",
	}),
	connection_id: Type.Union([Type.Number(), Type.String()], {
			description:
			"Chat connection numeric id, or the stable declarative id used by lobu apply.",
		}),
	channels: Type.Array(Type.String(), {
			description:
			"Desired channel ids. Slack also accepts the declarative <teamId>/<channelId> form.",
		}),
});

export const ConnectChannelDmAction = Type.Object({
	action: Type.Literal("connect_channel_dm"),
	agent_id: Type.String({ description: "Agent to wire the caller's DM to." }),
	connection_id: Type.Number({
		description: "Slack connection to open and bind the caller's DM through.",
	}),
});

// ============================================
// Result Types
// ============================================

/** Shared shape of the `*_connector*` success responses. */
export type ConnectorActionOk<A extends string, Extra = unknown> = {
	action: A;
	success: true;
	connector_key: string;
} & Extra;

/** A connection row as returned by the list/get/create/update handlers. */
export type ConnectionRow = Record<string, unknown>;

/** Derived roles a connection (or connector group) plays. See
 *  `handlers/facets.ts` — these are computed, never stored. */
export interface ConnectionFacets {
	data: boolean;
	chat: boolean;
	actions: boolean;
	audience: boolean;
}

/**
 * Result of `manage_connections` — discriminated union keyed on `action`
 * (plus an error variant). TypeBox-first: `Static<>` derives the TS type from
 * the same schema exposed as the tool's `outputSchema`. Connection rows are
 * wide snapshots, so `ConnectionRow` stays `Record<string, unknown>`.
 */
const ConnectorGroupSchema = Type.Object({
	connector_key: Type.String(),
	connector_name: Type.Union([Type.String(), Type.Null()]),
	favicon_domain: Type.Union([Type.String(), Type.Null()]),
	connection_count: Type.Integer(),
	facets: ConnectionFacetsSchema,
	connections: Type.Array(
		Type.Object({
			id: Type.Integer(),
			display_name: Type.Union([Type.String(), Type.Null()]),
			feed_count: Type.Integer(),
		})
	),
});

export const ManageConnectionsResultSchema = Type.Union([
	Type.Object({ error: Type.String(), setup_url: Type.Optional(Type.String()) }),
	Type.Object({
		action: Type.Literal("list"),
		connections: Type.Array(Type.Record(Type.String(), Type.Unknown())),
		total: Type.Integer(),
		limit: Type.Integer(),
		offset: Type.Integer(),
		view_url: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal("list_connector_groups"),
		groups: Type.Array(ConnectorGroupSchema),
	}),
	Type.Object({
		action: Type.Literal("get"),
		connection: Type.Record(Type.String(), Type.Unknown()),
		view_url: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal("create"),
		connection: Type.Record(Type.String(), Type.Unknown()),
		connector: Type.Record(Type.String(), Type.Unknown()),
		view_url: Type.Optional(Type.String()),
		auth_run_id: Type.Optional(Type.Integer()),
	}),
	Type.Object({
		action: Type.Literal("connect"),
		connection_id: Type.Integer(),
		slug: Type.Optional(Type.String()),
		status: Type.Literal("active"),
		message: Type.String(),
		view_url: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal("connect"),
		connection_id: Type.Integer(),
		slug: Type.Optional(Type.String()),
		status: Type.Literal("pending_auth"),
		auth_type: Type.String(),
		instructions: Type.String(),
		connect_url: Type.Optional(Type.String()),
		connect_token: Type.Optional(Type.String()),
		auth_profile_slug: Type.Optional(Type.String()),
		view_url: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal("update"),
		connection: Type.Record(Type.String(), Type.Unknown()),
	}),
	Type.Object({
		action: Type.Literal("apply_chat_connection"),
		connection: Type.Record(Type.String(), Type.Unknown()),
		created: Type.Boolean(),
		changed: Type.Boolean(),
	}),
	Type.Object({
		action: Type.Literal("delete"),
		deleted: Type.Literal(true),
		connection_id: Type.Integer(),
		slug: Type.String(),
	}),
	Type.Object({
		action: Type.Literal("reauthenticate"),
		connection_id: Type.Integer(),
		auth_run_id: Type.Integer(),
	}),
	Type.Object({
		action: Type.Literal("test"),
		status: Type.String(),
		message: Type.String(),
		has_token: Type.Optional(Type.Boolean()),
		has_refresh: Type.Optional(Type.Boolean()),
		expires_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	}),
	Type.Object({
		action: Type.Literal("install_connector"),
		installed: Type.Literal(true),
		connector_key: Type.String(),
		name: Type.String(),
		version: Type.String(),
		code_hash: Type.String(),
		updated: Type.Boolean(),
	}),
	Type.Object({
		action: Type.Literal("uninstall_connector"),
		uninstalled: Type.Literal(true),
		connector_key: Type.String(),
	}),
	// ConnectorActionOk<"toggle_connector_login", { login_enabled: boolean }>
	Type.Object({
		action: Type.Literal("toggle_connector_login"),
		success: Type.Literal(true),
		connector_key: Type.String(),
		login_enabled: Type.Boolean(),
	}),
	// ConnectorActionOk<"update_connector_auth", { keys_updated: string[] }>
	Type.Object({
		action: Type.Literal("update_connector_auth"),
		success: Type.Literal(true),
		connector_key: Type.String(),
		keys_updated: Type.Array(Type.String()),
	}),
	// ConnectorActionOk<"update_connector_default_config">
	Type.Object({
		action: Type.Literal("update_connector_default_config"),
		success: Type.Literal(true),
		connector_key: Type.String(),
	}),
	// ConnectorActionOk<"update_connector_default_repair_agent", { default_repair_agent_id: string | null }>
	Type.Object({
		action: Type.Literal("update_connector_default_repair_agent"),
		success: Type.Literal(true),
		connector_key: Type.String(),
		default_repair_agent_id: Type.Union([Type.String(), Type.Null()]),
	}),
	// ConnectorActionOk<"set_connector_entity_link_overrides", { overrides: Record<string, unknown> | null }>
	Type.Object({
		action: Type.Literal("set_connector_entity_link_overrides"),
		success: Type.Literal(true),
		connector_key: Type.String(),
		overrides: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
	}),
	Type.Object({
		action: Type.Literal("list_channel_bindings"),
		agent_id: Type.String(),
		bindings: Type.Array(ChannelBindingDtoSchema),
	}),
	Type.Object({
		action: Type.Literal("bind_channel"),
		success: Type.Literal(true),
		agent_id: Type.String(),
		connection_id: Type.Integer(),
		platform: Type.String(),
		channel_id: Type.String(),
		team_id: Type.Optional(Type.String()),
	}),
	Type.Object({
		action: Type.Literal("unbind_channel"),
		success: Type.Literal(true),
	}),
	Type.Object({
		action: Type.Literal("sync_channel_bindings"),
		success: Type.Literal(true),
		bound: Type.Array(Type.String()),
		removed: Type.Array(Type.String()),
	}),
	Type.Object({
		action: Type.Literal("connect_channel_dm"),
		success: Type.Literal(true),
		platform: Type.Literal("slack"),
		channel_id: Type.String(),
		team_id: Type.Union([Type.String(), Type.Null()]),
	}),
]);
export type ManageConnectionsResult = Static<typeof ManageConnectionsResultSchema>;

/**
 * Union of all action variants. Defined from the variants directly (rather
 * than from the derived union schema in manage_connections.ts) so the handler
 * modules can use `Extract<ConnectionsArgs, ...>` without a circular type.
 */
export type ConnectionsArgs =
	| Static<typeof ListConnectorGroupsAction>
	| Static<typeof ListAction>
	| Static<typeof GetAction>
	| Static<typeof CreateAction>
	| Static<typeof ConnectAction>
	| Static<typeof UpdateAction>
	| Static<typeof ApplyChatConnectionAction>
	| Static<typeof DeleteAction>
	| Static<typeof ReauthenticateAction>
	| Static<typeof TestAction>
	| Static<typeof InstallConnectorAction>
	| Static<typeof UninstallConnectorAction>
	| Static<typeof ToggleConnectorLoginAction>
	| Static<typeof UpdateConnectorAuthAction>
	| Static<typeof UpdateConnectorDefaultConfigAction>
	| Static<typeof UpdateConnectorDefaultRepairAgentAction>
	| Static<typeof SetConnectorEntityLinkOverridesAction>
	| Static<typeof ListChannelBindingsAction>
	| Static<typeof BindChannelAction>
	| Static<typeof UnbindChannelAction>
	| Static<typeof SyncChannelBindingsAction>
	| Static<typeof ConnectChannelDmAction>;
