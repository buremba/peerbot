# Gotchas

Traps that have each cost a real debugging session. Read the section for the surface you are touching before you start; each entry is written as a symptom you would actually see, so grep this file when something looks inexplicable.

Root `AGENTS.md` holds the invariants and the workflow. This file holds the mechanical failure modes.

## Symptom index

| You are seeing | Section |
| --- | --- |
| `TS2305: Module '@lobu/core' has no exported member` | Build & typecheck |
| `TS2307: Cannot find module '@lobu/<pkg>'` | Build & typecheck |
| Green typecheck that CI then fails | Build & typecheck |
| A formatting diff thousands of lines wide | Formatting & lint |
| `PostgresError: malformed array literal` | DB & SQL |
| An embedding reads back as a string, not `number[]` | DB & SQL |
| squawk / migration job exits non-zero on a warning | DB & SQL |
| `ERR_RESOLVE_PACKAGE_ENTRY_FAIL` in integration setup | Testing |
| `could not create shared memory segment: No space left on device` | Testing |
| A mock that works alone but not in the suite | Testing |
| A server that is "healthy" suspiciously fast | Testing |
| `gh run view --log-failed` printing nothing | CI triage |
| `grep` finding nothing in a CI log you can read | CI triage |
| `codex exec` / `pi -p` hanging at 0% CPU | Shell & CLI |
| `unexpected EOF while looking for matching '` | Shell & CLI |
| `Chromium binary not found at PLAYWRIGHT_BROWSERS_PATH` | Browser & connectors |
| `Missing --auth-profile` | Browser & connectors |
| Browser automation hitting a login wall | Browser & connectors |
| `check-drift` failing on a submodule pointer | Submodule & cross-repo |
| A rebase that "already upstream"-ed your pointer commit | Submodule & cross-repo |

## Build & typecheck

**Stale dist gives a false green typecheck.** `packages/server` typechecks against the *built* `dist` of `@lobu/core`, not its source. If you change a `@lobu/core` contract and only run `make typecheck`, the green is meaningless. Run `make build-packages` first on any PR touching core contracts, and never `--admin`-merge past a typecheck check that has not reported.

**Phantom `TS2305: Module '@lobu/core' has no exported member 'X'` inside a worktree.** The worktree's own `@lobu/*` dists are missing, so tsc resolves through the *main checkout's* stale dist. Build the worktree's dists (`make build-packages`). `packages/core` is `composite: true`, so use `bunx tsc --build --force` — a plain `rm -rf dist` leaves a stale `tsconfig.tsbuildinfo` behind. Diagnose with `bunx tsc --noEmit --traceResolution 2>&1 | grep "@lobu/core"`.

**A new workspace package must be added to three build lists or CI fails while local passes.** In dependency order: the `build-packages` loop in `Makefile`, the unit job's inline build step in `.github/workflows/ci.yml` (it builds packages individually, not via make), and `build:packages` in the root `package.json`. Symptom is `TS2307: Cannot find module '@lobu/<pkg>'` cascading into implicit-any noise. Reproduce locally with `rm -rf packages/<pkg>/dist` then typecheck.

**Inter-package deps are always `"@lobu/*": "workspace:*"`.** Never a hardcoded version or caret range — the root `package.json` is the single source of version truth.

**`bun.lock` changed but you touched no dependencies.** Bun silently prunes the workspace importer when the `packages/owletto` submodule is absent, so `git submodule update --init` must precede `bun install`. `make task-setup` already does this in the right order — you only hit this by building a worktree by hand.

## Formatting & lint

**Format only via `bun run check:fix` from the repo root.** Never `bunx biome check --write <path>`. Bare biome uses its own defaults (tabs) and ignores the repo config at `config/biome.config.json`.

**Several packages are biome-EXCLUDED, and an explicit file argument bypasses the exclusion.** `config/biome.config.json` excludes `packages/server`, `packages/owletto`, connector-sdk, connectors, connector-worker, embeddings, apps, and skills. Running biome on a file in one of them can turn a surgical change into a broad reflow diff that the CI format check will not catch. Recover from a clean copy of the file at `HEAD`, preserve any unrelated local changes, and redo the intended edit by hand in that file's existing style. `packages/core` and `packages/cli` *are* biome-formatted.

## DB & SQL

**Never bind a raw JS array as a query parameter in `packages/server`.** The client sets `fetch_types: false` (`PROD_PG_VALUE_OPTIONS` in `packages/server/src/db/client.ts`), so postgres.js ships arrays as scalars and you get `PostgresError: malformed array literal`. This holds for `number[]` and `string[]`, tagged-template and `sql.unsafe`, with or without an `::type[]` cast. Safe forms only:

```ts
sql`... WHERE id = ANY(${pgTextArray(ids)}::text[])`     // strings
sql`... WHERE id = ANY(${pgBigintArray(ids)}::bigint[])` // numbers
```

Both helpers are exported from `packages/server/src/db/client.ts`. `sql.array(a)`, `ARRAY[$a, $b]` of scalars, and spreads are also safe. JSONB is exempt (`JSON.stringify` / `sql.json`). CI enforces this via `scripts/check-raw-array-params.mjs`; the escape hatch is a `raw-array-ok` line comment.

**pgvector columns read back as the text string `"[1,2,3]"`, not `number[]`.** Parse before use.

**Keep array-binding repros on the production value options.** `getDb()` and the integration harness's `getTestDb()` both use `PROD_PG_VALUE_OPTIONS`; an ad hoc `postgres()` client without those options can mask the failure you are chasing.

**Dropping a column from a queryable table is a two-phase change.** `buildScopedQuery` emits explicit column lists from `QUERYABLE_SCHEMA`, so a single-release drop breaks old replicas mid-rollout. Remove the column from `QUERYABLE_SCHEMA` in release N; ship the `DROP COLUMN` migration in release N+1.

**New migrations are lock-safety linted by squawk in CI, and it exits non-zero on warnings.** The `migrations` job runs `squawk-cli` (version pinned in both `.github/workflows/ci.yml` and the `db:lint` script) over only the changed `db/migrations/*.sql`. Note `make review` does *not* run it. Conventions: `CREATE TABLE IF NOT EXISTS`; fold unique indexes into a table-level `CONSTRAINT ... UNIQUE`; a non-unique index on a brand-new table needs `CREATE INDEX IF NOT EXISTS` plus `-- squawk-ignore require-concurrent-index-creation`; a `migrate:down` DROP needs `-- squawk-ignore ban-drop-table`. Check locally with `bun run db:lint db/migrations/<file>.sql`.

**Read the actual SQL before scoping performance work.** A review agent claiming "JSONB full scan" is a claim, not a measurement — a PK-anchored JSONB extract is microseconds. `EXPLAIN ANALYZE` before you denormalize anything.

## Testing

**Hoisted `vi.mock()` silently fails in the server *integration* suite.** That run shares a module registry across files, so a test that is green alone loads the real module in CI. Use `vi.resetModules()` + `vi.doMock(...)` + a dynamic `await import()` *after* the mock, with an `afterEach` that resets modules and un-mocks. Always verify by co-running siblings — `vitest run <fileA> <fileB>` — because green-alone is not green-in-suite.

**`ERR_RESOLVE_PACKAGE_ENTRY_FAIL` during integration global setup.** `@lobu/pgvector-embedded` is not built. `cd packages/pgvector-embedded && bun run build`.

**`could not create shared memory segment: No space left on device` on macOS.** The SHMMNI limit, not disk. Reap detached segments: `ipcs -mob`, then `ipcrm -m <id>` for entries with `nattch=0` **only**.

**Integration suite prerequisites.** Node 22 is the repo default (`.node-version`); Lobu accepts Node 22–24 and 26+, while Node 25 boots without the SDK sandbox. Global setup uses `DATABASE_URL` if set, otherwise spawns an ephemeral embedded Postgres + pgvector.

**`make dev` is not the test harness.** It migrates its owned local per-branch database and boots the app, but that does not exercise the branches a relevant unit or integration suite covers.

**A scratch server that is "healthy" before the fresh initdb and migration logs appear is probably an orphan.** A cold embedded boot runs `initdb` as a subprocess, so a genuinely fresh server logs it; instant health means you reached a server that was already running. Confirm with the data dir rather than the clock — `<dir>/.lobu/pgdata/PG_VERSION` should exist and be newly created. Kill orphans by port, not name — `pkill -f "lobu run --port"` never matches, because the real cmdline is `node .../server.bundle.mjs`. Confirm what you are about to kill first (`lsof -iTCP:<port> -sTCP:LISTEN`, check it is the expected `server.bundle.mjs`), then `lsof -tiTCP:<port> -sTCP:LISTEN | xargs kill`. Reserve `-9` for a process that ignores the polite signal.

**Isolating a benchmark/scratch server:** pass `DATABASE_URL="file:///tmp/<dir>"` — the embedded runtime creates `<dir>/.lobu/pgdata`. The runtime reads `DATABASE_URL`; `lobu run` maps `LOBU_DATA_DIR` into it only when `DATABASE_URL` is absent. Without either, `lobu run` defaults to the shared `~/.lobu/pgdata`.

## CI triage

**Fetch a failing job's log exactly once, to a file:** `gh run view --job <id> --log | sed 's/^[^Z]*Z //' > /tmp/ci-<id>.log`, then search the file with `grep -a '<pattern>' /tmp/ci-<id>.log`. Refetching is the single most repeated waste in CI triage — 21 sessions have re-pulled the same log 170 times, one of them hitting the same job 9 times in 105 seconds.

**Use `--log`, not `--log-failed`.** `--log-failed` is empty for any failure that is not a failed test step — `check-drift` and `publish-packages` both print nothing — and that empty result is what forces the second fetch.

**`grep` needs `-a`, and the lines are prefixed.** Job logs are timestamped and ANSI-coloured, so grep treats them as binary and the prefix defeats anchored patterns. The `sed 's/^[^Z]*Z //'` in the fetch above strips the prefix once, at save time; `-a` is still needed for the ANSI bytes that remain.

## Shell & CLI

**Always append `< /dev/null` to `codex exec` and `pi -p`** in any non-tty or background invocation. Without it they block in `S` state at 0% CPU and silently produce nothing.

**macOS `/bin/sh` is bash 3.2 and mis-parses a heredoc nested inside `"$(cat <<'DELIM' … DELIM)"`.** A single apostrophe in the body kills the script with `unexpected EOF while looking for matching '`. Never inline user- or server-controlled text into a generated shell script that way — write it to a `0600` tempfile and read it back with `"$(cat '<file>')"` at runtime. Validate generated scripts with `/bin/sh -n`, not interactive zsh.

## Browser & connectors

**Chromium launch failures: read which of the two errors you got.** `packages/connector-sdk/src/browser/launcher.ts` distinguishes them — `Chromium binary not found at PLAYWRIGHT_BROWSERS_PATH=…` means a path mismatch, `Playwright not installed` means the package itself is unresolvable. Two things must hold to prevent the path/revision failure: `docker/worker/Dockerfile` and `docker/app/Dockerfile` set `ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` *before* install; and the install explicitly uses patchright's revision (`node node_modules/playwright/cli.js install chromium` in the worker image, `npx patchright install chromium` in the app image) rather than the vanilla `node_modules/.bin/playwright`. In-pod check:

```sh
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node -e "const p=require('playwright').chromium.executablePath();console.log(p, require('fs').existsSync(p))"
```

**Connector success status in `runs` is `completed`, not `success`.** To re-trigger one feed: `UPDATE feeds SET next_run_at = now() WHERE id = <id>` — always with the `WHERE`, and against a dev database. Unscoped, it schedules every feed in the table at once.

**To drive the user's real logged-in browser, use the paired Owletto extension**, not claude-in-chrome (that drives a different Chrome without their sessions) and not `lobu connector run` (local Playwright/CDP only — it errors with "Missing --auth-profile"). The recipe is in `docs/BROWSER_TESTING.md` under "Driving the paired Owletto extension"; it routes through `packages/server/src/worker-api/dispatch-chrome-action.ts`. Discover the `operations` namespace with `search_sdk operations`, then call it through `run_sdk`. A new server-side chrome action also needs a handler in the *installed* extension build, so check `git ls-tree origin/main packages/owletto`, never the working-tree submodule HEAD.

**Receiving real third-party webhooks against a local gateway** uses Tailscale Funnel on :443: `tailscale funnel --bg --https=443 http://127.0.0.1:<port>`. The `serve` subcommand looks identical but silently makes the port tailnet-only — always `funnel`, and verify with `tailscale funnel status`. curl from the same machine resolves over the tailnet, so a local 200 does not prove public reachability.

## Submodule & cross-repo

**Never point the parent repo at a submodule SHA that is unreachable from the submodule's remote.** Push the submodule first, then bump the pointer. Prod submodule clones fail on unreachable SHAs.

**Landing paired lobu + owletto PRs:** merge the owletto PR (squash), take the resulting owletto-main SHA, re-point the lobu submodule pointer PR at *that squash SHA*, then merge lobu. `check-drift` fails until the pointer is an ancestor of owletto/main. When the pointer branch is behind lobu main, use `git merge origin/main` — **never `git rebase`**, which drops the pointer commit as "patch contents already upstream", after which a `--amend` corrupts HEAD. To recover, first make the damage reversible — `git status` must be clean (stop if it is not, and commit rather than discard), then tag the current tip so nothing is stranded: `git branch backup/<branch>-$(git rev-parse --short HEAD)`. Only then reset to the remote tip with `git reset --keep origin/<branch>` (it refuses rather than clobbering uncommitted work; use `--hard` only on a confirmed-clean tree). Then merge and resolve the single submodule conflict:

```sh
git -C packages/owletto checkout <squash-sha> && git add packages/owletto && git commit --no-edit
```

**Never fold a private repo into public `lobu`.** Check `gh repo view --json visibility` on both sides before any "consolidate into the monorepo" move — a past fold leaked a large private frontend publicly.

## Prod safety

**Your local run gets claimed and failed by a prod worker.** A prod worker pod polling the same database will claim your pending runs and fail them out from under local dev. The fix is to stop sharing the database: point `DATABASE_URL` at a local or embedded Postgres (see "Isolating a benchmark/scratch server" above). Scaling the prod worker deployment down is a production change, not a dev step — it stops real users' runs, so it requires the deployment owner's explicit approval, a coordinated maintenance window, and a restore plan; never run an ad hoc `kubectl scale` mid-debug.
