/**
 * TypeBox schemas and result types for the manage_connections tool.
 */

import { type Static, Type } from "@sinclair/typebox";

const PaginationFields = {
  limit: Type.Optional(
    Type.Number({ description: "Page size (default: 100)", default: 100 })
  ),
  offset: Type.Optional(
    Type.Number({ description: "Pagination offset (default: 0)", default: 0 })
  ),
};

const ConnectionFacetsSchema = Type.Object({
  data: Type.Boolean(),
  chat: Type.Boolean(),
  actions: Type.Boolean(),
  audience: Type.Boolean(),
});

// ============================================
// Connect setup-required continuation
// ============================================
//
// `connections.connect` setup-required outcomes (GitHub app install, missing
// OAuth app config, interactive pairing, device pairing, ...) are NON-TERMINAL,
// actionable continuations, NOT business errors. They MUST survive `run_sdk` /
// `query_sdk` as a structured return value (no `error` field) so an agent can
// read `next_action`, `resume_call`, and `completion_check` and drive setup
// instead of seeing a prose-only ScriptError. Absolute URLs are required so the
// continuation is usable outside the gateway origin. The App install callback
// (github) creates the active connection ITSELF, so its completion check is a
// read-back poll — NOT a retry of `connect` (retrying would re-trip the guard).

export const ConnectSetupFamily = Type.Union(
  [
    Type.Literal("oauth"),
    Type.Literal("app_installation"),
    Type.Literal("env_keys"),
    Type.Literal("browser"),
    Type.Literal("interactive"),
    Type.Literal("device_bound"),
  ],
  {
    description:
      "Which connection setup family this continuation belongs to. Drives the completion check.",
  }
);

export const ConnectSetupNextAction = Type.Union(
  [
    Type.Literal("install_app"),
    Type.Literal("configure_oauth_app"),
    Type.Literal("select_auth_profile"),
    Type.Literal("pair_interactive"),
    Type.Literal("pair_browser"),
    Type.Literal("connect_device"),
    Type.Literal("open_setup"),
  ],
  {
    description:
      "Machine-readable next step the caller should drive to make this connection executable.",
  }
);

export const ConnectSdkCall = Type.Object({
  sdk_method: Type.String({
    description: "Dotted ClientSDK method name, e.g. connections.connect.",
  }),
  arguments: Type.Array(Type.Unknown(), {
    description:
      "Positional method arguments. This supports both object-taking methods and connections.get(id).",
  }),
});

export const ConnectCompletionCheck = Type.Object({
  call: ConnectSdkCall,
  success_when: Type.Union(
    [
      Type.Object({
        path: Type.String(),
        equals: Type.Unknown(),
      }),
      Type.Object({
        path: Type.String(),
        includes: Type.Unknown(),
      }),
    ],
    {
      description: "Observable condition that marks setup complete.",
    }
  ),
  poll_interval_ms: Type.Integer({ minimum: 250, maximum: 30000 }),
  description: Type.String({
    description: "Human-readable summary of the completion check.",
  }),
});

export type ConnectSdkCallType = Static<typeof ConnectSdkCall>;

export type ConnectSetupFamilyType = Static<typeof ConnectSetupFamily>;
export type ConnectSetupNextActionType = Static<typeof ConnectSetupNextAction>;
export type ConnectCompletionCheckType = Static<typeof ConnectCompletionCheck>;

// ============================================
// Schema
// ============================================

export const ListConnectorGroupsAction = Type.Object({
  action: Type.Literal("list_connector_groups", {
    description: "List connectors grouped with their connection + feed counts.",
  }),
  entity_id: Type.Optional(
    Type.Number({
      description:
        "Filter to connectors that have a connection (or feed) linked to this entity.",
    })
  ),
});

export const ListAction = Type.Object({
  action: Type.Literal("list", {
    description: "Paginated list of connections with filters.",
  }),
  connector_key: Type.Optional(
    Type.String({ description: "Filter by connector key (e.g. google.gmail)" })
  ),
  status: Type.Optional(
    Type.String({
      description: "Filter by status: active, paused, error, revoked",
    })
  ),
  entity_id: Type.Optional(
    Type.Number({ description: "Filter by linked entity ID" })
  ),
  created_by: Type.Optional(
    Type.String({
      description: "Filter by user ID who created the connection",
    })
  ),
  connection_ids: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      description: "Filter to specific connection IDs",
    })
  ),
  setup_attempt_id: Type.Optional(
    Type.String({
      description:
        "Filter to connections correlated with an app-install setup attempt",
    })
  ),
  ...PaginationFields,
});

export const GetAction = Type.Object({
  action: Type.Literal("get", {
    description: "Fetch one connection by id.",
  }),
  connection_id: Type.Number({ description: "Connection ID" }),
});

export const CreateAction = Type.Object({
  action: Type.Literal("create", {
    description:
      "Create a connection from a pre-existing auth profile (prefer `connect` to create + auth in one call).",
  }),
  connector_key: Type.String({
    description: "Connector key (e.g. google.gmail)",
  }),
  display_name: Type.Optional(
    Type.String({ description: "Human-readable name" })
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "Stable public identifier for the connection. Auto-generated from display_name when omitted.",
    })
  ),
  auth_profile_slug: Type.Optional(
    Type.String({
      description: "Reusable auth profile slug for runtime/account auth",
    })
  ),
  app_auth_profile_slug: Type.Optional(
    Type.String({
      description: "Reusable auth profile slug for OAuth app credentials",
    })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Connection config",
    })
  ),
  created_by: Type.Optional(
    Type.String({
      description:
        "Override the connection owner (admin/owner only). Defaults to current user.",
    })
  ),
  device_worker_id: Type.Optional(
    // Nullable: serverless connections (no device) send `null`, not just omit.
    // The UI/serverless callers pass `device_worker_id: null` explicitly, which
    // a bare `Type.String` rejected ("Expected string"); `resolveDeviceBinding`
    // normalizes null/empty to serverless.
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Run this connection's syncs/actions on a specific device worker (its device_workers.id) instead of the Lobu server (runs serverless). Null/omit runs serverless. Required for connectors that declare a required_capability. The device must belong to you or be granted to this org.",
    })
  ),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Entity IDs to tag this connection with (links the connection to entities)",
    })
  ),
});

export const UpdateAction = Type.Object({
  action: Type.Literal("update", {
    description:
      "Patch a connection's settings, status, slug, device binding, or (chat connections) fallback agent.",
  }),
  connection_id: Type.Number({ description: "Connection ID" }),
  display_name: Type.Optional(Type.String()),
  agent_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Fallback agent for a chat connection when no Behavior subscription matches. Null clears the fallback.",
    })
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "New stable slug for the connection (display_name changes never touch the slug)",
    })
  ),
  status: Type.Optional(
    Type.String({ description: "active, paused, error, revoked" })
  ),
  auth_profile_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  app_auth_profile_slug: Type.Optional(
    Type.Union([Type.String(), Type.Null()])
  ),
  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Entity IDs to tag this connection with. Pass [] (or null) to clear all links; omit to leave unchanged.",
    })
  ),
  device_worker_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Reassign which device worker runs this connection. Null moves it back to the Lobu server, runs serverless (only allowed if the connector has no required_capability).",
    })
  ),
  replace_config: Type.Optional(
    Type.Boolean({
      description:
        "When true and `config` is provided, replace the stored connection config with exactly that object (declarative apply); when false/omitted, merge into the existing config (default).",
    })
  ),
});

export const ApplyChatConnectionAction = Type.Object({
  action: Type.Literal("apply_chat_connection", {
    description:
      "Declaratively upsert a chat connection keyed by stable_id (used by `lobu apply`).",
  }),
  stable_id: Type.String({
    description: "Stable declarative connection id used by lobu apply.",
  }),
  connector_key: Type.String({ description: "Chat connector key." }),
  display_name: Type.Optional(Type.String()),
  agent_id: Type.Optional(
    Type.String({
      description:
        "Declarative fallback agent. Behavior subscriptions remain authoritative when present.",
    })
  ),
  config: Type.Record(Type.String(), Type.Any()),
  settings: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export const DeleteAction = Type.Object({
  action: Type.Literal("delete", { description: "Delete a connection." }),
  connection_id: Type.Number({ description: "Connection ID" }),
});

export const ReauthenticateAction = Type.Object({
  action: Type.Literal("reauthenticate", {
    description:
      "Start a fresh OAuth authorization or interactive pairing flow for an existing connection.",
  }),
  connection_id: Type.Number({
    description:
      "Connection ID whose OAuth-account or interactive auth profile should be reauthenticated.",
  }),
});

export const TestAction = Type.Object({
  action: Type.Literal("test", {
    description: "Probe a connection's credentials/token validity.",
  }),
  connection_id: Type.Number({ description: "Connection ID to test" }),
});

export const InstallConnectorAction = Type.Object({
  action: Type.Literal("install_connector", {
    description:
      "Enable a reviewed catalog connector with connector_id, or install from exactly one source_url/source_uri/source_code/mcp_url. Catalog enablement does not authenticate external accounts.",
  }),
  connector_id: Type.Optional(
    Type.String({
      description:
        "For action=install_connector. ID of a reviewed catalog connector, e.g. google.gmail. Mutually exclusive with source_url/source_uri/source_code/mcp_url.",
    })
  ),
  source_url: Type.Optional(
    Type.String({
      description:
        "For action=install_connector. Mutually exclusive with connector_id/source_uri/source_code/mcp_url — provide exactly one. Direct URL to a connector source file.",
    })
  ),
  source_uri: Type.Optional(
    Type.String({
      description:
        "For action=install_connector. Mutually exclusive with connector_id/source_url/source_code/mcp_url — provide exactly one. Local file source URI or path (e.g. the source_uri from a manage_catalog list_catalog entry).",
    })
  ),
  source_code: Type.Optional(
    Type.String({
      description:
        "For action=install_connector. Mutually exclusive with connector_id/source_url/source_uri/mcp_url — provide exactly one. Inline TypeScript or pre-compiled JavaScript source code.",
    })
  ),
  compiled: Type.Optional(
    Type.Boolean({
      description:
        "Set to true if source_code is already compiled JavaScript (skip compilation)",
    })
  ),
  mcp_url: Type.Optional(
    Type.String({
      description:
        "For action=install_connector. Mutually exclusive with connector_id/source_url/source_uri/source_code — provide exactly one. URL to a remote MCP server (Streamable HTTP). Probes the server directly, no compilation needed.",
    })
  ),
  auth_values: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Reusable auth values for env_keys and OAuth client keys. Stored as auth profiles.",
    })
  ),
});

export const UninstallConnectorAction = Type.Object({
  action: Type.Literal("uninstall_connector", {
    description:
      "Archive an installed connector definition. Blocked while connections reference it.",
  }),
  connector_key: Type.String({ description: "Connector key to uninstall" }),
});

export const ConnectAction = Type.Object({
  action: Type.Literal("connect", {
    description:
      "Recommended way to add a connection: creates the connection + auth link in one call. Returns a connect_url for the user; poll `get` until status='active'.",
  }),
  connector_key: Type.String({
    description: "Connector key (e.g. google.gmail)",
  }),
  display_name: Type.Optional(
    Type.String({ description: "Human-readable name for the connection" })
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "Stable public identifier for the connection. Auto-generated from display_name when omitted.",
    })
  ),
  auth_profile_slug: Type.Optional(
    Type.String({
      description: "Reusable auth profile slug for runtime/account auth",
    })
  ),
  app_auth_profile_slug: Type.Optional(
    Type.String({
      description: "Reusable auth profile slug for OAuth app credentials",
    })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Connection config",
    })
  ),
  device_worker_id: Type.Optional(
    // Nullable for serverless connections — see CreateAction note.
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Run this connection's syncs/actions on a specific device worker (its device_workers.id) instead of the Lobu server (runs serverless). Null/omit runs serverless. Required for connectors that declare a required_capability. The device must belong to you or be granted to this org.",
    })
  ),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Entity IDs to tag this connection with (links the connection to entities)",
    })
  ),
});

export const ToggleConnectorLoginAction = Type.Object({
  action: Type.Literal("toggle_connector_login", {
    description:
      "Enable/disable an installed connector as a login provider (requires OAuth auth_schema).",
  }),
  connector_key: Type.String({
    description: "Connector key (e.g. github, google.gmail)",
  }),
  enabled: Type.Boolean({
    description: "Enable or disable this connector as a login provider",
  }),
});

export const UpdateConnectorAuthAction = Type.Object({
  action: Type.Literal("update_connector_auth", {
    description:
      "Upsert reusable default auth values (env_keys / OAuth client keys) for an installed connector.",
  }),
  connector_key: Type.String({
    description: "Connector key (e.g. reddit, google.gmail)",
  }),
  auth_values: Type.Record(Type.String(), Type.String(), {
    description: "Auth values to upsert (env_keys and OAuth client keys)",
  }),
});

export const UpdateConnectorDefaultConfigAction = Type.Object({
  action: Type.Literal("update_connector_default_config", {
    description: "Set an installed connector's default connection config.",
  }),
  connector_key: Type.String({ description: "Connector key" }),
  default_connection_config: Type.Record(Type.String(), Type.Any(), {
    description: "Default connection config (action_modes, etc.)",
  }),
});

export const UpdateConnectorDefaultRepairAgentAction = Type.Object({
  action: Type.Literal("update_connector_default_repair_agent", {
    description: "Set/clear the default repair agent for feeds of a connector.",
  }),
  connector_key: Type.String({ description: "Connector key" }),
  default_repair_agent_id: Type.Union([Type.String(), Type.Null()], {
    description:
      "Default repair agent ID for feeds of this connector. Null clears the default.",
  }),
});

const CHANNEL_ID_DESC =
  "Platform channel id (may be platform-prefixed, e.g. 'slack:C…').";

export const SetChannelAboutAction = Type.Object({
  action: Type.Literal("set_channel_about", {
    description:
      "Set manual business-entity links for a chat channel (UI / operator edits).",
  }),
  connection_id: Type.Number({
    description: "Chat connection owning the channel.",
  }),
  channel_id: Type.String({ description: CHANNEL_ID_DESC }),
  about_entity_ids: Type.Array(Type.Number(), {
    description: "Business entity ids this channel is about.",
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
  Type.Object({
    error: Type.String(),
    error_code: Type.Optional(Type.Literal("connector_setup_required")),
    connector_key: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    install_type: Type.Optional(
      Type.Union([
        Type.Literal("app_installation"),
        Type.Literal("oauth_app_profile"),
      ])
    ),
    next_action: Type.Optional(
      Type.Union([
        Type.Literal("install_app"),
        Type.Literal("configure_oauth_app"),
        Type.Literal("open_setup"),
      ])
    ),
    setup_url: Type.Optional(Type.String()),
    install_url: Type.Optional(Type.String()),
    install_shape: Type.Optional(
      Type.Union([
        Type.Literal("oauth-code-exchange"),
        Type.Literal("github-app"),
      ])
    ),
    setup_instructions: Type.Optional(Type.String()),
  }),
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
  // Setup-required continuation — a NON-TERMINAL, actionable outcome that MUST
  // survive run_sdk/query_sdk as a return value (no `error` key). Distinct from
  // the `pending_auth` OAuth-pending variant: that already created a connection
  // and is waiting on the user's OAuth grant; this variant could NOT create an
  // executable connection yet and tells the caller exactly what to do next.
  Type.Object({
    action: Type.Union([Type.Literal("connect"), Type.Literal("create")]),
    status: Type.Literal("setup_required"),
    connector_key: Type.String(),
    setup_family: ConnectSetupFamily,
    next_action: ConnectSetupNextAction,
    resume_call: Type.Optional(ConnectSdkCall),
    completion_check: Type.Optional(ConnectCompletionCheck),
    instructions: Type.String(),
    error_code: Type.Optional(Type.Literal("connector_setup_required")),
    install_type: Type.Optional(
      Type.Union([
        Type.Literal("app_installation"),
        Type.Literal("oauth_app_profile"),
      ])
    ),
    install_shape: Type.Optional(
      Type.Union([
        Type.Literal("oauth-code-exchange"),
        Type.Literal("github-app"),
      ])
    ),
    setup_instructions: Type.Optional(Type.String()),
    setup_url: Type.Optional(Type.String()),
    install_url: Type.Optional(Type.String()),
    connect_url: Type.Optional(Type.String()),
    connection_id: Type.Optional(Type.Integer()),
    slug: Type.Optional(Type.String()),
    auth_run_id: Type.Optional(Type.Integer()),
    setup_attempt_id: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
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
    expires_at: Type.Optional(Type.String()),
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
    action: Type.Literal("reauthenticate"),
    connection_id: Type.Integer(),
    auth_profile_slug: Type.String(),
    connect_url: Type.String(),
    expires_at: Type.String(),
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
  Type.Object({
    action: Type.Literal("set_channel_about"),
    success: Type.Literal(true),
    connection_id: Type.Integer(),
    channel_id: Type.String(),
    about_entity_ids: Type.Array(Type.Integer()),
  }),
]);
export type ManageConnectionsResult = Static<
  typeof ManageConnectionsResultSchema
>;

export type ConnectionConnectInput = Omit<
  Static<typeof ConnectAction>,
  "action"
>;
export type ConnectionCreateInput = Omit<Static<typeof CreateAction>, "action">;
export type ConnectionUpdateInput = Omit<Static<typeof UpdateAction>, "action">;
export type InstallConnectorInput = Omit<
  Static<typeof InstallConnectorAction>,
  "action"
>;

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
  | Static<typeof SetChannelAboutAction>;
