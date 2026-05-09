# Lobu → Lobu: finishing the absorption

Lobu repo is deprecated. All 8 package trees already mirrored into `lobu/packages/lobu-*`. Remaining gaps are root-level artifacts, CLI profile config, and structural cleanup. Plan is 4 PRs, landable in order.

## Consolidation decision: `lobu.config.json` → `lobu.toml`

Today `lobu.config.json` at the repo root holds CLI profiles:

```json
{
  "profiles": {
    "local": { "apiUrl": "...", "mcpUrl": "...", "databaseUrl": "...", "embeddingsUrl": "...", "envFile": ".env" }
  }
}
```

Lobu already owns `lobu.toml` with zod schema in `packages/core/src/lobu-toml-schema.ts` (has `[memory]` section). Collapse the JSON into a new TOML section:

```toml
[lobu.profiles.local]
api_url = "http://localhost:8787"
mcp_url = "http://localhost:8787/mcp"
database_url = "postgres://localhost:5432/lobu"
embeddings_url = "http://localhost:8790"
env_file = ".env"
```

- Add `lobu.profiles` table to `lobuConfigSchema`
- Update `packages/lobu-cli/src/lib/config.ts` to read from `lobu.toml` via `@lobu/core`'s parser
- Delete `lobu.config.json` reader entirely (no shim)

One file, one schema, one loader. Fits the user's consolidation ask.

---

## PR-1: Land missing lobu content

Scope:
- `skills/` → copy from `/Users/burakemre/Code/lobu/skills/` (3 dirs: `lobu/`, `openclaw-plugin/`, `lobu-operator/`)
- `benchmarks/memory/` → copy 34 files (JSON configs + suite data + Python adapters)
- `scripts/lobu/` (new dir) — park everything lobu-flavored:
  - `sync-lobu-guidance.ts`
  - `run-memory-benchmark.ts`, `prepare-locomo-suite.ts`, `prepare-longmemeval-suite.ts`
  - `install-connectors.ts`, `dry-run-connector.ts`, `sync-local.ts`, `test-mcp-server.ts`
- Update `package.json` script refs (e.g. `"bench:memory": "bun scripts/lobu/run-memory-benchmark.ts"`) — DONE: each `scripts/lobu/*.ts` is now wired as `lobu:*` in root `package.json`
- Fix `packages/server/src/utils/__tests__/lobu-guidance-sync.test.ts:9` — it reads `skills/lobu/SKILL.md` via `process.cwd()`; confirm it resolves after the copy

Validation:
- `bun run test packages/server/src/utils/__tests__/lobu-guidance-sync.test.ts` passes
- `bun scripts/lobu/run-memory-benchmark.ts --help` resolves
- `make build-packages` clean

Explicitly NOT included: `agents.toml`/`agents.lock` (lobu has its own skill model), `pnpm-workspace.yaml` (bun repo), `owl-*.png` assets, `backfill-*`/`migrate-*`/`finalize-*`/`repair-*` scripts (one-off).

## PR-2: Consolidate CLI profiles into `lobu.toml`

Scope:
- Extend `packages/core/src/lobu-toml-schema.ts` with `lobuProfilesSchema` (record of named profiles with api_url/mcp_url/database_url/embeddings_url/env_file)
- Update `packages/lobu-cli/src/lib/config.ts` to:
  1. Find `lobu.toml` via workspace root walk
  2. Parse via `lobuConfigSchema.parse` (already exported from `@lobu/core`)
  3. Look up `config.lobu?.profiles?.[name]`, map snake_case → camelCase at the boundary
- Delete every reference to `lobu.config.json` in lobu (reader, constants, types)
- Add a `[lobu.profiles.local]` block to each `examples/*/lobu.toml` that the Lobu CLI is meant to target — or leave out, and rely on per-user `~/.lobu/overrides.toml` (decide during implementation)

Validation:
- `packages/lobu-cli` typecheck + tests
- Manual: `cd examples/sales && lobu-cli --profile local <cmd>` resolves URLs from `lobu.toml`

## PR-3: Rename `packages/cli` → `packages/lobu-cli`

Scope:
- `packages/cli` is lobu's agent-deployment CLI (~72 files); `packages/lobu-cli` is Lobu's MCP CLI. Naming is ambiguous today.
- `git mv packages/cli packages/lobu-cli`
- Rename package: currently `@lobu/cli` → keep `@lobu/cli` on npm (name doesn't change), just dir rename
- Update `pnpm-workspace.yaml`/`bun` workspace globs, tsconfig path aliases, every relative import, CI workflow paths
- Check for hardcoded `packages/cli/` string refs

Validation: `bun run typecheck`, `bun run build`, CI lint.

---

## Out of scope (deliberately deferred)

- Flattening the `lobu-*` prefix across all packages. The prefix signals "absorbed subsystem" — useful provenance. Only worth removing if the brand goes too.
- Porting lobu's `.github/workflows/benchmark-memory.yml` and `e2e-openclaw.yml`. Revisit after PR-1 lands and we actually want those in CI.
- Porting lobu's `docs/` (12 files). Most are historical deployment docs for lobu-only infra. Any connector/memory-plugin docs worth keeping can be pulled in piecemeal.
