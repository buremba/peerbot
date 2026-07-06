---
name: lobu-operator
description: Repo-specific operational skill for Lobu-managed agents working inside this repository. Covers dev workflow, build commands, validation, and repo constraints.
---

# Lobu Operator — Repo Guide

`CLAUDE.md` includes the root `AGENTS.md`; package directories may have their own `AGENTS.md`. Those files are the source of truth. This skill is only a fast index.

## Before You Act

1. Read `CLAUDE.md` and root `AGENTS.md`.
2. Before editing a package, read that package's nearest `AGENTS.md`.
3. Read `lobu.config.ts` for workspace configuration when behavior/config matters.
4. Inspect agent directories and enabled `skills/`; the layout is data-driven.

## Dev Workflow

```bash
make task-setup NAME=<slug>  # create a worktree before editing
./scripts/setup-dev.sh       # first-time setup
make dev                     # gateway + workers + Vite on the worktree port
make clean-workers           # kill orphaned worker subprocesses
```

Prerequisites: Bun, supported Node per package engines, and Postgres+pgvector via `DATABASE_URL`. `make dev` uses the shared local Postgres; `make dev-embedded` uses embedded per-worktree Postgres. Production can run multiple app replicas, so server code must be multi-replica safe.

## Validation

| Change | Command |
| --- | --- |
| `packages/{core,server,agent-worker,cli}/*` | `make build-packages` |
| Broad TS check | `bun run typecheck` |
| Any package source | `bun test packages/<pkg>/src` |
| Lint / format | `bun run check` (or `check:fix`) |

After editing `packages/agent-worker/*`, run `make clean-workers`.

## Constraints

- All rules in `CLAUDE.md`, root `AGENTS.md`, and nearest package `AGENTS.md` apply.
- Package manager is **bun** — never npm/yarn/pnpm for repo work. Ignore `dist/`; work from source.
- No backwards-compat shims unless explicitly requested. Zero hardcoding — behavior is data-driven.

## Data Integration & Knowledge Ingestion

When importing data or integrating services with Lobu, adhere to these architectural patterns:

- **Connectors & Feeds:** The preferred way to integrate live third-party data (e.g., Google Calendar, Slack). Instead of one-off static imports, use Connectors.
- **Virtual Feeds & Federation:** For systems with high data velocity (like calendar events or email), map the live API endpoints directly into Lobu as Virtual Feeds rather than storing every event locally.
- **`seed` Method:** Useful for isolated prototyping, but avoid it for bulk processing since it only saves one item at a time.
- **`knowledge.save`:** The go-to SDK method for bulk historical streaming of schema-less, semantic, unstructured events (e.g., `video_watch`, `direct_message`, `note`). It automatically processes and maps meaning without needing strict schemas upfront.
- **`entities.create` / `entities.update`:** Use these only for highly structured data that matches strict, predefined schemas (e.g., `person`, `company`). If bulk uploading, wrap in `Promise.allSettled` or chunked executions to handle conflicts smoothly.
- **`run_sdk` (lobu memory exec):** The standard CLI tool to securely prototype and execute SDK interactions on the production knowledge graph in sandboxed JS chunks. Example usage: `lobu memory exec 'export default async (ctx, client) => { return await client.knowledge.save({semantic_type: "...", content: "...", metadata: {...}}); }'`.
