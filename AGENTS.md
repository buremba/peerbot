<!-- Project rules for agents (Claude, pi, codex). CLAUDE.md inlines this into every session — keep this file lean. Put package-specific detail in the nearest package AGENTS.md. -->

## Repo map
- Bun workspace under `packages/*`; TS source is in `src`, tests in `__tests__`.
- Main packages: `core` shared types/utils, `plugin-api` native plugin contracts, `plugin-host` deterministic plugin composition, `server` gateway + embedded runtime, `agent-worker` Lobu agent execution, `connectors` built-in connectors, `owletto` frontend submodule.
- Before editing a package, read its nearest `AGENTS.md` if present.
- `docs/GOTCHAS.md` collects the mechanical traps (build, SQL, testing, submodule, browser) that have each cost a debugging session. Skim the section for the surface you are touching before you start, and grep it when something looks inexplicable.

## Hard invariants
- **Never write to `~/Code/lobu` directly — work in a worktree.** Run `make task-setup NAME=<slug>` first, and never `git switch` in the main checkout.
- One branch = one concern (not one file). Tangential task → commit/push/open current work, then branch fresh from `main`. Split only for genuinely independent concerns or an unreviewable diff.
- **Multi-replica correctness is mandatory.** Never put shared required state in an in-memory Map/singleton another replica must read or mutate. If a feature relies on cross-pod visibility, use Postgres-mediated state/signal.
- **`events` is append-only.** Never `DELETE FROM events`; tombstone/supersede instead.
- **Never bulk-delete prod `organization` rows**, including zero-activity ones — empty-looking orgs are frequently real human signups. Surface them one at a time for confirmation.
- **Workers never receive real credentials.** They may receive only placeholders/proxied access. The only exceptions are device-pinned connectors and short-lived provider-derived credential leases (see `packages/server/AGENTS.md`); a durable stored credential is never one of them.
- Default to static `import`. New dynamic imports require measured cost justification here or in the package AGENTS plus a rationale comment at the call site. Tests may dynamically import after mocks.
  - Node-version gate exceptions: `packages/cli/bin/lobu.js` defers the existing CLI graph without duplicating it, and `packages/server/src/server-entry.ts` adds an 842-byte gate in front of the 4.34 MB server graph (measured 2026-07-24). Both call sites must stay dependency-free until their checks pass.
- Bug fixes require red→fix→green evidence, with both outputs pasted into the PR body. If you cannot reproduce, stop and report the dead end — do not ship a speculative fix.
- Never report done off a green typecheck. Boot it, exercise every branch you touched, clean up test data. If "compiles" is all you ran, say so explicitly.
- Gates are non-negotiable (sequence in "Ship a change" below). `make pre-pr` builds first — that build step is what protects against a stale-dist false green. `make review` is an LLM verdict only: it does NOT run typecheck/knip/tests and is not proof CI will pass.
- The agent-facing product name is **Behavior**; `watcher` is internal engine/DB vocabulary. It must not appear in MCP tool schemas/names/descriptions, ClientSDK discovery metadata, or the connector-sdk public reaction contract — `make pre-pr` fails on it. Internal identifiers (`actingWatcherId`, table/column names, comments) are fine.
- `make review-fix` is the unposted fixer pass and runs BEFORE the first `make review`; verify its diff and commit it. Never iterate `make review` as a find-fix loop — each posted round costs a review + CI cycle.
- Fix the class, not the instance: on the first hit, grep every other instance and fix in one pass — a diff-scoped reviewer only ever finds the next one. Same root cause twice = stop reviewing, grep-enumerate. A class-wide fix is in scope for the branch that found it and does not count as scope creep.
- **Stage by explicit path; never commit the whole tree of a worktree that hosted other work.** A commit is a snapshot — stale file copies silently revert already-merged PRs. After commit/rebase, `git diff --name-only origin/main...HEAD` must equal the task's intended file list; extra files = stop. Verify a "reverts merged work" review finding by diff direction against `origin/main`, never dismiss it as merge-base noise.

## Ship a change
1. `make task-setup NAME=<slug>` → work in `.claude/worktrees/<slug>/`.
2. Reproduce the bug (red) before fixing it. Fix, then prove green.
3. Test: `make test-unit` (no DB) / `make test-integration` (needs `DATABASE_URL` with pgvector). One file: `bun test <path>`, or `cd packages/server && bunx vitest run <path>` for vitest suites.
4. `make pre-pr` — build, typecheck, knip, lint, exposed-surface naming.
5. `make review-fix` on the settled diff and verify what it changed — it edits the working tree, so re-read the files before trusting them.
6. Stage by explicit path (`git add -- <paths>`, never `-A`), commit, then confirm `git diff --name-only origin/main...HEAD` is exactly your intended file list. Extra files = stop.
7. `git push -u origin <branch>` → `gh pr create` (fill `.github/pull_request_template.md`; conventional-commit title, e.g. `fix(server): …`).
8. `make review` **once** on the settled HEAD. It posts the `pi-review` status, which is a REQUIRED check.
9. Merge squash once CI is green: `gh pr merge <n> --squash --admin`. Never `--admin` past a check that has not reported.
10. Prod-visible surface? Verify it live after rollout. Set a self-rescheduling `ScheduleWakeup` (~1500s) carrying the rollout gate: poll the deployed SHA, then `git merge-base --is-ancestor "$MERGE_SHA" "$DEPLOYED_SHA"` with `MERGE_SHA=$(gh pr view <n> --json mergeCommit --jq .mergeCommit.oid)`. Two ways this gate silently never opens — **gate on the squash commit, not your branch head** (a squash merge writes a new commit with no ancestry link to the branch, so the branch head exits 1 forever: PR #2280 has identical trees and still fails), and **keep that argument order** (merge commit first; reversed, it accepts a stale deploy). Run the live check when it lands, and write the result back to memory.

## Agent workflow
- Do only what was asked. Delete ephemeral files you create. Do not create `*.md` unless asked.
- Prefer `bun`; do not use npm/yarn/pnpm for repo work.
- Fix unused params by deleting them, not `_`-prefixing.
- Never `git stash`; use WIP commits and squash later.
- Never resolve merge conflicts in the GitHub web UI (it has silently dropped 1000+ lines of feature work). Rebase locally against `origin/main`, then diff against the last real feature commit before squashing — except on submodule-pointer branches, where you must `git merge` (see `docs/GOTCHAS.md`, "Submodule & cross-repo").
- Run mandated gates automatically; never ask permission to run one.
- Show the diff, not a summary. Before claiming done — on your own work or a dispatched agent's — surface `git status` plus `git diff --stat <base>...HEAD`. An agent's self-report is a claim; the diff is the evidence.
- UI PRs owe before/after screenshots, and `gh` cannot upload images inline. Capture before shots from the unmodified branch and after shots from the same booted app (auth recipe in `docs/BROWSER_TESTING.md`), base64-embed the PNGs into one self-contained HTML comparison page, publish it as a claude.ai artifact, and link it from the PR.
- Any subagent with write access (Edit/Write/Bash) runs in its own worktree; only grep/read agents share the parent. Two writing agents must NEVER share a worktree — they overwrite each other's uncommitted work.
- Dispatch code-writing agents through `make task-setup NAME=<slug>` and brief them with the absolute `.claude/worktrees/<slug>/` path. Only task-setup does the submodule branch pinning, post-init `bun install`, `.env` copy, and port allocation.
- Do repetitive multi-file edits (renames, signature changes, import rewrites) inline or with one script. Reserve subagents for read-only breadth or genuinely isolated parallel work.
- Before adding an env var, grep for the one the codebase already reads. Do not rename existing vars to a "cleaner" convention unasked.
- Deleting code needs structural evidence (dangling import, completed migration, superseded impl). Low prod usage is not a delete signal; trace the workflow, not just the import graph — docs and help text are load-bearing too.
- **Absence is never proven by a grep on a working tree.** To prove code does *not* exist, run `git fetch -q origin && git grep <pattern> origin/main` — the fetch is load-bearing, `origin/main` itself goes stale. Applies to every existence check, including the deletion-evidence rule above.
- Slack link pasted (`slack.com/archives/…?thread_ts=`) → run `scripts/slack-thread-viewer.js "<link>"` first.
- To drive the user's real logged-in browser, use the paired Owletto extension — recipe in `docs/BROWSER_TESTING.md`. Do **not** assume CDP/browser-auth is required.
- Unsure in planning → ask before making conflicting or irreversible choices. Mid-execution, block on a question only for irreversible/destructive actions or decisions that are genuinely the user's; for reversible choices with a clear recommended option, take it and flag the choice in your summary.

## Session efficiency
- Never poll in the foreground (`sleep`/`until`/`while` wait loops, repeated `tail`). Run long waits (dev-server boot, CI, deploys) in the background and act on the completion notification.
- Prefer DOM reads (`get_page_text`, `read_page`, `javascript_tool`) over screenshots; screenshot only when visual layout itself is under test. Screenshots are the #1 context-bloat source.
- Read a file before editing it, and re-read it after any external change (a fixer pass, another agent, a rebase). Blind edits fail and cost a retry round-trip.
- Read PR status compactly: `gh pr view <n> --json number,title,isDraft,mergeStateStatus,reviewDecision` plus `gh pr checks <n> --required`. Never `--json statusCheckRollup` — measured on PR 2280 it is 7520 bytes against 861, 8.7x larger and less legible.
- Batch narrow fixes into one commit, verified once at the end of the batch — not per fix. It never justifies skipping a reproducer or a correctness-critical test. For a one-line or config-only change, take one CI snapshot and move on.
