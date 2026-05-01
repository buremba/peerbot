# `lobu secrets push` — Plan

Status: **planning** · Owner: @buremba · v3 follow-up to `lobu apply` (see `docs/plans/lobu-apply.md` §"Locked decisions" #7)

## Goal

Push named secret **values** from a CLI-side source (`.env`, file, or stdin) into Lobu Cloud's per-org secret-proxy. The CLI never displays values, the server never returns them, and every write is audited. `lobu apply` continues to read `$VAR` references from `lobu.toml`, verifies the names exist in cloud, and **never uploads values**. `secrets push` is the only sanctioned write path for cloud secret values.

**Reuse-first**: `WritableSecretStore` (`packages/server/src/gateway/secrets/index.ts`) already has `put/list/delete` and is wired through `SecretStoreRegistry` to the Postgres-backed `agent_secrets` table. The proxy already swaps `lobu_secret_<uuid>` placeholders at egress. The gap is one HTTP surface — `POST /api/:orgSlug/secrets/manage` — plus org-scoping for `agent_secrets`, plus a dedicated audit table. Total v3.0: 2 PRs, ~700 LOC.

## Mental model

```
local source                    CLI                       Lobu Cloud
─────────────                   ───                       ──────────
.env (cwd)        ─┐
file (--from-file) ├──► read ──► resolve names ──► fingerprint ──► render diff (names + fp only)
stdin (--from-stdin) ┘                                                         │
                                                                               ▼
                                                                  prompt per-key (unless --yes)
                                                                               │
                                                                               ▼
                                                       POST /api/:orgSlug/secrets/manage
                                                       Authorization: Bearer <token>
                                                       { actions: [{op:create|rotate, name, value}, …] }
                                                                               │
                                                                               ▼
                                                       SecretStoreRegistry.put(orgScopedName, value)
                                                                               │
                                                                               ▼
                                                       agent_secrets row (encrypted ciphertext)
                                                                               │
                                                                               ▼
                                                       INSERT INTO secret_audit (...)
                                                                               │
                                                                               ▼
                                                       response: { results: [{name, fp, action, ref}, …] }
                                                       (NEVER returns values)

later, at runtime:
  worker env → lobu_secret_<uuid> placeholder
  worker http call → 127.0.0.1:8118 secret-proxy → resolves placeholder via SecretStore → upstream
```

## Background — what already exists

- **`WritableSecretStore` interface** (`packages/server/src/gateway/secrets/index.ts:32-40`): `put(name, value, opts) → SecretRef`, `delete(nameOrRef)`, `list(prefix?)`. Default backend is `PostgresSecretStore` (`packages/server/src/lobu/stores/postgres-secret-store.ts`), which AES-256-GCM-encrypts via `@lobu/core`'s `encrypt()` and returns `secret://<encoded-name>` refs.
- **`agent_secrets` table** (`db/migrations/20260410120000_add_agent_secrets.sql`): `name text PRIMARY KEY`, `ciphertext text`, `expires_at`, timestamps. **No `org_id` column today** — names are namespaced by path-style prefixes (`connections/<id>/<field>`, `system/<key>`, etc.) chosen by callers. PR-1 must add `org_id`.
- **Placeholder swap**: `secret-proxy.ts` (line 11, 194) intercepts `lobu_secret_<uuid>` tokens in worker requests and resolves them to the underlying `SecretRef` value at egress. Workers never see real values; the cache is per-pod. See `AGENTS.md` §"Orchestration".
- **`secret://` refs**: `packages/core/src/secret-refs.ts` parses `<scheme>://<path>#<fragment>` URIs. `secret://` is the default writable scheme; `aws-sm://` is read-only. Anything stored via `secrets push` becomes `secret://<orgSlug>/user/<name>` (see Locked Decisions #6).
- **Auth**: `mcpAuth` middleware (`packages/server/src/auth/middleware.ts`, mounted in `src/index.ts:660+`) validates the bearer token, attaches `c.var.userId` and the resolved `orgSlug`. Org member roles are computed in `auth/oauth/scopes.ts` (`owner | admin | member`). Reuse both — no new auth surface.
- **CLI today** (`packages/cli/src/commands/secrets.ts`): `secrets set/list/delete` operate **only on local `.env`**. The header comment promises "Cloud secrets will use the API when available." This plan delivers that API.
- **CLI auth helpers**: `_lib/openclaw-auth.ts:getUsableToken` and `_lib/openclaw-cmd.ts:postJson` + `deriveApiBaseUrl` (introduced in PR #459). Reuse, don't duplicate.

What's **not** there: no `org_id` on `agent_secrets`, no audit log for secret writes, no HTTP route, no per-key confirm UX, no fingerprint helper.

## Locked decisions

1. **Verb is `lobu secrets push`.** Separate from `lobu apply`. Apply NEVER pushes values — it only reads `$VAR` refs and asserts the names exist. The two verbs share zero write paths so a misbehaving apply can never leak a value.
2. **Display**: the CLI never prints secret values. Plan output shows `<key>  <fingerprint>  (set | missing | rotated | unchanged)`. Fingerprint = first 4 hex chars of SHA-256(value). Rationale for 4 chars: enough for a human to visually diff `<key>: a3f1 → 9b22` and notice the change, too few for any meaningful brute-force or correlation across orgs. Full hash leaks more information than the visual-diff use case requires.
3. **Per-key confirmation by default.** For each rotate/create the CLI prints `<key>  <action>  <fp>` (or `<old-fp> → <new-fp>` for rotate) and waits for a single keystroke (`y/n/a/q`: yes / no / yes-to-all / quit). `--yes` skips the prompt entirely (CI). `--yes-rotate` is required separately to confirm overwriting existing values; `--yes` alone covers create-only flows.
4. **Default = missing-only.** If a key already exists in the cloud, leave it alone. Pass `--rotate` to overwrite all matched keys, or `--rotate <key>` (repeatable) to rotate only specific keys. `secrets push` without `--rotate` and with no missing keys exits 0 with `nothing to do`.
5. **Source priority**: explicit `--from-file <path>` > `--from-env` (default) > `--from-stdin`. Exactly one of these may be set. `--from-env` reads `.env` in cwd and warns (non-fatal) if `.env` is not in `.gitignore` of the same dir. `--from-stdin` parses `KEY=value` lines from stdin and is the recommended path for piping `vault read` / `1password read` / `gh secret list --json` output.
6. **Org-scoped names.** Secrets are per-org. PR-1 adds `org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE` and a `(org_id, name)` UNIQUE constraint to `agent_secrets`, dropping the `name`-only PK. The on-the-wire `secret://` ref for user-pushed secrets is `secret://<orgSlug>/user/<name>` to keep namespace separation from system-managed secrets (`connections/...`, `system/...`).
7. **Rotation atomicity.** Rotating a value is a single `UPDATE agent_secrets SET ciphertext = $new, updated_at = now() WHERE org_id = $1 AND name = $2` inside one transaction with the audit insert. The `lobu_secret_<uuid>` placeholder ID lives in the per-pod proxy cache and is regenerated lazily next time a worker requests env injection — workers reading the placeholder mid-rotation either see the old cached value (until cache TTL, default 60s in `SecretStoreRegistry`) or transparently see the new one. **No worker re-deploy is required.** The proxy cache is invalidated on `put` (`secrets/index.ts:223`).
8. **Missing source = loud failure.** If the user passes `--rotate FOO BAR` but the source has only `FOO`, the CLI fails before any write, listing `BAR` as missing. No partial pushes. Same for create when the source omits a key the user explicitly named.
9. **`--dry-run`** runs the GET phase and renders the diff (names + fingerprints + would-create / would-rotate / unchanged). Never hits the write API. Same output as the prompt-confirm phase.
10. **Permission tier**: org `owner` or `admin` only. `member` gets `403`. Reuses the same role lookup as `mcp:admin` scope filtering (`auth/oauth/scopes.ts:37-38`). Documented in the route handler and surfaced as a clear error message in the CLI (`secrets push requires org admin or owner role`).
11. **Audit log**: dedicated `public.secret_audit` table (precedent: `entity_type_audit`). Schema: `id`, `org_id`, `name`, `fingerprint` (4-hex chars), `action` (`create | rotate | delete`), `source` (`env | file | stdin`), `actor_user_id`, `created_at`. **Never `before_value` or `after_value` columns** — the precedent's `before_payload`/`after_payload` shape is explicitly *not* copied here. Reuse the events table is rejected: `events` is the memory-knowledge log and shouldn't be polluted with infra-audit rows.
12. **No `--value <plaintext>` CLI arg, ever.** Shell history is a leak vector. The only sources are `--from-env`, `--from-file`, and `--from-stdin`.

## Phasing

### v3.0 (this plan)

CLI-visible:
- `lobu secrets push [--from-env | --from-file <path> | --from-stdin] [--rotate [<key>...]] [--yes] [--yes-rotate] [--dry-run] [--org <slug>]`
- `lobu secrets list` — names + fingerprints + `updated_at` + audit-source. **No values.** Lists cloud, not `.env`.
- The existing `lobu secrets set/list/delete` (`.env` editor) is renamed to `lobu secrets local set/list/delete` to free `lobu secrets list` for cloud and remove the misleading "stored in local .env for dev" copy from the top-level help. (No backwards-compat alias — global rule.)
- Diff renderer reuses `apply`'s render conventions (`+` create, `~` rotate, `=` unchanged).

### v3.1+

- KMS-wrapped at-rest encryption review (today: `@lobu/core` `encrypt()` uses a master key from env; v3.1 may move to KMS-backed envelope encryption).
- Per-key rotation policies (max-age warnings).
- Secret expiry surfaced via `expires_at` (column already exists, currently unused at the user-facing level).
- Vault / 1Password integrations (the v3.0 stdin path is already this, but a first-class `--from-vault <path>` may be cleaner).
- `lobu secrets read <key>` — gated heavily, per-call audit, requires owner role + recent re-auth. Currently a non-goal.

## Work breakdown — 2 PRs

### PR-1 — server: org-scope `agent_secrets`, audit table, manage route

**Branch**: `feat/secrets-manage-route` · **Risk**: Medium · **LOC**: ~300

Scope:
- Migration `db/migrations/<ts>_secrets_org_scope_and_audit.sql`:
  - Add `org_id uuid` column to `agent_secrets` with a temporary `NULL`-tolerant rollout: backfill existing rows by parsing prefixes (`connections/<connId>/...` → look up agent's org). Migrations land while the table is empty in cloud, so backfill is a sanity check rather than a real concern.
  - Drop `name`-only PK, add `(org_id, name)` UNIQUE.
  - Re-create `agent_secrets_name_prefix_idx` as `(org_id, name text_pattern_ops)`.
  - New table `public.secret_audit` (mirrors `entity_type_audit` shape but **without** `before_payload`/`after_payload`). Columns: `id bigserial PK`, `org_id uuid NOT NULL`, `name text NOT NULL`, `fingerprint text NOT NULL CHECK (length(fingerprint) = 4)`, `action text CHECK (action IN ('create','rotate','delete'))`, `source text CHECK (source IN ('env','file','stdin','api','system'))`, `actor_user_id uuid`, `created_at timestamptz DEFAULT now()`. Index on `(org_id, name, created_at DESC)`.
  - Update `db/schema.sql` to match.
- `PostgresSecretStore` updates (`packages/server/src/lobu/stores/postgres-secret-store.ts`):
  - Constructor accepts an `orgId: string` (or factory takes one). Every query gets `WHERE org_id = $1` added. The cross-cutting wiring is small because `SecretStoreRegistry` is constructed per-request in cloud paths that already know the org.
  - `put` writes `(org_id, name, ciphertext)` with `ON CONFLICT (org_id, name) DO UPDATE`.
- New route mounted at `app.route('/api/:orgSlug/secrets', secretRoutes)` from a new `packages/server/src/lobu/secret-routes.ts`. Endpoints:
  - `POST /api/:orgSlug/secrets/manage` — body: `{ actions: Array<{op: 'create' | 'rotate' | 'delete', name: string, value?: string, source: 'env' | 'file' | 'stdin'}> }`. Server-side flow: `mcpAuth` → require role in `(owner, admin)` → for each action, transactionally `put`/`delete` + insert `secret_audit` row → respond with `{ results: Array<{name, fingerprint, action, ref, willRestart?: false}> }`. **Never echoes `value`.**
  - `GET /api/:orgSlug/secrets` — returns `[{ name, fingerprint, updatedAt, source }]`. Fingerprints come from re-decrypting + hashing on read (cheap with the existing 60s `SecretStoreRegistry` cache); alternative is to store `fingerprint` on write in `agent_secrets`. Pick the latter — write-time fingerprint, no decrypt needed for list. Add `fingerprint text` column to `agent_secrets` in the same migration.
- Server-side fingerprint helper: `packages/core/src/secret-fingerprint.ts` — `function fingerprint(value: string): string` returning the first 4 hex chars of `crypto.createHash('sha256').update(value).digest('hex')`. Used by both server (for `secret_audit.fingerprint`) and CLI (for diff display).
- Tests:
  - Round-trip: push key with `op: create` → list returns name + fingerprint, never the value.
  - Rotate: same name with `op: rotate` updates ciphertext, leaves `secret://...` ref unchanged, inserts second `secret_audit` row.
  - Member role gets `403` on `/manage`.
  - Cross-org isolation: same name in two orgs are independent rows; `list` for org A never returns org B's name.
  - Server log assertion: no log line at any level contains `body.actions[].value`. (Use a custom logger spy that fails the test if a value substring appears.)
  - Empty-string value rejected with `400 invalid_value`.
  - Value starting with `lobu_secret_` rejected with `400 already_a_placeholder` (caller is confused).

Validation: `bun test packages/server/src/lobu`, `make build-packages`, `bun run typecheck`, `bun run check`.

### PR-2 — CLI: `lobu secrets push` + `lobu secrets list`

**Branch**: `feat/lobu-secrets-push-cli` · **Risk**: Medium · **LOC**: ~400

Scope:
- New `packages/cli/src/commands/secrets-push.ts` (top-level command implementation).
- New `packages/cli/src/commands/_lib/secrets/`:
  - `source.ts` — three readers: `readFromEnv(cwd)`, `readFromFile(path)`, `readFromStdin()`. Each returns `Map<string, string>`. The `.env` reader warns if `.env` isn't in `.gitignore` of cwd. None of them log values; on parse error they print `failed to parse <path> at line N` without including the line content. Stdin reader fails clean if stdin is a TTY and `--from-stdin` was set.
  - `client.ts` — thin wrapper over `postJson` from `_lib/openclaw-cmd.ts`. Methods: `listSecrets(orgSlug)`, `manageSecrets(orgSlug, actions)`. Wraps every error so the error message can never include the request body. Re-throws with a sanitized message.
  - `diff.ts` — given desired (local map) and current (cloud names + fingerprints), produces `{ creates, rotates, unchanged, missingFromSource }`. Honors `--rotate` and `--rotate <key>...` selectors.
  - `prompt.ts` — per-key confirm with `y/n/a/q`. `--yes` short-circuits to yes-to-all; `--yes-rotate` is required to flip rotates from no-to-all to confirm-individually (or yes-to-all if also `--yes`). Non-TTY without `--yes` exits non-zero with a clear message.
  - `render.ts` — diff output. Format: `~ FOO  a3f1 → 9b22  (rotate, source=env)`. Never values, even for unchanged keys (which only show fingerprint to confirm cloud and source agree — handy for "did my .env drift from cloud?" sanity checks; note this means we send the fingerprint of every desired key, not the value).
  - `fingerprint.ts` — re-export `fingerprint` from `@lobu/core` (added in PR-1).
  - `redact.ts` — wraps the global `process.on('uncaughtException')` and Sentry breadcrumb scrubber for the duration of the push command. Strips any string matching `/^[A-Za-z0-9_]{16,}$/` from error stacks before logging. Belt-and-braces in case a value sneaks into a thrown error.
- Wire into `packages/cli/src/index.ts`:
  - Move existing `secrets set/list/delete` under `lobu secrets local <set|list|delete>` (rename, no alias).
  - Add `lobu secrets push` and `lobu secrets list` (cloud) at the top level.
- Tests:
  - Snapshot tests for `render.ts` with mixed create/rotate/unchanged/missing scenarios.
  - `source.ts` parser round-trips for `.env`, file, stdin including comments and blank lines.
  - `prompt.ts` simulated TTY tests for each keystroke path.
  - End-to-end against PR-1's route on a test DB: push two keys, list, rotate one, list again, verify fingerprints changed only on the rotated key.
  - **Leak tests**: run the CLI under a wrapper that fails if any secret value appears anywhere in stdout, stderr, or thrown error messages. The wrapper plants a sentinel value (`SENTINEL_LEAK_VALUE_xxx`) and greps the captured streams. Run for: success path, `--dry-run`, server-500 error path, network-down error path, malformed-stdin path.
- Doc: `packages/landing/src/content/docs/reference/lobu-secrets-push.md` mirroring the structure of the apply reference page.

Validation: `bun run typecheck`, `bun run check`, `bun test packages/cli`, `make build-packages`.

## Footguns to avoid

1. **Never log values, ever.** Not at debug level, not in error messages, not in stack traces. PR-1 adds an explicit logger-spy test that fails CI if any test fixture's secret value appears in the captured log. PR-2's `redact.ts` wraps stack-trace formatting with a value-shape-redacting filter (entropy + length heuristic).
2. **No local cache on disk.** No `~/.lobu/secrets-cache`, no `~/.config/lobu/last-pushed-fingerprints.json`, nothing. The CLI reads from source on every invocation.
3. **No `--value <plaintext>` arg.** Shell history is a leak vector. Cleared in Locked Decision #12; restated here because this is the most common foot-shoot pattern in CLI-secret tools.
4. **Fingerprint is 4 hex chars of SHA-256.** Documented in `packages/core/src/secret-fingerprint.ts`. Reasoning: 4 hex = 16 bits = enough for a human to spot `a3f1 → 9b22` as a change without enabling cross-org correlation. Full SHA-256 in audit logs is a leak surface (rainbow tables for low-entropy values like `password123`); 4 chars is intentionally too coarse.
5. **Rotation display**: `<key>: <old-fp> → <new-fp>`. Never `<key>: <old-value> → <new-value>`. Tested explicitly in PR-2's snapshot tests.
6. **Server never returns values.** Both `POST /manage` response and `GET /` response are hard-typed to omit `value`. No `?include=values` query param. No "admin override". A separate `lobu secrets read` (v3.x non-goal) would build this from scratch with extra gates, not extend these endpoints.
7. **Audit log is metadata-only.** No `before_value`, no `after_value`, no `value_length`, no `value_first_4_chars`, no anything that leaks the value. Fingerprint is the only value-derived field and it's bounded to 4 chars.
8. **Source-validation rejects obvious mistakes:**
   - Empty string → `400 invalid_value` server-side; CLI catches before sending and lists which keys had empty values.
   - Value starting with `lobu_secret_` → user has copied a placeholder; reject with explanatory message.
   - Value matching JWT shape (`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`) → warn (non-fatal): "value for KEY looks like a JWT — these are usually short-lived and don't belong in long-lived secret storage. Continue? [y/N]".
9. **Never `git stash` or write a temp file as part of the source-read flow.** The `.env` reader opens the file, parses in-memory, closes it. No tmp file copy. (Per `AGENTS.md` global rule against stash; the secret-leak corollary is "no value ever touches disk except as encrypted ciphertext server-side".)
10. **`process.env` pollution.** The CLI must not assign source values into `process.env`. Tested by snapshotting `Object.keys(process.env)` before and after a push.

## Specific design questions — answered

- **Audit log location?** New `public.secret_audit` table (PR-1). Modeled on the existing `entity_type_audit` precedent but with `fingerprint` instead of `before/after_payload`. The `events` table is rejected — that's the memory/knowledge log, not infra audit, and conflating them creates an exfil path (anyone with `events` read access could discover secret writes).
- **Permission tier?** Org `owner` or `admin`. Reuses the same `memberRole` check as `mcp:admin` scope filtering. `member` gets `403 forbidden_role`. CLI surfaces as `secrets push requires org admin or owner role; current role: member`.
- **Secret deletion?** Out of scope here. `lobu secrets delete <key>` ships in the same PR-2 if it's free, otherwise as a follow-up. The server route already supports `op: 'delete'` in PR-1, so the CLI cost is just adding a `delete` subcommand with the same per-key confirm. If it's not in PR-2, it goes in v3.1.
- **`secret://` ref interaction?** `secrets push` produces `secret://<orgSlug>/user/<name>` refs. Workers receive `lobu_secret_<uuid>` placeholders that the proxy resolves to those refs at egress. `lobu apply` reads `$VAR` references in `lobu.toml`, looks them up by name in the org's pushed-secrets list, and only writes the resolved `secret://...` ref into the agent's settings — apply still never sees values. The `secret://` scheme is the bridge: push produces refs, apply consumes them, runtime dereferences them.
- **`--rotate` confirmation UX?** Per-key, with `y/n/a/q` keystrokes. Summary-only confirm ("rotate 5 keys: A, B, C, D, E. Proceed?") was rejected because rotating four secrets you meant to rotate plus one you didn't is a single keystroke away — per-key with `a` (yes-to-all) for the trusting-CI case is the right tradeoff.
- **No `.env` for first-time setup?** Recommended flow: `vault read -format=json secrets/foo | jq -r '.data | to_entries[] | "\(.key)=\(.value)"' | lobu secrets push --from-stdin`. Documented in the reference page. The CLI errors clearly when both `--from-env` is set (default) and `.env` is missing, suggesting `--from-stdin` or `--from-file <path>`.

## Testing strategy

### Per-PR

- PR-1: handler + integration tests (round-trip, rotation, isolation, role-gating). Logger-spy leak test. Migration applies cleanly.
- PR-2: unit tests for source readers, snapshot tests for diff render, simulated-TTY tests for prompt. Sentinel-value leak tests across all error paths.

### End-to-end (this plan's exit criterion)

After both PRs merge:
1. `make build-packages`
2. Spin up local Postgres, apply migrations, boot `lobu run`.
3. Author a `.env` with `FOO=v1`, `BAR=v2`. Run `lobu secrets push --from-env --yes`. Verify `agent_secrets` has 2 ciphertexts and `secret_audit` has 2 rows with action=create.
4. `lobu secrets list` — verify `FOO`/`BAR` shown with 4-char fingerprints, no values anywhere.
5. Edit `.env` to `FOO=v1` (unchanged), `BAR=v2-new`. Run `lobu secrets push --from-env --rotate BAR --yes-rotate`. Verify 1 audit row added with action=rotate, ref unchanged.
6. Stop the gateway and `grep -ri 'v1\|v2\|v2-new' /tmp/lobu-logs/` — must return zero hits.
7. Author a `lobu.toml` agent referencing `$FOO`. Run `lobu apply`. Verify it succeeds because `FOO` is in cloud secrets list. Add `$BAZ` (not pushed) — verify apply fails with `missing required secrets: BAZ`.
8. Boot a worker, exercise the agent. Verify the worker's `process.env` shows `FOO=lobu_secret_<uuid>` (placeholder), and the upstream HTTP call resolves to `v1` via the proxy.
9. Run `lobu secrets push --from-env --yes` again with `.env` unchanged → output: `nothing to do (2 unchanged)`.
10. Member-role token: `lobu secrets push` returns `403 forbidden_role`.

## Non-goals

- ❌ `lobu secrets read <key>` — fetching values back into the CLI. Separate v3.x feature, gated by owner-only role + recent re-auth + per-call audit.
- ❌ Automatic rotation schedules / expiry warnings (v3.1).
- ❌ Vault / 1Password / KMS integrations as first-class flags (v3.1; stdin pipe covers the v3.0 use case).
- ❌ Multi-org bulk push (`--all-orgs`). Always one org per invocation, explicit `--org` or default-from-config.
- ❌ Syncing FROM cloud TO `.env`. Unsafe direction; would put plaintext on disk in a way the CLI promises never to do. Permanent non-goal.
- ❌ Backwards-compat alias for `lobu secrets list` (the old `.env` lister). Renamed to `lobu secrets local list`; old name is removed entirely (per global rule against deprecated aliases).
- ❌ A "preview the value" flag, even with confirmation. Promise is absolute: the CLI never prints values.

If any of these turn out to be hard requirements during real-world use, they get their own plan.
