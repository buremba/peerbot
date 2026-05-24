// Lobu authoring config API — define agents, connectors, watchers, and
// connections in TypeScript. `lobu apply` imports a project entrypoint (default
// export of `defineConfig`) and maps it to the server's desired state.
//
// This is the `@lobu/cli/config` subpath: a project installs `@lobu/cli` (the
// tool it already runs `apply` with) and authors `lobu.config.ts` against this
// entry. The module is intentionally dependency-light — it must NOT import any
// heavy CLI internals (server bundle, embedded-postgres, etc.), since jiti
// loads it from the project's node_modules at apply time. The
// `config-isolation.test.ts` guard enforces that.

// Connector authoring is re-exported so a project imports its whole authoring
// surface from one entry. Deep-imported from the `define-connector` subpath
// (not the package barrel) to avoid bun's ESM linker flakily failing to resolve
// names through connector-sdk's large re-export barrel (issue #976).
export { defineConnector } from "@lobu/connector-sdk/define-connector";
export type {
  ConnectorActionSpec,
  ConnectorClass,
  ConnectorFeedSpec,
  ConnectorSpec,
} from "@lobu/connector-sdk/define-connector";
// TypeBox schema authoring (extraction schemas, feed/action config schemas).
// Imported directly from @sinclair/typebox — re-exporting through
// connector-sdk's barrel flakily fails under bun's ESM linker (issue #976).
export { Type } from "@sinclair/typebox";
export type { Static } from "@sinclair/typebox";

export * from "./define.js";
export * from "./secret.js";
