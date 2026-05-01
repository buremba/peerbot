# `lobu apply` — Plan

Status: **planning** · Owner: @buremba · Reviewed against pi second-opinion 2026-04-30

## Goal

Provide a one-way `lobu.toml` → Lobu Cloud org converger. Mental model: `terraform apply` lite. Files declare desired state, the CLI shows a plan, the user confirms, the CLI calls existing server endpoints (which are idempotent) in dependency order. Re-running converges.

**Reuse-first**: deliberately *not* building a new server-side apply API or state substrate. Every existing endpoint is already idempotent or near-idempotent — the gap is one connection upsert route. Total v1: 3 PRs, ~600 LOC.

## Mental model

```
desired state (lobu.toml + agent dirs)
        │
        ▼
   CLI: parse with cli/config/loader.ts
        │
        ▼
   CLI: GET current state for each resource
        │
        ▼
   CLI: render diff, prompt to confirm
        │
        ▼
   CLI: call existing endpoints in order
        │   POST /api/:orgSlug/agents/        (upsert)
        │   PATCH /:agentId/config            (settings + skills_config)
        │   PUT  /:agentId/platforms/by-stable-id/:stableId  (NEW route)
        │   POST /api/:orgSlug/manage_entity_schema     (existing admin tool)
        │   POST /api/:orgSlug/manage_relationship_schema
        │
        ▼
   per-agent reports complete; if any fail, re-run apply (idempotent)
```

## Locked decisions

1. **Verb is `lobu apply`** (not `sync`). One-way semantics, terraform-flavored. Leaves room for `lobu pull` in v2 without naming collision.
2. **No new server-side apply API.** CLI loops over existing endpoints in dependency order. Every endpoint is or becomes idempotent in v1.
3. **No new state table.** Drift detection is "live state vs desired state" computed client-side at plan time. No `managed_by` marker → no safe `--prune` in v1; drift is reported, never deleted.
4. **CLI parses `lobu.toml`, not server.** Reuses existing `cli/src/config/loader.ts:loadConfig`. Server reuses its existing route handlers — no parser duplication, no multipart upload.
5. **Same base host for `/api` and `/mcp`.** `deriveApiBaseUrl(mcpUrl)` (already in `_lib/openclaw-cmd.ts`) gives the API root; apply hits `/api/:orgSlug/agents/...`, MCP commands hit `/mcp/:orgSlug` — same server, different paths.
6. **Skills**: normalized via the existing file-loader transformation into `agents.skills_config` (already a JSON column). Sent through `PATCH /:agentId/config`. Raw `SKILL.md` round-trip is v2.
7. **Secrets**: deferred to v3. v1 reads `$VAR` references in `lobu.toml`, queries the org's existing-secrets list, fails the plan loudly if any are missing. v1 never reads `.env` and never uploads values.
8. **Memory data deferred to v3**. v1 ships memory **schema** only (entity + relationship types via existing admin tools). Watchers, entities, relationships, knowledge are out.
9. **Agent ID collision (PR B in old plan)** — explicitly out of scope. Document the constraint in `lobu apply` error messages: "agent IDs must currently be globally unique across cloud orgs; this will change with [link to issue]." Don't block apply on this.
10. **Default flow**: GET current state → render diff → prompt to confirm. `--dry-run` shows diff and exits. `--yes` skips prompt for CI use. No `--prune`, no `--force` in v1.

## Phasing — what ships when

### v1 (this plan)

CLI-visible:
- `lobu apply [--dry-run] [--yes] [--only agents|memory] [--org <slug>]`
- Resources synced: agents (metadata + prompt files + settings, including 3 newly-persisted fields), local skills (normalized into `skills_config`), provider declarations + availability check, memory entity types, memory relationship types, connections.
- Diff renderer client-side with create/update/noop markers (no drift/delete in v1).

### v2 — after v1 has real users

- `lobu pull` for cloud → files
- `--prune` flag (requires adding `managed_by` marker)
- Drift detection (current vs last-applied state, requires state table)
- Watchers
- Raw `SKILL.md` round-trip (richer cloud-side storage)
- Org-scoped agent IDs (touches RLS, FKs — independent product call)

### v3 — risk-controlled additions

- `lobu secrets push` (separate verb): per-key confirmation, fingerprint-only display, audit per write, org-scoped names, `missing-only` default, explicit `--rotate`
- Bulk memory data with resume tokens, streaming, idempotent re-application
- Dedicated apply API + state table + transactional batch + org lock (only if v1's "re-run to converge" is insufficient in practice)

## v1 work breakdown — 3 parallel PRs

Each PR is a draft branch off `feat/owletto-cli-merge` (PR #459). Subagents work in isolated worktrees. PR-3 (CLI) develops against a stub initially; integration with PR-2's real route happens after that PR merges.

### PR-1 — persist the silently-dropped agent settings fields

**Branch**: `feat/agent-settings-persistence` · **Risk**: Low · **LOC**: ~50

Today `packages/server/src/lobu/stores/postgres-stores.ts` `rowToSettings()`, `saveSettings()`, and `deleteSettings()` do not persist `egressConfig`, `preApprovedTools`, or `guardrails`. The `agents` table doesn't have columns for them either. The file-loader (`packages/server/src/gateway/config/file-loader.ts:432-447, 507-517`) produces all three from `lobu.toml`; cloud silently drops them.

Scope:
- New migration `db/migrations/<timestamp>_agents_apply_fields.sql` adding three columns to `public.agents`:
  ```sql
  ALTER TABLE public.agents
    ADD COLUMN egress_config jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN pre_approved_tools jsonb DEFAULT '[]'::jsonb,
    ADD COLUMN guardrails jsonb DEFAULT '[]'::jsonb;
  ```
- Update `db/schema.sql` to match (this is the dump that mirrors migrations).
- Update `rowToSettings` (3 lines), `saveSettings` (3 lines), `deleteSettings` (3 lines reset).
- Add a round-trip unit test asserting all three fields survive save → load with both populated and empty values.
- Cross-check field shapes against `packages/core/src/lobu-toml-schema.ts` (Zod schemas for `egress`, `tools.pre_approved`, `guardrails`) and the `AgentSettings` interface in `packages/core/src/agent-store.ts:32`. Shapes must match exactly.

Validation:
- `make build-packages` clean
- `bun run typecheck` clean
- `bun run check` (biome) clean
- New unit test passes

### PR-2 — idempotent agent create + stable-id connection upsert

**Branch**: `feat/idempotent-apply-endpoints` · **Risk**: Medium · **LOC**: ~150

Today `agent-routes.ts:POST /` returns 409 on same-org duplicate (`agent-routes.ts:319-321`). Connections create with random ID (`POST /:agentId/platforms`), no upsert.

Scope:
- **Modify `POST /` in agent-routes.ts** (around line 293): same-org duplicate returns `200` with the existing agent payload instead of `409`. Cross-org duplicate keeps the existing 409 (separate concern, will be fixed by future org-scoped IDs work). The Owletto-MCP auto-injection in `saveSettings` (line 339-344) must be preserved on first create but skipped on the idempotent-return path.
- **New route** `PUT /:agentId/platforms/by-stable-id/:stableId` mounted in agent-routes.ts. Uses `buildStablePlatformId(agentId, type, name)` from `gateway/config/file-loader.ts:56` for ID generation client-side; route receives the stable ID in URL. Body shape mirrors `POST /:agentId/platforms`. Behavior:
  - If stable ID exists: update config in place. If config materially changes, return `{ updated: true, willRestart: true }`. If unchanged, return `{ noop: true }`.
  - If stable ID doesn't exist: create with that ID (skip the random-ID path).
  - Reuses existing `ChatInstanceManager.addConnection` / equivalent — does **not** duplicate connection-creation logic.
- Tests:
  - Same agentId POST'd twice in same org → 200 both times, second returns existing data, no duplicate row
  - Same connection PUT'd with identical config twice → second returns `noop: true`
  - Same stable ID PUT'd with changed config → `updated: true, willRestart: true`
  - Cross-org agent collision still returns 409 (regression check)

Validation: `bun test packages/server/src/lobu`, typecheck, biome, build.

### PR-3 — `lobu apply` CLI

**Branch**: `feat/lobu-apply-cli` · **Risk**: Medium · **LOC**: ~400

Scope:
- New `packages/cli/src/commands/apply.ts` (top-level command).
- New `packages/cli/src/commands/_lib/apply/`:
  - `desired-state.ts` — wraps `loadConfig` from `cli/src/config/loader.ts`. Walks `$VAR` refs and produces a `requiredSecrets: string[]` list. Reuses `buildStablePlatformId` (re-export from cli or inline a copy with a comment pointing at the source of truth).
  - `client.ts` — thin wrapper over fetch using `_lib/openclaw-auth.ts` (`getUsableToken`) and `_lib/openclaw-cmd.ts:postJson` from PR #459. One method per resource: `getAgents`, `upsertAgent`, `patchSettings`, `getConnections`, `upsertConnection`, `getEntityTypes`, `upsertEntityType`, etc.
  - `diff.ts` — given desired and current, return `{ creates, updates, noops, drift }`. Drift = remote has resource not in desired. No deletes (no `--prune` in v1).
  - `render.ts` — pretty diff output via chalk: `+` for creates, `~` for updates, `=` for noops, `?` for drift.
  - `prompt.ts` — confirmation prompt; honors `--yes`; non-TTY without `--yes` exits non-zero.
- Wire into `packages/cli/src/index.ts` as `lobu apply` (~20 lines, mirrors how `lobu memory seed` is wired).
- Apply order per agent: `upsertAgent` → `patchSettings` → for each connection `upsertConnection` → for each memory entity type `upsertEntityType` → relationship types.
- Required-secrets check: before any mutation, GET org secret names; for each `$VAR` in desired state, assert presence; on first miss, print all missing then exit 1 with clear message.
- Tests: snapshot tests for diff rendering (no real network); fake client implementing the same interface for unit tests.
- Doc: `packages/landing/src/content/docs/reference/lobu-apply.md` — short reference page mirroring `lobu-memory.md` structure.

Validation: `bun run typecheck`, `bun run check`, `bun test packages/cli`, `make build-packages`.

## Footguns to avoid (from `seed-cmd.ts` review)

Pi flagged these — explicit do-not-copy list for the CLI agent:

1. Substring matching on `"already exists"` for conflict detection. Use HTTP status codes and JSON error codes.
2. Catching all errors with `console.error` and continuing. Apply prints partial results then exits non-zero on the first error.
3. Treating HTTP 200 as success without checking `{ error }` payload. CLI inspects payload.
4. Casting parsed YAML/TOML to `Record<string, unknown>` without validation. Use existing Zod schemas from `packages/core/src/lobu-toml-schema.ts`.
5. Dry-run that says "would create" without showing actual diff. `--dry-run` runs the GET phase + diff render, same output as the prompt-confirm phase.
6. Watcher fallback to "first seeded entity" when ref unresolvable (apply doesn't sync watchers in v1, but the principle: never invent a target).
7. Topological retry loop with bounded iteration count. Apply uses an explicit dependency order: agents → settings → connections → entity types → relationship types. Fail fast if dependencies are unresolvable.

## Testing strategy

### Per-PR

- PR-1: unit round-trip tests; migration applies cleanly to a fresh DB
- PR-2: handler-level tests against an in-memory store or test DB (whichever the surrounding tests use); covers idempotency, cross-org collision, restart-on-config-change
- PR-3: snapshot tests for diff rendering with a stub client

### End-to-end (this plan's exit criterion)

**Status: proven via `scripts/e2e-lobu-apply.sh` (see hardening PR).**

The script:
1. Builds packages + CLI.
2. Boots `start-local.ts` against PGlite with `LOBU_LOCAL_BOOTSTRAP=true`. The bootstrap path mints a default user/org (slug `dev`)/PAT and saves the token to `${OWLETTO_DATA_DIR}/bootstrap-pat.txt`.
3. Reads the PAT, configures a CLI context pointing at the local server, and `lobu login --token <PAT>`.
4. Drops a sample project at `/tmp/e2e-project/` with one agent, one telegram connection, one provider, and one entity-type yaml.
5. `lobu apply --dry-run` → asserts `+ agent`, `+ connection`, `+ entity-type` rows.
6. `lobu apply --yes` → asserts "Apply complete".
7. Re-runs `--dry-run` → asserts no `+`/`~` rows (full noop round-trip).
8. Mutates `chatId` in `lobu.toml`, re-runs apply → asserts `~ connection` + "will restart" marker.
9. Curls REST endpoints with the bootstrap PAT to verify rows landed in Postgres.
10. Cleans up the server, data dir, and project dir.

Manual steps from the original plan (DB-first `lobu run`, postgres editing) are obsolete — the bootstrap path is the supported dev loop.

## Cross-cutting concerns

- **Provider credentials**: provider declarations live in `installed_providers` JSONB. Apply pushing them alone doesn't grant the agent the secret. v1 documents that provider keys must be set in cloud secrets first, same as the rest of the secrets story.
- **Runtime cache invalidation**: cloud workers may cache settings. Existing PG NOTIFY infrastructure (`agent_changed_notify` migration on main) handles this; apply just writes through the same paths.
- **Connection restart side effects**: PR-2's PUT response includes `willRestart`. PR-3's diff renderer surfaces this in the plan output ("connection X — will restart") so users aren't surprised by dropped in-flight messages.
- **Redacted values**: when comparing remote settings to desired, never diff `***1234` against the desired plaintext. v1 normalizer treats redacted values from GET as opaque; CLI uses `has_value` boolean only.
- **Cloud-injected MCP server on agent create**: `agent-routes.ts:339-344` auto-injects an Owletto MCP server. PR-2 must preserve this on first create but skip it on the idempotent-existing-agent return so we don't reset it on every apply.

## Stacking & ordering

```
                  feat/owletto-cli-merge (#459)
                            │
                            ▼
                  feat/lobu-apply-plan
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
         PR-1            PR-2             PR-3
         (small,         (medium)         (CLI, depends on 2 for
         independent)                       integration but develops
                                            against stub)
            │               │               │
            └───────────────┼───────────────┘
                            ▼
                   End-to-end test
                   (this session)
```

PR-1 and PR-2 are independent and can land in any order. PR-3's tests run against a stub; full integration test happens after all three merge.

## Non-goals (for the avoidance of doubt)

- ❌ New `applied_state` table
- ❌ Dedicated apply API endpoints
- ❌ Server-side multipart file upload
- ❌ Transactional batch
- ❌ Org lock against concurrent applies
- ❌ `--prune` (v2)
- ❌ `--force` (v2)
- ❌ `lobu pull` (v2)
- ❌ Watcher sync (v2)
- ❌ Raw `SKILL.md` round-trip (v2)
- ❌ Org-scoped agent IDs / RLS rework (v2, separate product call)
- ❌ Secret value upload (v3)
- ❌ Memory data sync (v3)

If any of these turn out to be hard requirements during real-world use, they get their own plan and PR; v1 ships small.
