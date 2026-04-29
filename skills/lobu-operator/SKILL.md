---
name: lobu-operator
description: Repo-specific operational skill for Lobu-managed agents working inside this repository. Covers dev workflow, build commands, validation, and repo constraints.
---

# Lobu Operator — Repo Guide

For external coding-agent orientation, see `CLAUDE.md`.

## Before You Act

1. Read `lobu.toml` for workspace configuration.
2. List agent directories to know which agents are defined.
3. Check enabled skills — capabilities depend on workspace config.

Do not assume the repo layout. Inspect it.

## Dev Workflow

```bash
make dev   # boots the embedded Lobu stack (gateway + workers + Vite HMR)
```

Requires local Redis on `:6379` and `DATABASE_URL` reachable in `.env`.

## Validation Order

1. `bun run typecheck`
2. `bun run check`
3. `bun test packages/<changed-package>/src`
4. `make build-packages` if `packages/{core,gateway,worker,cli}/*` changed

Package manager: **bun** (not npm, yarn, or pnpm). Ignore `dist/` directories — work from source.

## Constraints

- All rules in `CLAUDE.md` and `AGENTS.md` apply.
- No backwards compatibility required.
- Do not create documentation files unless explicitly requested.
- Zero hardcoding: all behavior is data-driven.
