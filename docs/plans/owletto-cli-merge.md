# Owletto CLI → `lobu memory`: collapse the second binary

Sequel to `owletto-absorption.md`. That plan said flattening the `owletto-*` prefix was deferred until "the brand goes too." The brand is going. This plan kills the standalone `owletto` bin and folds its 13 commands into `lobu memory <verb>`.

## Why

- `lobu run` already embeds the Owletto backend in-process (`packages/server` boots inside `lobu run`). Two CLIs, one runtime is the worst of both worlds for lobu users.
- `owletto seed` already reads `[memory.owletto]` from `lobu.toml` — the cross-config coupling exists.
- `owletto dev` (docker-compose) contradicts CLAUDE.md ("embedded-only, no Docker"). `docker-compose.dev.yml` does not exist at the repo root. The command is dead code (see PR-2).
- Three near-duplicate health commands (`lobu status`, `owletto doctor`, `owletto health`) is one job.
- Two `init`s with overlapping intent confuses onboarding.

## Constraints

- No users yet. **Hard cut, no compatibility wrappers, no deprecation aliases.** Delete the old paths in the same PR that introduces the new one.
- Goal is a stable, useful surface — not a soft migration.

## Out of scope

- Renaming `packages/owletto-*` directories or the `[memory.owletto]` config key. Provenance prefix stays for now — collapsing the bin is enough churn for one cycle.
- Changing the `openclaw-plugin` MCP plugin name (still `@lobu/openclaw-plugin`). Only its `tokenCommand` doc changes.
- Owletto memory product surface area, schemas, MCP tools.

## Locked decisions

1. **`owletto` bin is removed outright.** No wrapper, no deprecation release. `release-please-config.json` drops the `owletto` package entry. Memory auth is unified with top-level `lobu login`, so anyone with `tokenCommand: "npx owletto token"` in an OpenClaw config updates to `npx -y @lobu/cli token --raw` — surface is small enough that doc updates cover it.
2. **`init` becomes one command.** `lobu init` runs scaffold + memory wiring in one wizard (always asks "enable Owletto memory? [Y/n]", default yes, default URL `http://localhost:8787/mcp`). For existing projects, `lobu memory init` calls the same wizard's wiring stage only. The standalone `owletto init` is deleted.
3. **`configure` and `browser-auth` stay**, namespaced under `lobu memory configure` / `lobu memory browser-auth`. They remain the supported path for wiring non-lobu OpenClaw agents into the memory backend.

---

## Single PR

No users, no compat window, no benefit to leaving the tree in a half-merged state. One PR, one review, one merge. Order below is execution order — not separate commits required.

### 1. Delete dead code

- `packages/owletto-cli/src/commands/dev.ts` — `docker-compose.dev.yml` does not exist; CLAUDE.md mandates embedded-only.
- Remove `dev` from `packages/owletto-cli/src/main.ts` subCommands.
- `git grep -n "owletto dev\|docker-compose.dev"` → clean stragglers.
- Do **not** add `lobu memory dev` — `make dev` is the embedded path.

### 2. Refactor owletto command bodies into pure functions

Owletto uses `citty`, lobu uses `commander`. They can't share a `defineCommand` block, so split:

- For each command in `packages/owletto-cli/src/commands/` → move body to `packages/owletto-cli/src/lib/commands/<name>.ts` as a pure async function with typed args.
- Applies to: `start` `seed` `run` `org` `doctor` `browser-auth` `skills/{add,list}` `openclaw` (login/token/health/configure). `init` flows into step 4. `dev` is gone (step 1).
- Same for `runInitWizard` in `packages/owletto-cli/src/lib/init-wizard.ts` — already a function, just promote it.

### 3. Add `lobu memory` parent command

`packages/cli/src/index.ts` registers `program.command("memory")` with subcommands wired to step 2's lib functions:

- `lobu memory start` → `start.ts` lib
- `lobu memory seed` → `seed.ts` lib
- `lobu memory run [tool] [params]` → `run.ts` lib
- `lobu memory login [url]` / `token` / `health` → `openclaw.ts` lib
- `lobu memory org current|set` → `org.ts` lib
- `lobu memory configure` → `openclaw.ts` (configure)
- `lobu memory browser-auth` → `browser-auth.ts` lib
- `lobu memory skills list|add` → owletto's `skills/{add,list}` libs
- `lobu memory init` → calls `runInitWizard` standalone for already-scaffolded projects

Health surface:
- `lobu doctor` (new top-level) folds owletto's `doctor` (system deps) + `health` (auth/MCP).
- `lobu memory health` is the same code path as `lobu doctor --memory-only`.
- `lobu status` stays as agent runtime health.

### 4. Consolidate `init`

- `packages/cli/src/commands/init.ts` scaffold flow gains a final wizard stage: "Enable Owletto memory for this project? [Y/n]" → on yes, call `runInitWizard` with `http://localhost:8787/mcp` default; writes OpenClaw plugin config alongside `lobu.toml` and `.env`.
- Delete `packages/owletto-cli/src/commands/init.ts`.

### 5. Delete the `owletto` bin

- Remove `bin` from `packages/owletto-cli/package.json`; set `"private": true`; rename package to `@lobu/owletto-cli-lib`.
- Delete `packages/owletto-cli/src/bin.ts`, `src/main.ts`, and all citty wrappers in `src/commands/*` (lib functions stay; they're consumed by `@lobu/cli`).
- Drop the `owletto` entry from `release-please-config.json` and `.release-please-manifest.json`.

### 6. CI / config / plugin sweep

- `.github/workflows/ci.yml:87, 258` — drop `owletto-cli` from the publish job; keep test job pointing at the now-library package.
- `config/knip.ts`, `config/biome.config.json`, `tsconfig.json` — adjust paths if needed after the rename.
- `packages/openclaw-plugin/README.md` and `openclaw.plugin.json` description — reference `npx -y @lobu/cli token --raw` as the canonical `tokenCommand` example (auth is unified with top-level `lobu login`, no separate memory token).

### 7. Doc + skill sweep

- `README.md:44-45` — `npx owletto@latest …` → `lobu memory …`
- `packages/landing/public/getting-started/skills.md:23,26`, `getting-started/memory.md`, `getting-started.md:109`
- Rename `packages/landing/public/reference/owletto-cli.md` → `lobu-memory.md`; rewrite every example. Update Astro routes / sidebar config / `src/content/docs/reference/owletto-cli.md` mirror.
- `packages/landing/public/blog/mcp-is-overengineered-skills-are-too-primitive.md:130`, `blog/hello-world.md:31`, `guides/troubleshooting.md:122`
- `skills/owletto/SKILL.md`, `skills/owletto/references/cli-fallback.md`, `skills/owletto/references/client-install.md`, `skills/openclaw-plugin/SKILL.md`
- `docs/RELEASING.md` — drop `owletto` from the published-packages list
- The `owletto` Claude Code skill metadata in this repo

### Validation (run before pushing)

- `lobu run` boots the same runtime as the old `owletto start`
- `lobu memory run search_knowledge '{"query":"x"}'` round-trips through gateway proxy
- `lobu token --raw` prints a usable bearer that the OpenClaw plugin can use
- `lobu init my-test` walks scaffold → memory wiring → produces a working project
- `lobu doctor` is green when DB + memory MCP are reachable
- `make build-packages` clean
- `bun run typecheck` clean
- `bun run build` for `packages/landing` clean
- `git grep -n "npx owletto\|owletto-cli/dist/bin"` returns zero hits

Estimate: ~3-4 days end-to-end. Diff is large but mechanical past the `lobu memory` wiring.
