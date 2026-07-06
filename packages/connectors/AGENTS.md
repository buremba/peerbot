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
- For connector changes, run targeted tests plus relevant build/typecheck, then `make review` before PR/merge.
