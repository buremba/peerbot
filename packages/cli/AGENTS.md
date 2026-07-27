# CLI package agent rules

Read root `AGENTS.md` first. This package is the `lobu` binary users install from npm: commands, project templates, config resolution, and the bundled server the Owletto Mac app shells out to.

## Boundaries
- This is a published user-facing binary. Error messages are product surface — write them for someone who has never read this repo, and keep the agent-facing vocabulary rule (**Behavior**, never `watcher`) in anything a user or agent sees.
- `bin/lobu.js` runs on whatever Node the user has, *before* the bundle loads. Keep it dependency-free and import-free; anything it needs must be inline.
- The installed Mac app invokes the global `lobu` on PATH and runs the frozen `dist`, so a source edit is invisible until the package is rebuilt.

## Package-specific traps
- **The dynamic import in `bin/lobu.js` is required — do not "fix" it to a static import.** A static import is hoisted and evaluated before the Node-version gate runs, so an unsupported Node would load the bundle and throw a cryptic error instead of the friendly message. This is a deliberate, documented exception to the repo's static-import rule.
- Node support is 22–24 and 26+ (25 boots without the SDK sandbox, because isolated-vm@6 covers 22–24 and @7 covers 26+). This policy is expressed in several places that must stay in sync: `bin/lobu.js` (minimum only), `src/internal/node-version.ts` (the full classifier), `packages/server/src/utils/assert-node-version.ts`, and the package `engines` fields. Change them together, not in prose.
- This package **is** biome-formatted — use `bun run check:fix` from the repo root.
- `packages/cli` builds last in every build list because it bundles the others; a new workspace package it depends on must be added *before* it. See `docs/GOTCHAS.md`, "Build & typecheck".

## Validation
- Validation: the root gates (`make pre-pr` + `make review`, see root `AGENTS.md`) plus targeted CLI tests. Changing command output or the version gate needs a real invocation — run the built binary, not just the unit test.
