# PR Review Verdict Schema

After making changes on a feature branch, the agent runs `make review`
locally. `scripts/review.sh` drives the deterministic test suites in cwd,
invokes `pi` against `git diff <base>...HEAD` (base defaults to `main`,
override with `BASE=<branch>` or `--base <branch>`), and prints a JSON
verdict matching this schema. The script posts a `pi-review` commit status
whenever GitHub auth is available; if a PR exists for the current branch, it
also posts an idempotent PR comment (marker-keyed upsert) with the verdict.
**GitHub Actions does not run review** — it's a local-driven gate owned by
the agent doing the work.

Branch protection can require the `pi-review` status. The status fails when
any merge gate below fails: `bug_free_confidence < 80`, `bugs > 0`,
`slop > 15`, `simplicity < 70`, `blockers` is non-empty,
`tests_adequate == false`, or `behavior_change_risk == "high"`. Thresholds
are tunable for one-off runs with `PI_REVIEW_MIN_BUG_FREE`,
`PI_REVIEW_MAX_SLOP`, and `PI_REVIEW_MIN_SIMPLICITY`.

The schema is reviewer-agnostic — a second independent reviewer can be
added later without touching the shape below.

## Schema

```json
{
  "bug_free_confidence": 0,
  "bugs": 0,
  "slop": 0,
  "simplicity": 0,
  "blockers": ["string", "..."],
  "change_type": "feat|fix|refactor|docs|chore|test|deps",
  "behavior_change_risk": "none|low|medium|high",
  "tests_adequate": true,
  "suggested_fixes": [{ "file": "path/to/file.ts", "line": 42, "change": "what to change" }],
  "notes": "freeform paragraph",
  "categories": {
    "src": 0,
    "tests": 0,
    "docs": 0,
    "config": 0,
    "deps": 0,
    "migrations": 0,
    "ci": 0,
    "generated": 0
  }
}
```

All fields are required. Reviewers MUST emit only this JSON object — no
surrounding prose, no Markdown fences, no commentary.

## Fields

### `bug_free_confidence` (integer, 0–100)

How sure the reviewer is that the change works correctly and won't break prod.

- **90+** — "I'd stake the team on this not breaking prod." Tests pass;
  exploratory verification confirmed; no semantic risk the reviewer can name.
- **70–89** — Compiles + tests pass, but there's a code path the reviewer
  couldn't verify.
- **40–69** — The reviewer found at least one thing that *might* break and
  can't rule it out.
- **0–39** — The reviewer found something that almost certainly breaks, OR
  can't even understand the change well enough to judge.

**Calibration rule:** do not go above 90 unless the reviewer would genuinely
stake the team on this.

**Gate:** `make review` passes only when `bug_free_confidence >= 80` by
default. Override for one run with `PI_REVIEW_MIN_BUG_FREE=<n>`.

### `bugs` (integer, ≥0)

Count of defects **caused by the diff**. A defect is **either** a failing
test the diff itself broke **or** a reproducible failure the reviewer
observed exercising the system (boot probe, endpoint hit, narrow test
re-run) that maps back to a line the diff touches.

Pre-existing environmental breakage spotted while reviewing — a failing
test in code the diff does not touch, a broken test setup, a missing
workspace export from an unrelated package — does NOT count. Surface it in
`notes` with an `[env]` prefix so the operator sees it without inflating
the bugs count.

Speculation is also not a bug — it goes in `notes` as a concern. If you
didn't verify, you don't get to count.

Style nits and naming preferences do not count.

**Gate:** `make review` passes only when `bugs == 0`.

### `slop` (integer, 0–100)

A rubric score for "AI-generated waste in the diff." Higher = more slop.

Count instances of each of the following and let the score reflect the
ratio of slop lines to total changed lines:

- **Dead code** — unreachable branches, never-called functions, exports nothing
  imports.
- **Unused exports** — public surface added that no other module needs.
- **Half-implementations** — TODO stubs, `throw new Error("not implemented")`,
  functions whose body is a comment.
- **Restate-the-code comments** — `// increment i` over `i++`. Comments that
  explain *why* are fine; comments that paraphrase the next line are slop.
- **Defensive validation for impossible inputs** — null-checks on a parameter
  the type system already proves is non-null; try/catch around `JSON.parse`
  on a string the function itself just stringified.
- **Premature abstractions** — interfaces, factories, registry patterns
  introduced for a single concrete implementation, with no second caller in
  the diff or in the existing codebase.
- **Backwards-compat shims for unused code** — re-exports, aliases, or
  deprecation wrappers for symbols nothing imports. (Per AGENTS.md: "no
  `@deprecated` tags — just delete the old thing.")

**Scoring guide:** 0 = no slop; 20 = one or two minor instances in a large
diff; 50 = significant fraction of the diff is waste; 80+ = the diff is
mostly waste.

**Gate:** `make review` passes only when `slop <= 15` by default. Override for
one run with `PI_REVIEW_MAX_SLOP=<n>`.

### `simplicity` (integer, 0–100)

How elegant the change is for the goal it's pursuing. Higher = simpler.

- **100** — elegant. Minimal change for the goal. No abstraction not earned by
  current users. Could be picked up by someone new without context.
- **70–99** — reasonable. Some flex but justifiable.
- **40–69** — overcomplicated. Helper layers that hide what's happening. Flag
  arguments that should be separate functions. Generics for one caller.
- **0–39** — byzantine. Heavy abstraction tax. Reader has to hold a lot to
  understand a small change.

**Note:** high `simplicity` does NOT mean "less code." A 3-line change with a
clever side effect is low simplicity. A 200-line change that reads
top-to-bottom is high simplicity.

**Gate:** `make review` passes only when `simplicity >= 70` by default.
Override for one run with `PI_REVIEW_MIN_SIMPLICITY=<n>`.

> **Independent axes.** `bug_free_confidence`, `slop`, and `simplicity` are
> independent. A change can score high `bug_free_confidence` (works), high
> `slop` (lots of unused code added), and low `simplicity` (overengineered).
> The `pi-review` status requires all seven gates to pass: these three metrics,
> `bugs == 0`, `blockers.length == 0`, `behavior_change_risk != "high"`, and
> `tests_adequate == true`.

### `blockers` (array of strings)

One-line descriptions of issues **caused by this diff** that should block
merge regardless of the other scores. Empty array if none. Examples:

- `"introduces a secret in a committed file"`
- `"db migration is not idempotent"`
- `"deletes a public export still used by @lobu/cli"`

Pre-existing environmental failures (test suite broken on `main`, missing
workspace export from an unrelated package, Postgres schema-ACL issue in
test setup) are NOT blockers — they belong in `notes` with an `[env]`
prefix. A failing test only blocks when the failing test, or the source
code it exercises, appears in `git diff --name-only "$BASE_BRANCH...HEAD"`.

**Gate:** `make review` passes only when `blockers.length == 0`.

### `change_type` (enum)

One of: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `deps`.

Maps to conventional-commit prefix. Use the prefix that best describes the
**primary** intent of the diff. If the PR genuinely does two things in equal
measure (e.g. `feat` + `test`), prefer `feat`. If you would split this PR,
say so in `notes`.

**Note:** the current `pi-review` status applies one gate policy to all change
types. If a docs/chore/test PR needs an exception, use an explicit env override
or admin merge.

### `behavior_change_risk` (enum)

One of: `none`, `low`, `medium`, `high`.

- **none** — pure refactor, docs, type-only changes. No runtime behavior
  reaches users.
- **low** — behavior change is bounded to a narrow code path with adequate
  tests, or to a dev-only / opt-in surface.
- **medium** — behavior change affects a path users hit but is well-typed and
  tested, or affects an internal API with multiple call sites.
- **high** — behavior change touches a hot path, migrations, auth, billing,
  data integrity, or anything with cross-system consequences (queue,
  scheduler, retry).

**Gate:** `make review` fails when risk is `high`; that path requires human
approval / admin merge even if scores otherwise pass.

### `tests_adequate` (boolean)

`true` if the diff includes tests covering the behavior change (or no tests
are warranted because behavior_change_risk is `none`). `false` if a
behavior change ships without test coverage.

**Gate:** `make review` fails when `tests_adequate` is `false`. For docs/chore
exceptions, use an explicit env override or admin merge.

### `suggested_fixes` (array of objects)

Specific actionable suggestions. Each object has `file`, `line`, `change`.
Empty array if none.

These are read by the local Claude Code agent and applied between review
iterations — not by pi itself. Be specific (file path + line + concrete
change). Vibe suggestions ("consider refactoring", "this could be cleaner")
don't belong here — the agent can't act on them; surface those as `notes`
instead.

### `notes` (string)

A freeform paragraph (one paragraph, not a wall of text) summarizing the
reviewer's overall take. This is what shows up in the PR comment above
the JSON. Keep it under ~500 chars.

### `categories` (object)

Line counts by category. Sum should approximate `additions + deletions`.

Path → category mapping:

| Pattern | Category |
| --- | --- |
| `packages/*/src/**` (not `__tests__`) | `src` |
| `**/__tests__/**`, `**/*.test.ts`, `**/*.integration.test.ts` | `tests` |
| `**/*.md`, `docs/**`, `LICENSE`, `README*` | `docs` |
| `*.toml`, `*.yaml`, `*.yml` (not `.github/workflows/**`), `config/**`, `tsconfig*.json`, `biome.json` | `config` |
| `package.json`, `bun.lock`, `**/package.json` | `deps` |
| `db/migrations/**`, `db/schema.sql` | `migrations` |
| `.github/workflows/**`, `.github/actions/**` | `ci` |
| `packages/owletto/src/routeTree.gen.ts`, `**/dist/**`, generated files | `generated` |

When a path matches multiple patterns, the more specific one wins
(`__tests__/**` beats `packages/*/src/**`).

**Note:** categories are currently informational and may be used for more
nuanced gates later.

## Local gate flow

Today's flow: agent finishes a change → opens a PR → runs `make review` from
the branch's worktree → pi reviews and prints the JSON verdict → the script
posts/updates the `pi-review` commit status and PR comment. Branch protection
can require `pi-review`, so a new commit remains unmergeable until the local
review runs and passes for that exact SHA. Human/admin merge remains the
explicit escape hatch for intentional exceptions.
