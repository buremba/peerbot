---
name: lobu-operator
description: Repo-specific operational skill for Lobu-managed agents working inside this repository. Covers dev workflow, build commands, validation, and repo constraints.
---

# Lobu Operator — Repo Guide

`CLAUDE.md` (which includes `AGENTS.md`) is the source of truth for this repo's layout, build system, validation, and constraints. Read those first — this skill is just a fast index.

## Before You Act

1. Read `CLAUDE.md` and `AGENTS.md`.
2. Read `lobu.toml` for workspace configuration.
3. Inspect the agent directories and enabled `skills/` — the layout is data-driven, don't assume it.

## Dev Workflow

```bash
./scripts/setup-dev.sh   # first-time setup (builds packages, checks bun)
make dev                 # embedded gateway + workers + Vite HMR on :8787
make clean-workers       # kill orphaned worker subprocesses
```

Prerequisites: Bun, Node 22.x–24.x, and a reachable Postgres (with pgvector) via `DATABASE_URL` in `.env`. There is no Redis and no Docker/Kubernetes — everything runs in one embedded Node process.

## Validation

| Change | Command |
| --- | --- |
| `packages/landing/*` | `cd packages/landing && bun run build` |
| `packages/{core,server,agent-worker,cli}/*` | `make build-packages` |
| Broad TS check | `bun run typecheck` |
| Any package source | `bun test packages/<pkg>/src` |
| Lint / format | `bun run check` (or `check:fix`) |

After editing `packages/agent-worker/*`, run `make clean-workers`.

## Constraints

- All rules in `CLAUDE.md` and `AGENTS.md` apply.
- Package manager is **bun** — never npm/yarn/pnpm. Ignore `dist/` directories; work from source.
- No backwards-compat shims. Don't create `*.md` files unless explicitly asked. Zero hardcoding — behavior is data-driven.
