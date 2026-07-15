# Connectors package agent rules

Read root `AGENTS.md` first. This package owns built-in Lobu connectors.

## Connector rules
- Connectors are `*.connector.ts` files extending `ConnectorRuntime`.
- npm deps go in the project `package.json` and are bundled by esbuild at compile time.
- Native deps go in `runtime.nix.packages` as nixpkgs refs and are provisioned with `nix-shell` at run time.
- Compile happens on the CLI path (`lobu apply`). It runs `bun install --ignore-scripts` when bun is available, else `npm install --ignore-scripts` because Node ships npm.
- `@lobu/connector-sdk` is externalized and provided by the runtime.
- Keep connector behavior data-driven; avoid hardcoding account/workspace-specific values.

## Validation
- Validation: the root gates (`make pre-pr` + `make review`, see root `AGENTS.md`) plus targeted connector tests.
