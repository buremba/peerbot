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
pnpm dev:all   # docker compose up + watch
```

Do not start services individually unless debugging.

## Validation Order

1. `pnpm typecheck`
2. `pnpm lint`
3. `SKIP_TEST_DB_SETUP=1 pnpm vitest run`
4. `docker compose -f docker-compose.dev.yml build app` (if Dockerfile/deps changed)

Package manager: **pnpm** (not npm, yarn, or bun). Ignore `dist/` directories — work from source.

## Constraints

- All rules in `CLAUDE.md` apply.
- No backwards compatibility required.
- Do not create documentation files unless explicitly requested.
- Zero hardcoding: all behavior is data-driven.
