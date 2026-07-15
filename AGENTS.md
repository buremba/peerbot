<!-- Project rules for agents (Claude, pi, codex). CLAUDE.md inlines this into every session — keep this file lean. Put package-specific detail in the nearest package AGENTS.md. -->

## Repo map
- Bun workspace under `packages/*`; TS source is in `src`, tests in `__tests__`.
- Main packages: `core` shared types/utils, `plugin-api` native plugin contracts, `plugin-host` deterministic plugin composition, `server` gateway + embedded runtime, `agent-worker` Lobu agent execution, `connectors` built-in connectors, `owletto` frontend submodule.
- Before editing a package, read its nearest `AGENTS.md` if present.

## Hard invariants
- **Never write to `~/Code/lobu` directly — work in a worktree.** Run `make task-setup NAME=<slug>` first. Keep `main` on `main`.
- One branch = one concern. If a tangential task appears, commit/push/open current work, then branch fresh from `main`.
- **Multi-replica correctness is mandatory.** Never put shared required state in an in-memory Map/singleton another replica must read or mutate. If a feature relies on cross-pod visibility, use Postgres-mediated state/signal.
- **`events` is append-only.** Never `DELETE FROM events`; tombstone/supersede instead.
- **Workers never receive real credentials.** They may receive only placeholders/proxied access.
- Default to static `import`. New dynamic imports require measured cost justification here or in the package AGENTS plus a rationale comment at the call site. Tests may dynamically import after mocks.
- Bug fixes require red→fix→green evidence. If you cannot reproduce, bail and report the dead end.
- Run `make pre-pr` (fast no-DB CI gates: typecheck + knip + lint) AND `make review` (LLM verdict) before PR/merge. `make review` does NOT run typecheck/knip/tests — it is not proof CI will pass. If you touch server/runtime code, also run the relevant `bun test`/`make test-integration` suite.
- After committing a fix, verify it landed with `git show HEAD:<file>` (or `git diff --stat origin/main...HEAD`). A fix left in the working tree but never committed will not reach CI — confirm HEAD, not just the working tree.
- **Stage by explicit path; never commit the whole tree of a worktree that hosted other work.** A commit is a snapshot — stale file copies silently revert already-merged PRs. After commit/rebase, `git diff --name-only origin/main...HEAD` must equal the task's intended file list; extra files = stop. Verify a "reverts merged work" review finding by diff direction against `origin/main`, never dismiss it as merge-base noise.

## Agent workflow
- Do only what was asked. Delete ephemeral files you create. Do not create `*.md` unless asked.
- Prefer `bun`; do not use npm/yarn/pnpm for repo work.
- Fix unused params by deleting them, not `_`-prefixing.
- Never `git stash`; use WIP commits and squash later.
- Subagents that may switch/commit/push/destroy must run in a worktree; read-only research may share the parent.
- Slack link pasted (`slack.com/archives/…?thread_ts=`) → run `scripts/slack-thread-viewer.js "<link>"` first.
- To drive the user's paired Owletto Chrome extension/browser, use Lobu Cloud `manage_operations` on the active `chrome` connection (usually org `buremba`, connection id from `lobu call manage_connections --org buremba --arg action=list --raw`). Useful operations include `navigate`, `get_accessibility_tree`, `type_ref`, `click_ref`, `evaluate`, and `screenshot`; do **not** assume CDP/browser-auth is required. Example: `lobu call manage_operations --org buremba --arg action=execute --arg connection_id:=<chrome-connection-id> --arg operation_key=navigate --arg input:='{"url":"https://app.slack.com/...","wait_for_load":true,"open_in_new_tab":true}' --raw`.
- Unsure in planning → ask before making conflicting or irreversible choices.
