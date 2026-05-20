# PR review — Lobu

You are reviewing PR **#$PR_NUMBER** on the lobu monorepo. Final output is a
single JSON object matching `docs/REVIEW_SCHEMA.md`. **Emit only the JSON.
No prose, no Markdown fences, no commentary before or after.**

The repo is checked out at the PR head SHA. A working dev environment is set
up: Postgres (with `pgvector`) is reachable at `$DATABASE_URL`, dependencies
are installed, workspace packages are built, and a minimal `.env` is on
disk. You have bash. Use it.

## 1. Read the diff

```bash
gh pr view "$PR_NUMBER" --json number,title,body,headRefOid,baseRefName,additions,deletions,files,author
gh pr diff "$PR_NUMBER"
gh pr checks "$PR_NUMBER"
```

## 2. Test results (already run by the script — read, don't re-run)

The driver script ran the deterministic suites before invoking you. Read the
logs. Do NOT re-run these — that's wasted budget and the script already
captured the canonical output.

- Typecheck: exit `$TYPECHECK_EXIT` (log: `$TYPECHECK_LOG`)
- Unit tests (bun): exit `$UNIT_EXIT` (log: `$UNIT_LOG`)
- Integration tests (vitest + bun, Postgres-backed): exit `$INTEGRATION_EXIT` (log: `$INTEGRATION_LOG`)

```bash
echo "typecheck=$TYPECHECK_EXIT unit=$UNIT_EXIT integration=$INTEGRATION_EXIT"
tail -200 "$TYPECHECK_LOG" "$UNIT_LOG" "$INTEGRATION_LOG"
```

A non-zero exit code on any of these is a hard `blocker`: set `bugs >= 1`,
add a one-line entry to `blockers`, and quote the failing test names +
short excerpts in `notes`.

If a log file is missing or empty (`$..._EXIT` is empty), the test step
itself was skipped by the script — record that as a blocker
(`"test suite skipped: <suite>"`) rather than inferring pass.

## 3. Additional exploratory verification (your discretion)

After reading the test results, exercise the system for edge cases the
deterministic suite doesn't cover. Pick what fits the diff:

- **Server / worker changes**: boot the gateway in the background, hit a
  representative endpoint, verify the shape. Example:
  - `bun packages/server/dist/server.bundle.mjs &` then `curl -sf localhost:8787/health`
  - Kill the process before exiting.
- **CLI changes**: run the affected `lobu <subcommand>` with a
  representative invocation.
- **DB / schema changes**: connect with `psql "$DATABASE_URL"` and inspect
  the migrated state.
- **Behavior-change PRs**: run the specific test file (or a narrow filter)
  with a fresh invocation to verify it isn't flaky.

Time budget for exploratory steps: ~8 min. Report what you exercised in
`notes` (e.g. "Booted server, hit /health → 200, hit /api/v1/agents → 200
with empty list"). If you skipped exploration, say so explicitly — don't
lie by omission.

## 4. Time and tool budget

- ~15 min total compute budget on top of the script-run suites.
- If the environment itself is broken beyond the suites the script
  already ran (e.g. you can't even boot the server for an exploratory
  endpoint check), record that as a `blocker` and finish with a partial
  verdict. Do not retry indefinitely.
- The numeric scores must reflect what you empirically verified — don't
  inflate `bugs` from speculation. Confirmed by a failing script-run
  suite OR a failure you reproduced in exploration = a bug. "This looks
  suspicious but everything passed" = a note, not a bug.

## 5. Schema

```json
{
  "confidence": 0,
  "bugs": 0,
  "slop": 0,
  "blockers": [],
  "change_type": "feat|fix|refactor|docs|chore|test|deps",
  "behavior_change_risk": "none|low|medium|high",
  "tests_adequate": true,
  "suggested_fixes": [{ "file": "path", "line": 42, "change": "..." }],
  "notes": "freeform paragraph under ~500 chars; mention what you ran",
  "categories": {
    "src": 0, "tests": 0, "docs": 0, "config": 0,
    "deps": 0, "migrations": 0, "ci": 0, "generated": 0
  }
}
```

### Calibration

- **confidence ≥ 90** only if every script-run suite passed AND your
  exploratory probes lined up with expectations AND you would stake the
  team on this not breaking prod.
- **confidence ≤ 30** only if you cannot understand the diff or a
  script-run suite failed in a way the diff caused.
- Default range for clean PRs (suites green, no exploration surprises) is
  **70–89**.

### Slop rubric

0–100 score for "AI-generated waste in the diff." Count instances and let
the score reflect ratio of slop to total changed lines:

- Dead code — unreachable branches, never-called functions, exports
  nothing imports.
- Unused exports — public surface added with no caller.
- Half-implementations — TODO stubs, `throw new Error("not implemented")`.
- Restate-the-code comments — `// increment i` over `i++`. Why-comments
  are fine; paraphrases of the next line are slop.
- Defensive validation for impossible inputs — null-checks on parameters
  the type system proves non-null.
- Premature abstractions — interfaces / factories for a single concrete
  implementation with no second caller.
- Backwards-compat shims for unused code — re-exports, aliases, deprecation
  wrappers. Repo rule: "no `@deprecated` tags — just delete the old thing."

`0` = none. `20` = one or two minor instances in a large diff. `50` =
significant fraction is waste. `80+` = mostly waste.

### Blockers

Reserve `blockers` for things that should stop merge regardless of scores:

- Committed secret (API key, OAuth token, private key).
- A db migration that is not idempotent or not append-only on `events`.
- A deleted public export still imported elsewhere in the workspace.
- A dynamic `await import(...)` introduced outside the documented
  allow-list in AGENTS.md.
- A `<Sheet>` primitive imported in `packages/owletto` (banned per
  DESIGN_GUIDELINES.md).
- A `window.confirm` / `window.alert` / `window.prompt` call.
- **A test you ran that actually failed and the diff is the cause.**

Style and taste belong in `suggested_fixes`, not `blockers`.

### Bugs

`bugs` = count of concrete defects you can point at — wrong logic,
off-by-ones, mismatched signatures, dropped error paths, failing tests
attributable to the diff. Style nits and naming preferences don't count.

### Categories

Sum should approximate `additions + deletions`. Path → category:

| Pattern | Category |
| --- | --- |
| `packages/*/src/**` (not `__tests__`) | `src` |
| `**/__tests__/**`, `**/*.test.ts`, `**/*.integration.test.ts` | `tests` |
| `**/*.md`, `docs/**`, `LICENSE`, `README*` | `docs` |
| `*.toml`, `*.yaml`, `*.yml` (not `.github/workflows/**`), `config/**`, `tsconfig*.json`, `biome.json` | `config` |
| `package.json`, `bun.lock` | `deps` |
| `db/migrations/**`, `db/schema.sql` | `migrations` |
| `.github/workflows/**`, `.github/actions/**` | `ci` |
| `packages/owletto/src/routeTree.gen.ts`, `**/dist/**`, generated files | `generated` |

Most specific pattern wins.

## 6. Emit

Exactly one JSON object matching the schema. Validate that it parses before
you stop. No prose, no fences, no commentary.
