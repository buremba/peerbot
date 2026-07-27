# Core package agent rules

Read root `AGENTS.md` first. This package holds the shared contracts every other package builds against: types, errors, capabilities, credentials, the guardrail engine, and the logger. Ten workspace packages depend on it.

## Boundaries
- Core is the bottom of the dependency graph. It must not import from `server`, `agent-worker`, `connectors`, or any package above it — if a helper needs one of those, it does not belong here.
- Changing an exported type is a fan-out change. Ten packages compile against it, and `packages/server` typechecks against the **built dist**, not the source.
- Guardrails live in `src/guardrails/`. Infra errors fail open by design, and each trip writes a `guardrail-trip` event — preserve both properties when editing the runner.

## Package-specific traps
- **After any contract change, rebuild before trusting a typecheck.** A stale `dist` produces a green typecheck that CI then fails, and inside a worktree it produces phantom `TS2305` errors resolved from the main checkout's dist. `make pre-pr` builds first for exactly this reason. See `docs/GOTCHAS.md`, "Build & typecheck".
- This package is `composite: true`, so use `bunx tsc --build --force` to force a rebuild. A plain `rm -rf dist` leaves a stale `tsconfig.tsbuildinfo` behind and the next build no-ops.
- Unlike `server` and `connector-sdk`, this package **is** biome-formatted — use `bun run check:fix` from the repo root.

## Validation
- Validation: the root gates (`make pre-pr` + `make review`, see root `AGENTS.md`). For a contract change, also typecheck the consumers — a green build here says nothing about the ten packages downstream.
