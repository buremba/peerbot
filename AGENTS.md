<!-- Project rules for agents (Claude, pi, codex). CLAUDE.md inlines this into every session — keep this file lean. Put package-specific detail in the nearest package AGENTS.md. -->

## Repo map
- Bun workspace under `packages/*`; TS source is in `src`, tests in `__tests__`.
- Main packages: `core` shared types/utils, `server` gateway + embedded runtime, `agent-worker` OpenClaw execution, `connectors` built-in connectors, `owletto` frontend submodule.
- Before editing a package, read its nearest `AGENTS.md` if present.

## Hard invariants
- **Never write to `~/Code/lobu` directly — work in a worktree.** Run `make task-setup NAME=<slug>` first. Keep `main` on `main`.
- One branch = one concern. If a tangential task appears, commit/push/open current work, then branch fresh from `main`.
- **Multi-replica correctness is mandatory.** Never put shared required state in an in-memory Map/singleton another replica must read or mutate. If a feature relies on cross-pod visibility, use Postgres-mediated state/signal.
- **`events` is append-only.** Never `DELETE FROM events`; tombstone/supersede instead.
- **Workers never receive real credentials.** They may receive only placeholders/proxied access.
- Default to static `import`. New dynamic imports require measured cost justification here or in the package AGENTS plus a rationale comment at the call site. Tests may dynamically import after mocks.
- Bug fixes require red→fix→green evidence. If you cannot reproduce, bail and report the dead end.
- Run `make review` before PR/merge.

## Agent workflow
- Do only what was asked. Delete ephemeral files you create. Do not create `*.md` unless asked.
- Prefer `bun`; do not use npm/yarn/pnpm for repo work.
- Fix unused params by deleting them, not `_`-prefixing.
- Never `git stash`; use WIP commits and squash later.
- Subagents that may switch/commit/push/destroy must run in a worktree; read-only research may share the parent.
- Slack link pasted (`slack.com/archives/…?thread_ts=`) → run `scripts/slack-thread-viewer.js "<link>"` first.
- Unsure in planning → ask before making conflicting or irreversible choices.
