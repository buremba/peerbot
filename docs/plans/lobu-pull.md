# `lobu pull` — Plan

Status: **planning** · Owner: @buremba · Stacks on `feat/owletto-cli-merge` · Builds on `lobu-apply.md` (v1 already merged)

## Goal

Provide a one-way Lobu Cloud org → `lobu.toml` converger. Mental model: `terraform import` lite — read live cloud state, write/update the project's `lobu.toml`, agent dirs, and `agents/<id>/skills/*/SKILL.md` so the local files match. Re-running converges. Use cases:

1. **Drift recovery** — someone edited the org via web UI, bring local files back in sync.
2. **Bootstrap** — clone a project that exists only as a cloud org into a fresh dir.
3. **Cross-org migration** — `lobu pull --org src` then `lobu apply --org dst`.

**Reuse-first**: every GET endpoint pull needs already exists (apply v1 calls them: `listAgents`, `listConnections`, `listEntityTypes`, `listRelationshipTypes`). The only new code is a writer that inverts what `init.ts:generateLobuToml` does — produce TOML from a state object instead of from wizard answers. Total v2.0: 1 PR, ~500 LOC.

## Mental model

```
   live cloud state (org)
        │
        ▼
   CLI: GET /api/:orgSlug/agents/                    (existing)
        GET /:agentId/connections                    (existing)
        GET /api/:orgSlug/manage_entity_schema       (existing)
        GET /api/:orgSlug/manage_relationship_schema (existing)
        │
        ▼
   CLI: build desired-on-disk state
        (RemoteAgent[] + RemoteConnection[] + entity/relationship types)
        │
        ▼
   CLI: load local files (if any) via cli/config/loader.ts
        │
        ▼
   CLI: render diff (file creates / file overwrites / noops)
        │   refuses if any overwrite without --force
        │
        ▼
   CLI: confirm, then write:
        │   lobu.toml                                  (merge or create)
        │   agents/<id>/IDENTITY.md, SOUL.md, USER.md  (from agent.dir contents)
        │   agents/<id>/skills/<name>/SKILL.md         (from cloud skill bodies)
        │   models/                                     (memory schema, if pulled)
        │
        ▼
   apply → pull → apply on a clean tree is a noop
```

## Background — what already exists

- **GETs**: `packages/cli/src/commands/_lib/apply/client.ts:230,285,318,359` — `listAgents`, `listConnections(agentId)`, `listEntityTypes`, `listRelationshipTypes`. No new server endpoints needed for v2.0.
- **Loader**: `packages/cli/src/config/loader.ts:loadConfig` parses local `lobu.toml` + walks agent dirs. Pull reuses this to detect what's already on disk.
- **Stable connection IDs**: `packages/server/src/gateway/config/file-loader.ts:56:buildStableConnectionId(agentId, type, name)` — deterministic. As long as pull writes `[type, name]` pairs, applying again re-derives the same stable IDs.
- **TOML writer**: `packages/cli/src/commands/init.ts:492:generateLobuToml` is the closest precedent — string-concatenation TOML emitter. v2.0 ships a more general version of the same function in `_lib/pull/render-toml.ts`.
- **Frontmatter parser**: `packages/server/src/gateway/config/file-loader.ts:657` parses `SKILL.md` into `{ frontmatter, body }`. Pull inverts it: serialize frontmatter back, write body, append.
- **Schemas**: `packages/core/src/lobu-toml-schema.ts` Zod schemas validate the TOML pull writes — running validate on the output before commit is the v2.0 self-check.

## Locked decisions

1. **Verb is `lobu pull`.** One-way, cloud → files. Mirrors `terraform import` more than `apply`. No bidirectional `sync`.
2. **Default is non-destructive.** If any local file would be overwritten and its content differs from what pull would write, pull lists the conflicting paths and exits non-zero. `--force` overrides. Rationale: a user with hand-edited prompt files who runs `lobu pull` to grab one new connection should not silently lose their edits. The diff/refuse step is the safety net (the inline-confirm pattern from the web design guidelines, applied to CLI).
3. **Pull-all-by-default with `--exclude`, plus `--include` for surgical use.** Default pulls agents + connections + memory schema. `--exclude=connections` skips one resource type. `--include=agents` restricts to one. Rationale: drift recovery is the dominant use case and "missed a resource" is the worst failure mode. `--include` is the escape hatch for the surgical case ("just sync the new entity type"). Mirrors `--only` from `lobu apply`.
4. **Skill bodies**:
   - If cloud has a raw `skills_config[].body` (v2.1+ — see phasing), write `agents/<id>/skills/<name>/SKILL.md` with the frontmatter serialized + body appended.
   - If cloud has only normalized `skills_config` (v2.0 reality, since apply v1 throws away the raw body), pull writes a synthesized `SKILL.md` with frontmatter only and a body comment: `<!-- pulled from cloud; raw body not stored server-side. Edit and re-apply to push. -->`. Document this loss explicitly in the doc page.
   - Conflict: if local `SKILL.md` already exists and frontmatter differs from cloud, treat as overwrite — refuse without `--force`.
5. **Connections**: TOML rows are `[[agents.<id>.connections]]` with `type` + `name` + nested `config` table. The `[type, name]` pair re-derives the same stable ID via `buildStableConnectionId`, so apply→pull→apply round-trips without ID churn. If cloud has a connection whose `name` is missing or non-deterministic, pull synthesizes `name = "<type>-<short-hash-of-stable-id>"` and emits a TODO comment.
6. **Secrets** — write `$VAR` references, never literal values:
   - Cloud stores `lobu_secret_<uuid>` placeholders in agent settings (`secret-proxy` swaps them at egress).
   - Pull walks each settings/connection/provider field. For known secret-key conventions (`*Token`, `*Key`, `apiKey`, `signingSecret`, `clientSecret`, `botToken`, `webhookSecret`), if the cloud value is a `lobu_secret_<uuid>` placeholder, pull writes `$<UPPER_SNAKE_CASE_OF_KEY>` (e.g. `botToken` → `$BOT_TOKEN`). Same convention as `init.ts` already uses.
   - For unrecognized fields holding a placeholder, pull writes `$LOBU_SECRET_<short-uuid-prefix>` with a comment `# TODO: rename in your .env`.
   - Pull **never** writes literal secret values to disk, even with `--force`. This is a hard guarantee. Cloud doesn't expose them in GET payloads anyway (they're redacted to `***1234`); pull treats redacted values as `$VAR`-referencing.
7. **Drift handling** — pull *is* the cure for drift, no special treatment. The `--dry-run` output names every file that would change, which doubles as a drift report.
8. **Default flow**: GET cloud state → diff against on-disk → list create/overwrite/noop → prompt to confirm → write. `--dry-run` shows the same output and exits without writing. `--yes` skips prompt for CI use. `--force` allows overwrite of conflicting files.

## v2.0 vs v2.1+ phasing

### v2.0 (this plan)

- `lobu pull [--dry-run] [--yes] [--force] [--include agents|connections|memory] [--exclude ...] [--org <slug>] [--init <dir>]`
- Resources pulled: agents (metadata + settings + the 3 fields PR-1 of apply added: `egressConfig`, `preApprovedTools`, `guardrails`), provider declarations, connections (with stable-ID reverse derivation via `[type, name]`), local skills (frontmatter only — see #4 above), memory entity types, memory relationship types.
- TOML writer in `_lib/pull/render-toml.ts`. Produces TOML that round-trips through `loadConfig` → `lobu apply` to a noop on a clean cloud.
- `--init <dir>` flag: scaffold a fresh project tree (matches `lobu init`'s output minus the wizard) before pulling. If `<dir>` exists and is non-empty, exit; user must `--force` or pick a fresh path.
- File-conflict refusal: pull computes a planned set of `(path, content)` writes; for each path that exists on disk with non-matching content, emit a "would overwrite" line and exit non-zero unless `--force`.
- Doc page: `packages/landing/src/content/docs/reference/lobu-pull.md`.

### v2.1 — round-trip parity guarantees

- **Cloud-side raw `SKILL.md` storage** so pull can write the *exact* body the operator wrote (and apply can preserve it). Requires a server change — separate PR. Until then v2.0 emits the placeholder body described in decision #4.
- **Watcher pull** — depends on apply v2 watcher push. Same reasoning as apply.
- **Memory-data pull** (entities, relationships, knowledge events) — depends on apply v3.
- **`installedAt` and other volatile fields** — pull omits them in v2.0 (see decision #6 of cross-cutting concerns); v2.1 adds a `--preserve-timestamps` flag if anyone asks.

### v2.2+

- Two-way diff UI (3-way merge with last-applied state) — only if v2.0's "refuse without --force" UX is insufficient in practice.
- Multi-org pull (one CLI invocation, multiple orgs into separate dirs) — wrapper script for now.

## v2.0 work breakdown — 1 PR

### PR — `lobu pull` CLI

**Branch**: `feat/lobu-pull-cli` · **Risk**: Medium · **LOC**: ~500

Scope:

- `packages/cli/src/commands/pull.ts` — top-level command, mirrors `apply.ts` shape.
- `packages/cli/src/commands/_lib/pull/`:
  - `cloud-state.ts` — calls `client.listAgents`, `listConnections(agentId)`, `listEntityTypes`, `listRelationshipTypes`. Reuses `apply/client.ts` directly; no new HTTP code.
  - `local-state.ts` — calls `loadConfig` from `cli/src/config/loader.ts`. Returns `{ exists: boolean, config?: LobuConfig, agentDirs: Map<id, string[]> }`.
  - `render-toml.ts` — generalized version of `init.ts:generateLobuToml`. Takes the cloud-state object, emits TOML string. Pure function, snapshot-testable. Handles all four agent-scoped tables: `[agents.<id>]`, `[[agents.<id>.providers]]`, `[[agents.<id>.connections]]`, `[agents.<id>.connections.config]`, plus `[agents.<id>.tools]` (`pre_approved`), `[agents.<id>.egress]`, and `guardrails` array.
  - `render-skill.ts` — emits `agents/<id>/skills/<name>/SKILL.md`. Serializes frontmatter back to YAML (use `yaml` package, already a transitive dep) + appends body.
  - `plan.ts` — given cloud state + local state, return `{ creates: WriteOp[], overwrites: WriteOp[], noops: WriteOp[] }` where `WriteOp = { path, content }`. Conflict = path exists with different content. Idempotent re-pull → all noops.
  - `write.ts` — applies the plan to disk. Refuses when `overwrites.length > 0 && !force`. Atomic-write per file (write to `.tmp`, rename) so a crash mid-pull doesn't leave half-written TOML.
  - `prompt.ts` — confirmation prompt; honors `--yes`; non-TTY without `--yes` exits non-zero. Mirrors apply's prompt.
  - `__tests__/render-toml.test.ts` — snapshot tests with fixture cloud states. Critical for round-trip parity.
  - `__tests__/plan.test.ts` — unit tests for the create/overwrite/noop classifier.
- Wire into `packages/cli/src/index.ts` as `lobu pull` (~20 lines, mirrors `lobu apply`).
- Validate the emitted TOML against `packages/core/src/lobu-toml-schema.ts` Zod schemas before writing — catches writer bugs at PR time.
- Doc page: `packages/landing/src/content/docs/reference/lobu-pull.md` — short reference page mirroring `lobu-apply.md`.

Validation:

- `bun run typecheck`
- `bun run check` (biome)
- `bun test packages/cli`
- `make build-packages`
- E2E (see Testing section)

## Specific design questions — answered

### Apply ↔ pull relationship

`apply` and `pull` are **not pure inverses** in v2.0; the round-trip is **near-clean** with documented mismatches:

- `apply → pull → apply` on a clean cloud is a noop (v2.0 acceptance criterion).
- `pull → apply → pull` is a noop **only if** the source-of-truth is cloud and the local tree is fresh (`--init` mode). If the user pulled into an existing tree with hand-edits to `IDENTITY.md` etc., the second pull would want to overwrite those — by design, since cloud is now the truth.
- Mismatches that v2.0 accepts:
  - Skill bodies: cloud doesn't store the raw body → pull writes a placeholder body. Fixed in v2.1.
  - Comments: TOML comments authored by hand are lost on round-trip. Acceptable; the writer emits its own structural comments.
  - Field ordering inside tables: pull emits a deterministic order; user-authored ordering is lost. Acceptable.

### Volatile fields (timestamps, installedAt, etc.)

Pull **omits** volatile fields. Specifically:

- `installedAt: Date.now()` (`file-loader.ts:231`) — omitted. The loader supplies it on next apply load.
- Any `createdAt` / `updatedAt` on agents, connections, entity types — omitted. They are server-managed and have no representation in `lobu.toml` already; nothing to do.
- `id` on a connection — derived from `[type, name]` via `buildStableConnectionId`, so pull writes `type` and `name` only; the explicit `id` field is never emitted.

> [decision needed: any other field with churn that I'm missing? Cross-check during PR review against the file-loader's normalization output.]

### `[memory.owletto]` block

Pull infers and writes a `[memory.owletto]` block with `org = "<orgSlug>"` and `mcp_url = "<mcpUrl>"` derived from the CLI's current auth context (the same `mcpUrl` the GETs are running against). This is a **new** thing pull does that apply does not — apply doesn't *write* it because file-loader synthesizes it from the token at runtime. Pull writes it explicitly because the goal is "filesystem matches cloud", and the org binding is part of that match. If the user later moves the project to a different org, they edit this block — same as today.

### No-local-project case

`lobu pull --init <dir>` scaffolds a fresh tree (creates `<dir>/lobu.toml`, `<dir>/agents/`, etc.) and then pulls into it. Equivalent to `lobu init --bare && lobu pull` but in one command. Without `--init`, pull requires a pre-existing `lobu.toml` (or at least the working dir to be empty) — refuses to pull into a populated dir that lacks a `lobu.toml`, since that's almost certainly user error.

### `--dry-run`

Same flag name as apply. Runs the full GET phase + plan, prints the would-write file list (creates green, overwrites yellow, noops gray), then exits 0. No prompts. CI-friendly.

## Footguns to avoid

Carrying forward the relevant ones from `lobu-apply.md`, plus pull-specific:

1. **Substring-matching error messages** — use HTTP status codes and JSON error codes from the GET responses. (Same as apply.)
2. **Catching all errors and continuing** — any GET failure aborts the whole pull. Partial pulls produce inconsistent local state.
3. **Casting parsed responses to `Record<string, unknown>`** — validate cloud responses against `RemoteAgent` / `RemoteConnection` / etc. types from `apply/client.ts`. Reuse the same types.
4. **Silently overwriting local edits** — *the* pull-specific footgun. The "list overwrites and refuse without `--force`" rule exists to prevent this. If you find yourself adding a fast path that skips the conflict check, stop.
5. **Writing literal secret values to disk** — never. Even with `--force`. Even if the cloud were to expose them (it won't). Pull's secret writer always emits `$VAR` references.
6. **Multiple connections of same type without distinct names** — TOML allows multiple `[[agents.<id>.connections]]` of the same type, but the stable-ID derivation requires distinct `name`. If cloud has two telegram connections named identically (shouldn't happen, but), pull emits a TODO comment and a hash suffix on the second name.
7. **Race between pull and apply on the same org** — pull reads, apply writes. If someone runs `lobu apply` mid-pull, pull's GETs may see a half-applied state. Document this in the doc page; pull is not transactional. Workaround: don't run them concurrently against the same org. (Same as apply's concurrent-apply note.)
8. **Atomic writes** — write to `.tmp` and rename, per file. A SIGINT mid-pull leaves either the old file or the new file, never a half-written one.
9. **Skill body loss without warning** — print a warning at end of pull listing every skill where the body was synthesized rather than pulled, so users know v2.0 has the documented limitation.
10. **`lobu_secret_<uuid>` shape coupling** — don't hard-code the prefix in three places; pull's secret detector and apply's secret writer should share the same regex from `packages/core` (or wherever `secret-proxy`'s placeholder format lives).

## Testing strategy

### Unit (this PR)

- `render-toml.test.ts` — snapshot tests with 6+ fixture cloud states: empty, single agent, multi-agent, agents with all 3 newly-persisted fields populated, connections with secrets, memory schema with relationships.
- `plan.test.ts` — classifier tests: identical content = noop, different content = overwrite, missing = create, schema mismatch = error.
- `render-skill.test.ts` — frontmatter round-trip: parse → render → re-parse must equal original.
- Fake `client.ts` reused from apply's tests; no real network in unit tests.

### End-to-end (this plan's exit criterion)

After the PR merges, run against a real local cloud (DB-first `lobu run` per apply's E2E setup):

1. `lobu apply` from a known-good `lobu.toml` (created in apply's E2E #6).
2. `rm -rf` the local project.
3. `lobu pull --init pulled-project/ --org <slug>` — verify directory tree created.
4. `cd pulled-project && lobu apply --dry-run` — verify all noops.
5. Edit a connection in the web UI (drift simulation).
6. `lobu pull --dry-run` from the original project dir — verify exactly that connection shows as overwrite.
7. `lobu pull --force` — verify overwrite happens, file content matches cloud.
8. `lobu apply --dry-run` — verify all noops again.
9. Edit `agents/<id>/IDENTITY.md` locally without applying.
10. `lobu pull` (no `--force`) — verify it refuses, names IDENTITY.md as conflicting.
11. `lobu pull --force` — verify the local edit is overwritten with cloud's version.
12. With a known-untouched local tree, run `lobu pull` followed by `git diff` — diff should be empty (idempotency).

If any step fails, the PR is not ready.

## Cross-cutting concerns

- **Auth**: pull uses `_lib/openclaw-auth.ts:getUsableToken` and `deriveApiBaseUrl(mcpUrl)` from `_lib/openclaw-cmd.ts` — same path as apply. No new auth.
- **Org selection**: `--org <slug>` flag matches apply's. Without it, pull uses the default-org from `~/.lobu/config.toml` (or whatever the CLI's existing default-org logic is — verify against `apply.ts` at PR time).
- **Redacted values from GET**: cloud GET responses redact secrets (`***1234`). Pull's secret detector treats any `***`-prefixed value or any `lobu_secret_<uuid>`-shaped value as "this is a secret reference" → emit `$VAR`. Never the literal redacted string.
- **TOML schema validation before write**: pull runs the emitted TOML through `lobu-toml-schema.ts` Zod parse before writing. Validation failure = pull bug; abort with clear error. This catches writer drift early.
- **`agent.dir` files (IDENTITY.md, SOUL.md, USER.md)**: cloud doesn't store these as separate fields today (they're folded into the agent's `instructions`/prompt during ingest by file-loader). v2.0 pull writes a single `agents/<id>/IDENTITY.md` containing the full prompt and leaves SOUL/USER as stubs.
  > [decision needed: confirm with @buremba — is the cloud agent record carrying the un-merged IDENTITY/SOUL/USER split, or only the merged prompt? If only merged, document the loss in the doc page; v2.1 adds the split.]

## Stacking & ordering

```
   feat/owletto-cli-merge (#459)
            │
            ▼
   lobu-apply v1 PRs (already merged)
            │
            ▼
   docs/lobu-pull-plan  (this doc)
            │
            ▼
   feat/lobu-pull-cli (single PR, ~500 LOC)
            │
            ▼
   E2E test (this session)
```

Pull v2.0 has **no server-side dependency** — every endpoint already exists. It can ship independent of any apply v2 work.

## Non-goals (for the avoidance of doubt)

- ❌ Bidirectional sync (pull is one-way; sync requires last-applied state, which we explicitly do not have)
- ❌ Conflict-merge UI (3-way merge of cloud / local / last-applied)
- ❌ Partial-pull-with-edit-detection (file-level smart merge — out)
- ❌ Pulling secret values to disk (security boundary — never)
- ❌ Watcher pull (v2.1, depends on apply v2)
- ❌ Memory-data pull — entities, relationships, knowledge events (v3)
- ❌ Raw `SKILL.md` body round-trip (v2.1, requires server change)
- ❌ Multi-org pull in a single invocation (wrapper script for now)
- ❌ Restoring `installedAt` and other server-managed timestamps (deliberate omission)
- ❌ `--preserve-comments` for hand-authored TOML comments (out — TOML round-trip-with-comments is a Pandora's box)

If any of these turn out to be hard requirements during real-world use, they get their own plan and PR; v2.0 ships small.
