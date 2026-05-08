# Development Makefile for Lobu

.PHONY: help setup build test eval clean dev build-packages ensure-submodule clean-workers test-unit test-integration test-e2e

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup                                 - Setup development environment (run once)"
	@echo "  make dev                                   - Start the embedded Lobu stack (Postgres via DATABASE_URL, Vite HMR)"
	@echo "  make build-packages                        - Build all TypeScript packages"
	@echo "  make test                                  - Run test bot"
	@echo "  make test-unit                             - Run the CI unit suite (no Postgres needed)"
	@echo "  make test-integration                      - Run the CI integration suite (needs DATABASE_URL with pgvector)"
	@echo "  make test-e2e                              - Boot the dev server + run openclaw-plugin e2e against it"
	@echo "  make eval                                  - Run agent evals"
	@echo "  make clean-workers                         - Stop any running embedded worker subprocesses"

# Build all TypeScript packages in dependency order
build-packages:
	@echo "📦 Building all TypeScript packages..."
	@for pkg in core connector-sdk agent-worker openclaw-plugin embeddings connector-worker; do \
		echo "   📦 Building packages/$$pkg..."; \
		( cd packages/$$pkg && bun run build ) || exit $$?; \
	done
	@echo "   📦 Building packages/server bundle..."
	@( cd packages/server && bun run build:server ) || exit $$?
	@echo "   📦 Building packages/cli..."
	@( cd packages/cli && bun run build ) || exit $$?
	@echo "✅ All packages built successfully!"

# Ensure packages/web is initialized; warn on drift but don't auto-fix
# (drift may be active feature-branch work — clobbering it silently is worse than the warning).
ensure-submodule:
	@status=$$(git submodule status packages/web 2>/dev/null || true); \
	case "$$status" in \
		'-'*) echo ">> web submodule not initialized — running git submodule update --init --recursive"; \
		      git submodule update --init --recursive packages/web ;; \
		'+'*) echo ">> WARNING: packages/web is at a different SHA than the parent pin:"; \
		      echo "   $$status"; \
		      echo "   If this is unintentional, run: git submodule update packages/web" ;; \
		*) ;; \
	esac

# Start the embedded Lobu stack: server + embedded gateway + workers,
# all in-process. Requires Postgres via DATABASE_URL.
dev: ensure-submodule
	@./scripts/dev-native.sh

# Setup development environment (run once)
setup:
	@./scripts/setup-dev.sh

# Run test bot
test:
	@./scripts/test-bot.sh "@me test from make command"

# Run agent evals
eval:
	@npx @lobu/cli@latest eval

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
	@bun test packages/server/src/gateway/infrastructure/queue
	@bun test packages/connector-worker

# Integration suite — vitest under Node + bun:test packages that need Postgres.
# Requires DATABASE_URL pointing at a Postgres with pgvector installed.
# Tip for a clean local DB:
#   sudo apt-get install -y postgresql-16-pgvector
#   sudo -u postgres createdb lobu_test
#   sudo -u postgres psql -d lobu_test -c "CREATE EXTENSION vector"
#   export DATABASE_URL=postgres://postgres@127.0.0.1:5432/lobu_test PGSSLMODE=disable
test-integration:
	@: $${DATABASE_URL?Set DATABASE_URL=postgres://… (with pgvector) before running}
	@echo "🧪 Integration suite (Postgres at $${DATABASE_URL%%@*}@…)…"
	@cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default
	@bun test packages/server/src/gateway/__tests__
	@bun test packages/server/src/lobu/__tests__ packages/server/src/workspace/__tests__
	@bun test packages/server/src/scheduled/__tests__
	@bun test packages/connector-worker/integration-tests

# End-to-end — openclaw-plugin tests against a real running dev server.
# Starts the server, waits for /health, runs vitest, kills the server.
# Pass ZAI_API_KEY in env to also run the memory-loop tests; without it
# they cleanly skip (12 of 14 will run).
test-e2e:
	@: $${DATABASE_URL?Set DATABASE_URL=postgres://… (with pgvector) before running}
	@./scripts/run-e2e.sh

# Stop any embedded worker subprocesses left over from a crashed gateway.
# Workers are normally cleaned up when the gateway exits; this target is a
# safety net for orphaned bun processes spawned by EmbeddedDeploymentManager.
clean-workers:
	@echo "🧹 Stopping embedded worker subprocesses..."
	@pkill -f 'packages/agent-worker/src/index.ts' 2>/dev/null || true
	@pkill -f '@lobu/worker' 2>/dev/null || true
	@echo "✅ Worker subprocesses stopped"
