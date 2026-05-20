# PR Review Verdict Schema

After completing a PR, the agent runs `make pi-review PR=<n>` locally. The
script (`scripts/run-pi-review.sh`) drives the deterministic test suites,
invokes `pi` against the diff, and posts a `pi-review` check-run plus a PR
comment with a JSON verdict matching this schema. **GitHub Actions does not
run pi-review** — it's a local-driven shadow mode owned by the agent that
landed the PR.

A future merge bot will read this verdict and decide whether to auto-merge.
For now the verdict is informational: the check-run always finishes with
`conclusion: neutral`, never `failure`. **No gate logic exists yet.**

The schema is reviewer-agnostic — a second independent reviewer can be
added later without touching the shape below.

## Schema

```json
{
  "confidence": 0,
  "bugs": 0,
  "slop": 0,
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

### `confidence` (integer, 0–100)

How confident the reviewer is that this PR can land without breaking prod.

- **90+** — would stake the team on it. Reserve for changes the reviewer fully
  understands and that are well-tested.
- **60–89** — looks correct, no concerns worth raising. Default ceiling for
  most clean PRs.
- **30–59** — readable but with material uncertainty (e.g. touches a path the
  reviewer can't fully reason about, missing tests on a risky surface).
- **<30** — reviewer cannot even understand the diff, or sees a concrete
  reason it will break.

**Calibration rule:** do not go above 90 unless the change is genuinely
low-risk *and* understood. Do not go below 30 unless the diff is unreadable.

**Future gate:** auto-merge will require `confidence >= 80` (and equivalent
thresholds from any additional reviewer that gets wired in).

### `bugs` (integer, ≥0)

Count of confirmed issues. A confirmed issue is **either** a non-zero exit
code on a script-run test suite (typecheck, unit, integration) **or** a
reproducible failure the reviewer observed exercising the system (boot
probe, endpoint hit, narrow test re-run). Speculation is NOT a bug — it
goes in `notes` as a concern. If you didn't verify, you don't get to count.

Style nits and naming preferences do not count.

**Future gate:** auto-merge will require `bugs == 0`.

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

**Future gate:** auto-merge will require `slop <= 30`.

### `blockers` (array of strings)

One-line descriptions of issues that should block merge regardless of the
other scores. Empty array if none. Examples:

- `"introduces a secret in a committed file"`
- `"db migration is not idempotent"`
- `"deletes a public export still used by @lobu/cli"`

**Future gate:** auto-merge will require `blockers.length == 0`.

### `change_type` (enum)

One of: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `deps`.

Maps to conventional-commit prefix. Use the prefix that best describes the
**primary** intent of the diff. If the PR genuinely does two things in equal
measure (e.g. `feat` + `test`), prefer `feat`. If you would split this PR,
say so in `notes`.

**Future use:** `docs` / `chore` / `test` PRs will get a more permissive gate
than `feat` / `fix` / `refactor`.

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

**Future gate:** `high` will require human approval even if scores otherwise
pass.

### `tests_adequate` (boolean)

`true` if the diff includes tests covering the behavior change (or no tests
are warranted because behavior_change_risk is `none`). `false` if a
behavior change ships without test coverage.

**Future gate:** `false` blocks auto-merge unless `change_type` is `docs` /
`chore`.

### `suggested_fixes` (array of objects)

Specific actionable suggestions. Each object has `file`, `line`, `change`.
Empty array if none. These get surfaced in PR comments by the future merge
bot but are advisory in shadow mode.

### `notes` (string)

A freeform paragraph (one paragraph, not a wall of text) summarizing the
reviewer's overall take. This is what shows up in the check-run summary
above the JSON. Keep it under ~500 chars.

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

**Future use:** the merge bot uses these to apply per-category gates (e.g.
`docs`-only PRs skip the bugs/slop gates).

## Shadow-mode reminder

The reviewer posts `conclusion: neutral` regardless of scores. Merges are
not gated by this check-run yet. The point of shadow mode is to observe how
the verdicts track real-world PR outcomes so the gate thresholds above can
be calibrated before they are wired up.

Today's flow: agent finishes a PR → runs `make pi-review PR=<n>` locally →
pi reviews + posts check-run + PR comment → human reads the verdict in the
GitHub UI and merges. A future merge bot will read the verdict and apply
the gate thresholds above; that bot doesn't exist yet.
