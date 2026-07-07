# Development Makefile for Lobu

.PHONY: help setup build test clean dev dev-db dev-embedded build-packages ensure-submodule clean-workers clean-test-pg test-unit test-integration test-e2e test-e2e-sdk test-e2e-cli test-providers-live typecheck task-setup task-clean dev-recover clean-merged e2e-browser bump review

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup                                 - Setup development environment (run once)"
	@echo "  make dev [NAME=<x>] [FROM=<db>] [OPEN=1]   - Local dev (brew Postgres@18); prints App URL; OPEN=1 opens it in the system browser after boot"
	@echo "  make dev-embedded                          - Dev against the zero-dependency embedded per-worktree Postgres (the lobu run / CI runtime); == LOBU_EMBEDDED=1 make dev"
	@echo "  make build-packages                        - Build all TypeScript packages"
	@echo "  make test                                  - Run test bot"
	@echo "  make test-unit                             - Run the CI unit suite (no Postgres needed)"
	@echo "  make test-integration                      - Run the CI integration suite (needs DATABASE_URL with pgvector)"
	@echo "  make test-e2e                              - Boot the dev server + run openclaw-plugin e2e against it"
	@echo "  make test-e2e-cli                          - Boot lobu run + walk every CLI command (the CI cli-smoke gate)"
	@echo "  make test-providers-live                   - Validate every provider against its live API (keyless tier + key-gated smoke)"
	@echo "  make clean-workers                         - Stop any running embedded worker subprocesses"
	@echo "  make dev-recover [RESTART=1]               - Free this checkout's dev ports + clean workers; RESTART=1 also boots make dev"
	@echo "  make clean-test-pg                         - Reap orphaned lobu-test-pg embedded-Postgres clusters (frees macOS shm slots)"
	@echo "  make typecheck                             - Strict typecheck (same as Dockerfile) for server + owletto"
	@echo "  make task-setup NAME=<name> [CONTEXT=1]    - Create a paired worktree at .claude/worktrees/<name> (lobu + submodule, .env/ports; opens a Herdr workspace when herdr is on PATH; HERDR=0 to skip; CONTEXT=1 registers Lobu CLI context)"
	@echo "  make task-clean NAME=<name> [FORCE=1]      - Remove the worktree, both branches, and the Lobu context (refuses if there's uncommitted/unpushed work unless FORCE=1)"
	@echo "  make e2e-browser [RESTART=1]               - Launch/reuse the stable 'owletto' Chrome harness (extension from this worktree) for Chrome e2e"
	@echo "  make bump SUBMODULE=<path> [TARGET=<ref>]  - Lightweight worktree + commit + PR for a trivial submodule pointer bump (skips bun install, .env, ports)"
	@echo "  make review [BASE=<branch>]                - Run local review (typecheck+unit+integration + Claude); posts pi-review status and PR comment"

# Strict typecheck — mirrors the Dockerfile so local matches CI. Catches
# what `build-packages` (relaxed, bundler-only) misses.
typecheck:
	@echo "🔎 Strict typecheck: packages/server..."
	@( cd packages/server && bunx tsc --noEmit ) || exit $$?
	@if [ -d packages/owletto/src ]; then \
		echo "🔎 Strict typecheck: packages/owletto..."; \
		( cd packages/owletto && bunx tsc -b --noEmit ) || exit $$?; \
	fi
	@echo "✅ Typecheck clean."

# Build all TypeScript packages in dependency order
build-packages:
	@echo "📦 Building all TypeScript packages..."
	@for pkg in core pgvector-embedded connector-sdk client agent-worker openclaw-plugin embeddings connector-worker promptfoo-provider; do \
		echo "   📦 Building packages/$$pkg..."; \
		( cd packages/$$pkg && bun run build ) || exit $$?; \
	done
	@echo "   📦 Building packages/server bundle..."
	@( cd packages/server && bun run build:server ) || exit $$?
	@if [ -f packages/owletto/package.json ]; then \
		echo "   📦 Building packages/owletto (web UI)..."; \
		( cd packages/owletto && bun run build ) || exit $$?; \
	else \
		echo "   ⚠️  packages/owletto absent — CLI will ship headless (API only)"; \
	fi
	@echo "   📦 Building packages/cli..."
	@( cd packages/cli && bun run build ) || exit $$?
	@echo "✅ All packages built successfully!"

# Ensure packages/owletto is initialized; warn on drift but don't auto-fix
# (drift may be active feature-branch work — clobbering it silently is worse than the warning).
ensure-submodule:
	@status=$$(git submodule status packages/owletto 2>/dev/null || true); \
	case "$$status" in \
		'-'*) echo ">> owletto submodule not initialized — running git submodule update --init --recursive"; \
		      git submodule update --init --recursive packages/owletto ;; \
		'+'*) echo ">> WARNING: packages/owletto is at a different SHA than the parent pin:"; \
		      echo "   $$status"; \
		      echo "   If this is unintentional, run: git submodule update packages/owletto" ;; \
		*) ;; \
	esac

# Local dev against the shared brew Postgres@18 (via dev-db.sh: one database per
# branch). This is the default because a single long-lived postmaster avoids the
# embedded per-worktree clusters whose kill-9 churn leaks SysV shm anchors into
# macOS's shmmni=32 cap. `LOBU_EMBEDDED=1 make dev` (or `make dev-embedded`) runs
# the zero-dependency embedded cluster instead — the `lobu run` / CI runtime.
dev: ensure-submodule
	@if [ -n "$$LOBU_EMBEDDED" ] && [ "$$LOBU_EMBEDDED" != "0" ]; then \
		./scripts/dev-native.sh; \
	else \
		NAME="$(NAME)" FROM="$(FROM)" PORT="$(PORT)" WORKER_PROXY_PORT="$(WORKER_PROXY_PORT)" PGHOST="$(PGHOST)" PGPORT="$(PGPORT)" PGUSER="$(PGUSER)" ./scripts/dev-db.sh; \
	fi

# Zero-dependency embedded per-worktree Postgres (the lobu run / CI runtime).
dev-embedded: ensure-submodule
	@./scripts/dev-native.sh

# Explicit alias for the default `make dev` backend (shared brew Postgres@18, one
# database per branch). NAME defaults to the current branch; FROM=<db> forks an
# existing dataset for a disposable preview.
#   make dev-db NAME=sidebar
#   make dev-db NAME=preview FROM=owletto_local
#   make dev-db NAME=sidebar PORT=8931 WORKER_PROXY_PORT=8131
dev-db: ensure-submodule
	@NAME="$(NAME)" FROM="$(FROM)" PORT="$(PORT)" WORKER_PROXY_PORT="$(WORKER_PROXY_PORT)" PGHOST="$(PGHOST)" PGPORT="$(PGPORT)" PGUSER="$(PGUSER)" ./scripts/dev-db.sh

# Setup development environment (run once)
setup:
	@./scripts/setup-dev.sh

# Run test bot
test:
	@./scripts/test-bot.sh "@me test from make command"

# --- Task worktrees ---------------------------------------------------------
# Paired-branch worktrees for parallel work without losing changes to the
# packages/owletto submodule. See scripts/task-setup.sh header for details
# (the script also documents an optional `task-start` shell function alias).

task-setup:
	@: $${NAME?Usage: make task-setup NAME=<kebab-case-name> [CONTEXT=1]}
	@CONTEXT="$(CONTEXT)" ./scripts/task-setup.sh "$(NAME)" $$( [ "$(CONTEXT)" = "1" ] && echo --context )

task-clean:
	@: $${NAME?Usage: make task-clean NAME=<name> [FORCE=1]}
	@./scripts/task-clean.sh "$(NAME)" $$( [ "$(FORCE)" = "1" ] && echo --force )

# Reap task worktrees whose PR is already merged (worktree + branches + dev DB
# + Lobu context). Dry-run by default — prints what it would remove; pass
# APPLY=1 to actually run task-clean on each. Squash-merge-safe: gates on the
# GitHub PR state, not git ancestry.
clean-merged:
	@./scripts/clean-merged.sh $$( [ "$(APPLY)" = "1" ] && echo --apply )

dev-recover:
	@RESTART="$(RESTART)" ./scripts/dev-recover.sh

# Stable Owletto Chrome harness for e2e: one persistent profile, paired once,
# reused from any agent session (mirrors the installed Mac app). Loads the
# extension from the current worktree; RESTART=1 forces a fresh launch.
e2e-browser:
	@./scripts/e2e-browser.sh $$( [ "$(RESTART)" = "1" ] && echo --restart )

# Lightweight shortcut for "trivial submodule pointer bump" work. Creates a
# minimal worktree (no bun install, no .env copy, no port allocation), advances
# the submodule, opens an auto-merge PR. For agent work that also touches
# submodule *code*, use `make task-setup` instead — it sets up the full env.
bump:
	@: $${SUBMODULE?Usage: make bump SUBMODULE=<path> [TARGET=<sha-or-ref>] [NAME=<slug>]}
	@NAME="$(NAME)" ./scripts/bump-submodule.sh "$(SUBMODULE)" "$(TARGET)"

# --- Test pipelines ---------------------------------------------------------
# These mirror what CI runs (.github/workflows/ci.yml) so a passing local run
# is a strong signal CI will pass.

# Unit suite — bun:test on the per-package units that don't need Postgres.
test-unit:
	@echo "🧪 Unit suite (no Postgres)…"
	@bun test packages/core packages/cli
	@bun test packages/agent-worker
	@bun test packages/server/src/__tests__/unit
	@bun test packages/server/src/auth/__tests__/tool-access.test.ts
	@# src/gateway/infrastructure/queue runs in the gateway loop in test-integration (#1238)
	@bun test packages/connector-worker
	@bun test packages/client packages/promptfoo-provider
	@bun test packages/connector-sdk
	@bun test examples/personal-agent
	@bun test examples/brand-intelligence

# Integration suite — vitest under Node + bun:test packages that need Postgres.
# Requires DATABASE_URL pointing at a Postgres with pgvector installed.
# Local (macOS): `make setup` provisions brew postgresql@18 + lobu_test on :5418 — just:
#   export DATABASE_URL=postgres://$USER@127.0.0.1:5418/lobu_test PGSSLMODE=disable
# Linux / no brew:
#   sudo apt-get install -y postgresql-16-pgvector
#   sudo -u postgres createdb lobu_test
#   sudo -u postgres psql -d lobu_test -c "CREATE EXTENSION vector"
#   export DATABASE_URL=postgres://postgres@127.0.0.1:5432/lobu_test PGSSLMODE=disable
test-integration:
	@: $${DATABASE_URL?Set DATABASE_URL=postgres://… (with pgvector) before running}
	@echo "🧪 Integration suite (Postgres at $${DATABASE_URL%%@*}@…)…"
	@cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default
	@# Each gateway test file in its own process: bun has no per-file
	@# isolation and the suites aren't mutually hermetic, so a shared-process
	@# co-run leaks DB/module state across files (see #1238). Fail if find
	@# matches nothing, so a path typo can't silently run zero tests.
	@dirs=$$(find packages/server/src/gateway -type d -name __tests__ | sort); \
		[ -n "$$dirs" ] || { echo "no gateway __tests__ dirs found" >&2; exit 1; }; \
		rc=0; for d in $$dirs; do \
			files=$$(find "$$d" -maxdepth 1 -type f -name '*.test.ts' | sort); \
			for f in $$files; do echo ">> bun test $$f"; bun test "$$f" || rc=1; done; \
		done; exit $$rc
	@bun test packages/server/src/lobu/__tests__ packages/server/src/scheduled packages/server/src/workspace/__tests__
	@bun test packages/connector-worker/integration-tests

# End-to-end — openclaw-plugin tests against a real running dev server.
# Starts the server, waits for /health, runs vitest, kills the server.
# Pass ZAI_API_KEY in env to also run the memory-loop tests; without it
# they cleanly skip (12 of 14 will run).
test-e2e:
	@: $${DATABASE_URL?Set DATABASE_URL=postgres://… (with pgvector) before running}
	@./scripts/run-e2e.sh

# SDK lifecycle e2e: boots `lobu run` (embedded Postgres), auto-applies a
# prune:true fixture, and drives a real agent turn through a spawned worker
# against a deterministic mock provider (no key needed). Self-contained. This is
# the CI `sdk-e2e` gate; run it locally the same way.
test-e2e-sdk:
	@./scripts/sdk-e2e.sh

# CLI command-coverage smoke: boots one `lobu run` (embedded Postgres + mock
# provider) under an isolated HOME and walks EVERY `lobu` command/subcommand
# once, asserting each runs (or fails gracefully). Self-contained, no key. This
# is the CI `cli-smoke` gate; run it locally the same way.
test-e2e-cli:
	@./scripts/cli-smoke.sh

# Live provider validation — opt-in, networked, NOT part of the default gates.
# Two tiers, both derived from config/providers.json:
#   keyless — probes every composed chat/models route against the real APIs
#             (wrong path 404s, right path 401s) and checks defaultModel
#             against the public catalogs; needs NO keys, runs every time.
#   keyed   — full models + chat + tool-call round-trip per provider whose API
#             key is in the env; the rest skip cleanly. Replaces the manual
#             provider pass. Pass keys via .env or the environment.
#   make test-providers-live                      # keyless tier + whichever keys are set
#   OPENAI_API_KEY=sk-... make test-providers-live
test-providers-live:
	@echo "🌐 Live provider smoke (key-gated)…"
	@bun test --timeout 60000 packages/server/src/__tests__/live-providers

# Stop any embedded worker subprocesses left over from a crashed gateway.
# Workers are normally cleaned up when the gateway exits; this target is a
# safety net for orphaned bun processes spawned by EmbeddedDeploymentManager.
clean-workers:
	@echo "🧹 Stopping embedded worker subprocesses..."
	@pkill -f 'packages/agent-worker/src/index.ts' 2>/dev/null || true
	@pkill -f '@lobu/worker' 2>/dev/null || true
	@echo "✅ Worker subprocesses stopped"

# Orphaned `lobu-test-pg-*` embedded-Postgres clusters from other worktrees'
# integration runs eat macOS shared-memory slots (SHMMNI=32), and `lobu run` /
# `make review`'s integration suite then fail with "could not create shared
# memory segment: No space left on device" (shmget). They ALSO leak their data
# dir (~150-400 MB each) to $TMPDIR — a session of killed runs once piled up
# 65 GB and filled the disk. Reap both the processes (SHM) and the dirs (disk).
clean-test-pg:
	@echo "🧹 Reaping orphaned lobu-test-pg embedded-Postgres clusters..."
	@pkill -f 'lobu-test-pg' 2>/dev/null || true
	@pkill -f '@embedded-postgres' 2>/dev/null || true
	@sleep 1
	@before=$$(df -m "$${TMPDIR:-/tmp}" 2>/dev/null | awk 'END{print $$4}'); \
		for d in "$${TMPDIR:-/tmp}"/lobu-test-pg-*; do \
			[ -d "$$d" ] || continue; \
			pid=$$(head -1 "$$d/postmaster.pid" 2>/dev/null); \
			if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
				echo "  skip live cluster $$d (pid $$pid)"; continue; \
			fi; \
			rm -rf "$$d"; \
		done; \
		after=$$(df -m "$${TMPDIR:-/tmp}" 2>/dev/null | awk 'END{print $$4}'); \
		echo "freed ~$$((after - before)) MB of leaked cluster dirs (live clusters skipped)"
	@echo "shm segments now: $$(ipcs -m 2>/dev/null | awk '/^m/{c++} END{print c+0}') / 32"
	@echo "✅ Test-PG clusters + dirs reaped"

# --- Local AI review gate ---------------------------------------------------
# Local-only: runs the deterministic suites in cwd, then invokes Claude CLI against
# `git diff <BASE>...HEAD` (BASE defaults to main; override with BASE=<branch>
# env or `--base <branch>` arg). Prints a JSON verdict on the last line. If
# GitHub auth is available, posts a pi-review commit status; if the current
# branch has an open PR, also posts/updates a PR comment. See docs/REVIEW_SCHEMA.md.

review:
	@./scripts/review.sh $(if $(BASE),--base $(BASE),)
