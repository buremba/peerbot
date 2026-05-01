# Owletto → Lobu: finishing the absorption

Owletto repo is deprecated. All 8 package trees already mirrored into `lobu/packages/owletto-*`. Remaining gaps are root-level artifacts, CLI profile config, and structural cleanup. Plan is 4 PRs, landable in order.

## Consolidation decision: `owletto.config.json` → `lobu.toml`

Today `owletto.config.json` at the repo root holds CLI profiles:

```json
{
  "profiles": {
    "local": { "apiUrl": "...", "mcpUrl": "...", "databaseUrl": "...", "embeddingsUrl": "...", "envFile": ".env" }
  }
}
```

Lobu already owns `lobu.toml` with zod schema in `packages/core/src/lobu-toml-schema.ts` (has `[memory.owletto]` section). Collapse the JSON into a new TOML section:

```toml
[owletto.profiles.local]
api_url = "http://localhost:8787"
mcp_url = "http://localhost:8787/mcp"
database_url = "postgres://localhost:5432/owletto"
embeddings_url = "http://localhost:8790"
env_file = ".env"
```

- Add `owletto.profiles` table to `lobuConfigSchema`
- Update `packages/owletto-cli/src/lib/config.ts` to read from `lobu.toml` via `@lobu/core`'s parser
- Delete `owletto.config.json` reader entirely (no shim)

One file, one schema, one loader. Fits the user's consolidation ask.

---

## PR-1: Land missing owletto content

Scope:
- `skills/` → copy from `/Users/burakemre/Code/owletto/skills/` (3 dirs: `owletto/`, `openclaw-plugin/`, `lobu-operator/`)
- `benchmarks/memory/` → copy 34 files (JSON configs + suite data + Python adapters)
- `scripts/owletto/` (new dir) — park everything owletto-flavored:
  - `sync-owletto-guidance.ts`
  - `run-memory-benchmark.ts`, `prepare-locomo-suite.ts`, `prepare-longmemeval-suite.ts`
  - `install-connectors.ts`, `dry-run-connector.ts`, `sync-local.ts`, `test-mcp-server.ts`
- Update `package.json` script refs (e.g. `"bench:memory": "bun scripts/owletto/run-memory-benchmark.ts"`)
- Fix `packages/server/src/utils/__tests__/owletto-guidance-sync.test.ts:9` — it reads `skills/owletto/SKILL.md` via `process.cwd()`; confirm it resolves after the copy

Validation:
- `bun run test packages/server/src/utils/__tests__/owletto-guidance-sync.test.ts` passes
- `bun scripts/owletto/run-memory-benchmark.ts --help` resolves
- `make build-packages` clean

Explicitly NOT included: `agents.toml`/`agents.lock` (lobu has its own skill model), `pnpm-workspace.yaml` (bun repo), `owl-*.png` assets, `backfill-*`/`migrate-*`/`finalize-*`/`repair-*` scripts (one-off).

## PR-2: Consolidate CLI profiles into `lobu.toml`

Scope:
- Extend `packages/core/src/lobu-toml-schema.ts` with `owlettoProfilesSchema` (record of named profiles with api_url/mcp_url/database_url/embeddings_url/env_file)
- Update `packages/owletto-cli/src/lib/config.ts` to:
  1. Find `lobu.toml` via workspace root walk
  2. Parse via `lobuConfigSchema.parse` (already exported from `@lobu/core`)
  3. Look up `config.owletto?.profiles?.[name]`, map snake_case → camelCase at the boundary
- Delete every reference to `owletto.config.json` in lobu (reader, constants, types)
- Add a `[owletto.profiles.local]` block to each `examples/*/lobu.toml` that the Owletto CLI is meant to target — or leave out, and rely on per-user `~/.lobu/overrides.toml` (decide during implementation)

Validation:
- `packages/owletto-cli` typecheck + tests
- Manual: `cd examples/sales && owletto-cli --profile local <cmd>` resolves URLs from `lobu.toml`

## PR-3: Rename `packages/cli` → `packages/lobu-cli`

Scope:
- `packages/cli` is lobu's agent-deployment CLI (~72 files); `packages/owletto-cli` is Owletto's MCP CLI. Naming is ambiguous today.
- `git mv packages/cli packages/lobu-cli`
- Rename package: currently `@lobu/cli` → keep `@lobu/cli` on npm (name doesn't change), just dir rename
- Update `pnpm-workspace.yaml`/`bun` workspace globs, tsconfig path aliases, every relative import, CI workflow paths
- Check for hardcoded `packages/cli/` string refs

Validation: `bun run typecheck`, `bun run build`, CI lint.

## PR-4: Gateway de-duplication audit

Scope — investigate only, convert findings into a follow-up PR if warranted:
- `packages/gateway` is lobu-native (357 files)
- `packages/server/src/lobu/gateway.ts` is a thin adapter
- Determine: is the adapter live (hit by server routes) or dead code from the pre-merge era?
- If dead → delete in the same PR
- If live → document the boundary in a 1-line header comment and close the audit

Reuses the grep pattern `grep -rn "from.*lobu/gateway" packages/server/src`.

---

## Out of scope (deliberately deferred)

- Flattening the `owletto-*` prefix across all packages. The prefix signals "absorbed subsystem" — useful provenance. Only worth removing if the brand goes too.
- Porting owletto's `.github/workflows/benchmark-memory.yml` and `e2e-openclaw.yml`. Revisit after PR-1 lands and we actually want those in CI.
- Porting owletto's `docs/` (12 files). Most are historical deployment docs for owletto-only infra. Any connector/memory-plugin docs worth keeping can be pulled in piecemeal.
