import { type Static, Type } from "@sinclair/typebox";

export const ListCatalogAction = Type.Object({
  action: Type.Literal("list_catalog", {
    description:
      "List available (manifest) catalog entries — connectors, skills, watcher templates. Each connector entry's `detail.source_uri` can be passed to `manage_connections` action `install_connector`.",
  }),
  kinds: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("connectors"),
        Type.Literal("skills"),
        Type.Literal("watchers"),
      ]),
      {
        description: "Manifest catalog kinds. Defaults to all.",
      }
    )
  ),
});

export const ListInstalledAction = Type.Object({
  action: Type.Literal("list_installed", {
    description:
      "List installed kinds for the org (connectors, watchers) and/or agent (skills, providers, guardrails, channels). Pass `include_catalog: true` to merge available catalog entries with `installed`/`installable` flags.",
  }),
  kinds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Installed kinds. Org: connectors, watchers. Agent: skills, providers, guardrails, channels.",
    })
  ),
  agent_id: Type.Optional(
    Type.String({ description: "Agent id — required for agent-scoped kinds." })
  ),
  include_catalog: Type.Optional(
    Type.Boolean({
      description:
        "Merge global catalog entries for connectors (org) or skills (agent).",
    })
  ),
});

export const ManageCatalogSchema = Type.Union([
  ListCatalogAction,
  ListInstalledAction,
]);

const CatalogConnectorEntrySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  version: Type.Optional(Type.String()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  detail: Type.Object(
    {
      source_uri: Type.Optional(Type.String()),
      auth_schema: Type.Optional(Type.Unknown()),
      feeds_schema: Type.Optional(Type.Unknown()),
      actions_schema: Type.Optional(Type.Unknown()),
      options_schema: Type.Optional(Type.Unknown()),
      required_capability: Type.Optional(
        Type.Union([Type.String(), Type.Null()])
      ),
      favicon_domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      runtime: Type.Optional(Type.Unknown()),
      login_enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true }
  ),
});

export const ManageCatalogResultSchema = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({
    action: Type.Literal("list_catalog"),
    catalogs: Type.Record(
      Type.String(),
      Type.Object({
        kind: Type.String(),
        entries: Type.Array(
          Type.Union([CatalogConnectorEntrySchema, Type.Unknown()])
        ),
      })
    ),
  }),
  Type.Object({
    action: Type.Literal("list_installed"),
    installed: Type.Record(Type.String(), Type.Unknown()),
  }),
]);

export type ManageCatalogResult = Static<typeof ManageCatalogResultSchema>;
export type ListCatalogArgs = Static<typeof ListCatalogAction>;
export type ListInstalledArgs = Static<typeof ListInstalledAction>;
