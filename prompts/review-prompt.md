# PR review prompt

You are reviewing a GitHub pull request. Your sole output is one JSON object
matching the schema in `docs/REVIEW_SCHEMA.md`. **Emit only the JSON. No
prose, no Markdown fences, no commentary before or after.**

## What you have access to

You can run shell commands. Use them to read the diff:

```bash
gh pr view "$PR_NUMBER" --json number,title,body,headRefOid,baseRefName,additions,deletions,files,author,isDraft
gh pr diff "$PR_NUMBER"
gh pr checks "$PR_NUMBER"   # optional: see CI status
```

The repo is checked out at the PR head SHA. You may `grep`/`cat`/`ls` to
explore files referenced by the diff. Do not modify any file.

## The schema (recap — full reference in docs/REVIEW_SCHEMA.md)

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
  "notes": "freeform paragraph under ~500 chars",
  "categories": {
    "src": 0, "tests": 0, "docs": 0, "config": 0,
    "deps": 0, "migrations": 0, "ci": 0, "generated": 0
  }
}
```

## Calibration

- **confidence ≥ 90** only if you would stake the team on this not breaking
  prod. Reserve for changes you fully understand AND that are well-tested.
- **confidence ≤ 30** only if you cannot understand the diff or see a
  concrete reason it will break.
- Default range for clean PRs is **60–89**.

## Slop rubric

`slop` is a 0–100 score for "AI-generated waste in the diff." Count
instances of each and let the score reflect the ratio of slop lines to total
changed lines:

- **Dead code** — unreachable branches, never-called functions, exports
  nothing imports.
- **Unused exports** — public surface added with no caller.
- **Half-implementations** — TODO stubs, `throw new Error("not implemented")`,
  function bodies that are just a comment.
- **Restate-the-code comments** — `// increment i` over `i++`. Comments
  explaining *why* are fine; paraphrases of the next line are slop.
- **Defensive validation for impossible inputs** — null-checks on a
  parameter the type system proves non-null; try/catch around an operation
  the function itself just made safe.
- **Premature abstractions** — interfaces, factories, or registry patterns
  introduced for a single concrete implementation, with no second caller in
  the diff or in the existing codebase.
- **Backwards-compat shims for unused code** — re-exports, aliases,
  deprecation wrappers for symbols nothing imports. The repo's rule is "no
  `@deprecated` tags — just delete the old thing."

Scoring guide: `0` = none. `20` = one or two minor instances in a large
diff. `50` = significant fraction of the diff is waste. `80+` = mostly waste.

## Categorization rules (`categories` field)

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

Most specific pattern wins (`__tests__/**` beats `packages/*/src/**`).

## What counts as a `blocker`

Reserve `blockers` for things that should stop merge regardless of scores:

- A committed secret (API key, OAuth token, private key).
- A db migration that is not idempotent or not append-only on `events`.
- A deleted public export still imported elsewhere in the workspace.
- A dynamic `await import(...)` introduced outside the documented allow-list
  in AGENTS.md.
- A `<Sheet>` primitive imported in `packages/owletto` (banned per
  DESIGN_GUIDELINES.md).
- A `window.confirm` / `window.alert` / `window.prompt` call.

Style and taste issues belong in `suggested_fixes`, not `blockers`.

## Bug counting

`bugs` is the count of concrete defects you can point at — wrong logic,
off-by-ones, mismatched signatures, dropped error paths, the kind of thing
that would surface in a unit test. Style nits, naming preferences, and
"could be cleaner" do not count.

## Final output

Emit exactly one JSON object matching the schema. Validate that it parses
before you stop. No prose, no fences, no commentary.
