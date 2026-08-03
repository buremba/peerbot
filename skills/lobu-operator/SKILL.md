---
name: lobu-operator
description: Contribute safely to the Lobu monorepo: worktrees, package rules, red-to-green fixes, validation gates, SDK-first operations, PRs, and rollout checks.
---

# Lobu Operator — Repo Guide

This is a fast index, not a replacement for repository instructions. Root `AGENTS.md` and the nearest package `AGENTS.md` are authoritative; `CLAUDE.md` includes the root rules for Claude sessions.

## Before You Act

1. Read root `AGENTS.md`, the touched package's nearest `AGENTS.md`, and the relevant `docs/GOTCHAS.md` section.
2. Run `make task-setup NAME=<slug>` and work only in the resulting `.claude/worktrees/<slug>/` directory. Never switch branches or edit in the main checkout.
3. Read `lobu.config.ts` when configuration or runtime behavior matters; inspect the active agent and skill directories because composition is data-driven.
4. Reproduce a bug before changing code. Capture red→fix→green evidence and exercise every branch touched; a typecheck alone is not completion.

## Dev Workflow

```bash
make task-setup NAME=<slug>
cd .claude/worktrees/<slug>
make dev                  # gateway + workers + Vite on the allocated port
make clean-workers        # after agent-worker changes
```

Prerequisites are Bun, the supported Node version, and Postgres with pgvector via `DATABASE_URL`. `make dev` uses the shared local Postgres; `make dev-embedded` uses per-worktree embedded Postgres. Read `.env.local` for the allocated ports.

## Correctness Invariants

- Design for at least three replicas. Shared required state and cross-pod signals belong in Postgres, never a process-local singleton or `Map`.
- `events` is append-only. Replace or hide records with superseding/tombstone events; never delete history.
- User-facing reads must not aggregate growing history. Materialize bounded answers on writes and read them back by index.
- Never bulk-delete production organizations. Treat apparently empty organizations as real signups requiring individual confirmation.
- Workers receive placeholders/proxied access, device-pinned credentials, or short-lived provider-derived leases—never durable stored credentials.
- Agent-facing vocabulary always says **Behavior**; engine-only vocabulary stays internal.
- Durable dispatch and delivery failures fail closed. Retry, defer, or surface terminal failure; never reinterpret an ambiguous coordination error as permission to proceed.

## Validate and Ship

Run focused tests while iterating, then the settled-diff gates in this order:

```bash
make build-packages                 # before checks that consume workspace dist
bun test <path>                     # focused unit test
make test-unit                      # or make test-integration with DATABASE_URL
make pre-pr                         # build, typecheck, knip, lint, surface naming
make review-fix                     # unposted fixer pass; inspect its edits
git add -- <paths>                  # explicit paths only, never -A
git commit -m '<type>(<scope>): <summary>'
git diff --name-only origin/main...HEAD
git push -u origin <branch>
gh pr create
make review                         # once, on settled HEAD
gh pr checks <number> --required
gh pr merge <number> --squash --admin
```

Never bypass a check that has not reported. For a production-visible change, wait for deployment and prove the PR's squash merge commit is an ancestor of the deployed SHA before running the live check. Clean up the task worktree with `make task-clean` after merge.

## Data Integration & Knowledge Ingestion

- Discover the current ClientSDK with `search_sdk`; use `query_sdk` for reads and `run_sdk` / `lobu memory exec` for writes.
- Connectors plus feeds are the normal integration path. Use `connections.connect`, follow any `setup_required` continuation, then create and trigger a feed with `feeds.create` and `feeds.trigger`.
- Find connector actions with `operations.listAvailable` and execute the returned target with `operations.execute`; do not guess operation or connection identifiers.
- Use `knowledge.save` for schema-less semantic history and `entities.create` / `entities.update` for strict structured records. Chunk bulk work and use `Promise.allSettled` so conflicts are explicit.
- `lobu memory seed` is suitable for small declarative YAML datasets, not large backfills.
