/**
 * TypeBox schemas and result types for the manage_connections tool.
 */

import { type Static, Type } from "@sinclair/typebox";
import type { ChannelAudience } from "../../../authz/audience";
import { PaginationFields } from "../schemas/common-fields";

/** A channel binding as returned by list_channel_bindings. */
export interface ChannelBindingDto {
	platform: string;
	channelId: string;
	teamId?: string;
	createdAt: number;
}

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

const PLATFORM_DESC =
	"Chat platform key (lowercase, e.g. 'slack', 'telegram').";
const CHANNEL_ID_DESC =
	"Platform channel id as the binding stores it (may be platform-prefixed, e.g. 'slack:C…').";
const TEAM_ID_DESC =
	"Provider tenant id (Slack team_id, …); omit for tenantless platforms.";

export const ListChannelBindingsAction = Type.Object({
	action: Type.Literal("list_channel_bindings"),
	agent_id: Type.String({
		description: "Agent whose channel bindings to list.",
	}),
});

export const BindChannelAction = Type.Object({
	action: Type.Literal("bind_channel"),
	agent_id: Type.String({ description: "Agent to bind the channel to." }),
	platform: Type.String({ description: PLATFORM_DESC }),
	channel_id: Type.String({ description: CHANNEL_ID_DESC }),
	team_id: Type.Optional(Type.String({ description: TEAM_ID_DESC })),
});

export const UnbindChannelAction = Type.Object({
	action: Type.Literal("unbind_channel"),
	agent_id: Type.String({ description: "Agent to unbind the channel from." }),
	platform: Type.String({ description: PLATFORM_DESC }),
	channel_id: Type.String({ description: CHANNEL_ID_DESC }),
	team_id: Type.Optional(Type.String({ description: TEAM_ID_DESC })),
});

export const GetChannelAudienceAction = Type.Object({
	action: Type.Literal("get_channel_audience"),
	agent_id: Type.Optional(
		Type.String({
			description:
				"Agent whose bound channels' recall audience to read (per-agent view).",
		}),
	),
	connection_id: Type.Optional(
		Type.Number({
			description:
				"Connection whose channels' recall audience to read (connection-centric view, across every agent that bound a channel through it). Each audience carries the binding's agent. Provide exactly one of agent_id / connection_id.",
		}),
	),
});

export const ConnectChannelDmAction = Type.Object({
	action: Type.Literal("connect_channel_dm"),
	agent_id: Type.String({ description: "Agent to wire the caller's DM to." }),
	external_id: Type.String({
		description:
			"Managed Slack install external id (the slackinst-… handle) to open a DM through.",
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

export type ManageConnectionsResult =
	| { error: string; setup_url?: string }
	| {
			action: "list";
			connections: ConnectionRow[];
			total: number;
			limit: number;
			offset: number;
			view_url?: string;
	  }
	| {
			action: "list_connector_groups";
			groups: Array<{
				connector_key: string;
				connector_name: string | null;
				favicon_domain: string | null;
				connection_count: number;
				facets: ConnectionFacets;
				connections: Array<{
					id: number;
					display_name: string | null;
					feed_count: number;
				}>;
			}>;
	  }
	| { action: "get"; connection: ConnectionRow; view_url?: string }
	| {
			action: "create";
			connection: ConnectionRow;
			connector: Record<string, unknown>;
			view_url?: string;
			auth_run_id?: number;
	  }
	| {
			action: "connect";
			connection_id: number;
			slug?: string;
			status: "active";
			message: string;
			view_url?: string;
	  }
	| {
			action: "connect";
			connection_id: number;
			slug?: string;
			status: "pending_auth";
			auth_type: string;
			instructions: string;
			connect_url?: string;
			connect_token?: string;
			auth_profile_slug?: string;
			view_url?: string;
	  }
	| { action: "update"; connection: ConnectionRow }
	| { action: "delete"; deleted: true; connection_id: number; slug: string }
	| { action: "reauthenticate"; connection_id: number; auth_run_id: number }
	| {
			action: "test";
			status: string;
			message: string;
			has_token?: boolean;
			has_refresh?: boolean;
			expires_at?: string | null;
	  }
	| {
			action: "install_connector";
			installed: true;
			connector_key: string;
			name: string;
			version: string;
			code_hash: string;
			updated: boolean;
	  }
	| { action: "uninstall_connector"; uninstalled: true; connector_key: string }
	| ConnectorActionOk<"toggle_connector_login", { login_enabled: boolean }>
	| ConnectorActionOk<"update_connector_auth", { keys_updated: string[] }>
	| ConnectorActionOk<"update_connector_default_config">
	| ConnectorActionOk<
			"update_connector_default_repair_agent",
			{ default_repair_agent_id: string | null }
	  >
	| ConnectorActionOk<
			"set_connector_entity_link_overrides",
			{ overrides: Record<string, unknown> | null }
	  >
	| {
			action: "list_channel_bindings";
			agent_id: string;
			bindings: ChannelBindingDto[];
	  }
	| {
			action: "bind_channel";
			success: true;
			agent_id: string;
			platform: string;
			channel_id: string;
			team_id?: string;
	  }
	| { action: "unbind_channel"; success: true }
	| {
			action: "get_channel_audience";
			agent_id?: string;
			connection_id?: number;
			audiences: ChannelAudience[];
	  }
	| {
			action: "connect_channel_dm";
			success: true;
			platform: "slack";
			channel_id: string;
			team_id: string | null;
	  };

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
	| Static<typeof GetChannelAudienceAction>
	| Static<typeof ConnectChannelDmAction>;
