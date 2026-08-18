<!-- Rules for agents (Claude, pi, codex); CLAUDE.md inlines this into every session. Keep it to facts an agent cannot derive and boundaries it must not cross. Reasoning and recipes go in docs/AGENT_PLAYBOOK.md, package specifics in the nearest package AGENTS.md. -->

## Repo map
- Bun workspace under `packages/*`; TS source in `src`, tests in `__tests__`.
- `core` types/utils · `plugin-api` plugin contracts · `plugin-host` plugin composition · `server` gateway + embedded runtime · `agent-worker` agent execution · `connectors` built-in connectors · `owletto` frontend submodule.
- Read the nearest package `AGENTS.md` before editing that package; grep `docs/GOTCHAS.md` when something looks inexplicable.

## Unrecoverable — never do these
- **Never write to `~/Code/lobu` directly.** Run `make task-setup NAME=<slug>` first, and never `git switch` in the main checkout — other sessions share it. For a pure submodule-pointer bump, `make bump SUBMODULE=packages/owletto` is the lightweight isolated-worktree exception; it also posts the required statuses.
- **Stage by explicit path** (`git add -- <paths>`, never `-A`). A commit is a snapshot, so a stale file copy left by earlier work in the same worktree silently reverts merged PRs. After commit/rebase, `git diff --name-only origin/main...HEAD` must equal your intended file list; extras = stop.
- **`events` is append-only.** Never `DELETE FROM events`; tombstone or supersede instead.
- **Never bulk-delete prod `organization` rows**, including zero-activity ones — empty-looking orgs are usually real signups. Surface them one at a time for confirmation.
- **Never resolve merge conflicts in the GitHub web UI** — it has silently dropped 1000+ lines of feature work. Rebase locally against `origin/main`; submodule-pointer branches `git merge` instead (`docs/GOTCHAS.md`).
- **Two writing agents must never share a worktree** — they overwrite each other's uncommitted work. Every subagent with Edit/Write/Bash gets its own through `make task-setup` (only task-setup does submodule pinning, `bun install`, `.env` copy, and port allocation); only read-only agents share the parent.
- **Never add a table or change DB design, API surface, or SDK surface** without surfacing the proposal and receiving confirmation first.
- **Never auto-submit an interactive browser draft, in any package.** Drafts are page-activated: persist the operation, notify normally, and let the extension activate the run only when the user visits a pending URL in a user-owned tab. Only scrape-owned scratch tabs may be opened and closed automatically. Server, connector, and Owletto code all obey this (`packages/server/AGENTS.md`).

## Facts you cannot derive
- **`events.id` is a stored-version id, not stable source identity.** A resync supersedes the row and mints a new id for the same source item, so cross-sync identity and dedupe must key on the connector's `origin_id` (scoped to its connection/source) or an explicit domain key.
- **Request paths never aggregate history.** No `GROUP BY`, `DISTINCT ON`, per-row `regexp_*`, or leading-wildcard `LIKE` over `events`, `agent_transcript_snapshot`, `session_calls`, … on a user-facing read path: history grows, the answer doesn't. Materialize at write time, read back by index, backfill in a migration. Bounded config tables (`connections`, `automations`, `agent_users`) are fine.
- **Shared state must be Postgres-mediated.** An in-memory Map or singleton is invisible to other replicas — correct in dev, broken in prod.
- **Workers never receive real credentials** — placeholders or proxied access only. The exceptions are device-pinned connectors and short-lived provider-derived leases (`packages/server/AGENTS.md`); a durable stored credential is never one.
- **Automation is the product, API, and storage vocabulary.** Use it consistently in public contracts and internal identifiers; `make pre-pr`'s exposed-surface naming gate rejects retired product and engine terminology.
- **`make review` is the semantic review gate, not CI.** It runs no typecheck, knip, or tests; a verdict or safe-class skip is not evidence CI will pass.
- **GitHub CI is the canonical gate** — free on this public repo, full graph in ~5–7 min per PR. `make pre-pr` (local fast gates: typecheck, knip, lint, naming) catches the cheap misses before push; `make review` verifies CI is green for HEAD. `make pre-pr-remote` (Depot) is optional tooling, not part of the required loop.
- Default to static `import`; a new production dynamic import needs measured justification plus a call-site rationale comment. Tests may import dynamically after mocks; two Node-version gates are grandfathered (playbook).

## Ship a change
1. `make task-setup NAME=<slug>` → work in `.claude/worktrees/<slug>/`.
2. Reproduce red → fix → prove green, and paste both outputs in the PR. Cannot reproduce = report the dead end; never ship a speculative fix.
3. Iterate on focused tests: `bun test <path>`, or `cd packages/server && bunx vitest run <path>` for vitest suites. `make pre-pr` catches the cheap common misses; the full graph runs on GitHub CI for the PR.
4. `make review-fix` on the settled diff, then re-read what it touched. Safe-class changes self-skip before selecting an LLM. Otherwise it runs BEFORE the first `make review` — never iterate `make review` as a find-fix loop, since each posted round costs a review + CI cycle.
5. Stage by explicit path, then commit and push; GitHub CI is the gate. `make review` fails unless CI is green for HEAD (override: `REVIEW_ALLOW_LOCAL_BUILD=1`).
6. Commit, then confirm `git diff --name-only origin/main...HEAD` is exactly your intended file list.
7. `git push -u origin <branch>` → `gh pr create` (fill `.github/pull_request_template.md`; conventional-commit title).
8. `make review` **once** on the settled HEAD; it posts the required `pi-review` status. Narrow path/content-gated safe classes skip the cross-harness review; this includes pure `packages/owletto` pointer bumps and exact `model:` literal swaps, but not mixed runtime and source changes. The submodule's own repo owns its content review.
9. `make ui-review`. Non-Owletto changes and complete, forward-only Owletto pointer diffs confined to `deploy/` pass as not applicable; other pointer changes need exact hosted proof (`ARTIFACT=<url>`; see the playbook).
10. `gh pr merge <n> --squash --admin` once green — never `--admin` past a check that has not reported. Lobu's required `integration` fan-in is absent from `gh pr checks` until it starts, not pending, so diff against the branch-protection list (playbook).
11. Prod-visible surface? Verify live after rollout: gate on the **squash commit**, not your branch head, keeping the argument order `git merge-base --is-ancestor "$MERGE_SHA" "$DEPLOYED_SHA"`. Record the result.

## How to work
- Do only what was asked. Delete ephemeral files you create; no new `*.md` unless asked.
- Run mandated gates automatically; never ask permission to run one.
- **Evidence, not assertion.** Never report done off a green typecheck — boot it, exercise every branch you touched, and clean up test data; if "compiles" is all you ran, say so. Show `git status` plus `git diff --stat <base>...HEAD`, including for a dispatched agent's work.
- **Absence needs `origin/main`:** `git fetch -q origin && git grep <pattern> origin/main`. A working-tree grep proves nothing, and the fetch is load-bearing.
- Deleting code needs structural evidence — a dangling import, a completed migration, a superseded implementation. Low prod usage is not evidence, and docs and help text are load-bearing.
- Fix the class, not the instance: on the first hit, grep every other occurrence and fix in one pass. A diff-scoped reviewer only ever finds the next one.
- One branch = one concern. Never `git stash`; use WIP commits.
- Prefer `bun`, never npm/yarn/pnpm. Before adding an env var, grep for the one already read, and do not rename existing vars unasked.
- Block only on irreversible or destructive actions and decisions genuinely the user's; otherwise take the recommended option and flag it in your summary.
- Never poll in the foreground — run long waits in the background and act on the notification. Poll delegated CLIs at most once every 4.5 minutes unless they finish or request input.
- Prefer DOM reads over screenshots, the top context-bloat source. The paired Owletto extension drives the user's real logged-in browser; CDP is not required (`docs/BROWSER_TESTING.md`).
- Slack link pasted → run `scripts/slack-thread-viewer.js "<link>"` first.
