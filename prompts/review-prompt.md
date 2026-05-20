# Code review — Lobu

You are reviewing the local changes on the current branch of the lobu
monorepo, against `$BASE_BRANCH`. Final output is a single JSON object
matching `docs/REVIEW_SCHEMA.md`. **Emit only the JSON. No prose, no
Markdown fences, no commentary before or after.**

The repo is checked out at `$HEAD_SHA`. A working dev environment is set
up: Postgres (with `pgvector`) is reachable at `$DATABASE_URL`, dependencies
are installed, workspace packages are built, and a minimal `.env` is on
disk. You have bash. Use it.

## 1. Read the diff

```bash
git log --oneline "$BASE_BRANCH..HEAD"
git diff --stat "$BASE_BRANCH...HEAD"
git diff "$BASE_BRANCH...HEAD"
```

There may or may not be a PR for this branch — don't assume one exists.
The review is on the local diff, not on PR metadata.

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

A non-zero exit code is **only** a `blocker` when the failing test (or the
code it exercises) is in the diff. Failures in untouched code are
pre-existing environmental issues — surface them in `notes` (prefix the
line with `[env]`) but DO NOT add them to `blockers`, and DO NOT inflate
`bugs`. To check: cross-reference failing test file paths against
`git diff --name-only "$BASE_BRANCH...HEAD"`. If the failing test file
(and the source it imports from) is not in the diff, it is environmental.

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
  "bug_free_confidence": 0,
  "bugs": 0,
  "slop": 0,
  "simplicity": 0,
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

`bug_free_confidence`, `slop`, and `simplicity` are **independent axes**. A
change can score high `bug_free_confidence` (works), high `slop` (lots of
unused code added), and low `simplicity` (overengineered). Score each on its
own merits.

### Calibration — bug_free_confidence

How sure are you the change works correctly?

- **90+** — "I'd stake the team on this not breaking prod." Every script-run
  suite passed AND your exploratory probes lined up with expectations AND you
  see no semantic risk you can name.
- **70–89** — Compiles + tests pass, but there's a code path you couldn't
  verify.
- **40–69** — You found at least one thing that *might* break; can't rule it
  out.
- **0–39** — You found something that almost certainly breaks, OR you can't
  even understand the change well enough to judge.

Do not go above 90 unless you would genuinely stake the team on this.

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

### Simplicity rubric

0–100 score for "how elegant is this change for the goal." Higher = simpler.

- **100** — elegant. Minimal change for the goal. No abstraction not earned
  by current users. Could be picked up by someone new without context.
- **70–99** — reasonable. Some flex but justifiable.
- **40–69** — overcomplicated. Helper layers that hide what's happening.
  Flag arguments that should be separate functions. Generics for one caller.
- **0–39** — byzantine. Heavy abstraction tax. Reader has to hold a lot to
  understand a small change.

High `simplicity` does NOT mean "less code." A 3-line change with a clever
side effect is low simplicity. A 200-line change that reads top-to-bottom is
high simplicity.

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

### Suggested fixes

Suggested fixes are read by the local Claude Code agent and applied between
review iterations — not by pi itself. Be specific (file path + line number +
concrete change). Don't include vibe suggestions like "consider refactoring
this" or "this could be cleaner" — the agent can't act on those. If you
can't name the file, line, and the exact change, leave it out and put it in
`notes` instead.

### Categories

Sum should approximate `additions + deletions` from `git diff --stat
"$BASE_BRANCH...HEAD"`. Path → category:

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

`bugs` counts only defects caused by the diff. Pre-existing breakage spotted
while reviewing (test failures in untouched code, environment-level issues
in the test setup, etc.) goes in `notes` with an `[env]` prefix — not in
`bugs` and not in `blockers`.
