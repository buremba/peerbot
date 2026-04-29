# Development Makefile for Lobu

.PHONY: help setup build test eval clean dev build-packages ensure-submodule clean-workers

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup                                 - Setup development environment (run once)"
	@echo "  make dev                                   - Start the embedded Lobu stack (host redis, remote Postgres, Vite HMR)"
	@echo "  make build-packages                        - Build all TypeScript packages"
	@echo "  make test                                  - Run test bot"
	@echo "  make eval                                  - Run agent evals"
	@echo "  make clean-workers                         - Stop any running embedded worker subprocesses"

# Build all TypeScript packages in dependency order
build-packages:
	@echo "📦 Building all TypeScript packages..."
	@for pkg in core owletto-sdk gateway worker; do \
		echo "   📦 Building packages/$$pkg..."; \
		( cd packages/$$pkg && bun run build ) || exit $$?; \
	done
	@echo "✅ All packages built successfully!"

# Ensure packages/owletto-web is initialized; warn on drift but don't auto-fix
# (drift may be active feature-branch work — clobbering it silently is worse than the warning).
ensure-submodule:
	@status=$$(git submodule status packages/owletto-web 2>/dev/null || true); \
	case "$$status" in \
		'-'*) echo ">> owletto-web submodule not initialized — running git submodule update --init --recursive"; \
		      git submodule update --init --recursive packages/owletto-web ;; \
		'+'*) echo ">> WARNING: packages/owletto-web is at a different SHA than the parent pin:"; \
		      echo "   $$status"; \
		      echo "   If this is unintentional, run: git submodule update packages/owletto-web" ;; \
		*) ;; \
	esac

# Start the embedded Lobu stack: owletto-backend + embedded gateway + workers,
# all in-process. Requires host redis on :6379 and remote Postgres via DATABASE_URL.
dev: ensure-submodule
	@./scripts/dev-native.sh

# Setup development environment (run once)
setup:
	@./scripts/setup-dev.sh

# Catch-all target to prevent errors when passing arguments
%:
	@:

# Run test bot
test:
	@./scripts/test-bot.sh "@me test from make command"

# Run agent evals
eval:
	@npx @lobu/cli@latest eval

# Stop any embedded worker subprocesses left over from a crashed gateway.
# Workers are normally cleaned up when the gateway exits; this target is a
# safety net for orphaned bun processes spawned by EmbeddedDeploymentManager.
clean-workers:
	@echo "🧹 Stopping embedded worker subprocesses..."
	@pkill -f 'packages/worker/src/index.ts' 2>/dev/null || true
	@pkill -f '@lobu/worker' 2>/dev/null || true
	@echo "✅ Worker subprocesses stopped"
