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

## 2. Verify behavior (REQUIRED for any change under packages/{core,server,agent-worker,cli}/**)

Don't trust the diff alone — code that compiles can still be wrong. For any
non-trivial source change:

- Identify which packages are touched. `gh pr view --json files` gives you
  the list.
- **Run the affected test suites.** Examples:
  - `bun test packages/core` — core unit tests
  - `bun test packages/agent-worker` — worker unit tests
  - `bun test packages/server/src/__tests__/unit` — gateway pure-unit
  - `bun test packages/server/src/gateway/__tests__` — gateway DB-backed
    (needs `DATABASE_URL`, which you have)
  - `cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default` — server integration suite
- **For runtime/boot-path changes** (`packages/server/**`, `packages/agent-worker/**`),
  boot the gateway and hit an endpoint:
  - `bun packages/server/dist/server.bundle.mjs &` then `curl -sf localhost:8787/health`
  - Kill the process before exiting.
- **CI is already running these tests** — if `gh pr checks` shows green
  on the unit / integration jobs, you don't need to re-run them. Read
  `gh run view <runId> --log-failed` for the failure excerpts instead.
- Capture pass/fail output. Paste relevant failure excerpts into `notes`
  (keep under 500 chars total).

## 3. Time and tool budget

- ~15 min total compute budget. If a single test suite runs long, skip it
  rather than blowing the budget — note "skipped: too slow" in `notes`.
- If the environment itself is broken (postgres unreachable, build
  artifacts missing), record it as a `blocker` and finish with a partial
  verdict based on the diff alone. Do not retry indefinitely.
- The numeric scores must reflect what you empirically verified — don't
  inflate `bugs` from speculation. Confirmed-by-failing-test = a bug;
  "this looks suspicious but tests pass" = a note, not a bug.

## 4. Schema

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

- **confidence ≥ 90** only if you ran tests AND would stake the team on this
  not breaking prod.
- **confidence ≤ 30** only if you cannot understand the diff or saw tests
  fail.
- Default range for clean PRs you verified is **70–89**.

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

## 5. Emit

Exactly one JSON object matching the schema. Validate that it parses before
you stop. No prose, no fences, no commentary.
