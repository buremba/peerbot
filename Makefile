# Development Makefile for Peerbot

.PHONY: help setup build compile dev test clean logs restart

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup       - Interactive setup for Slack bot development"
	@echo "  make dev         - Start local development with Docker workers"
	@echo "  make build-worker - Build worker Docker image"
	@echo "  make test        - Run test bot"
	@echo "  make clean       - Stop services and clean up resources"

# Interactive setup for development
setup:
	@echo "🚀 Starting PeerBot development setup..."
	@./bin/setup-slack.sh

# Start local development  
dev:
	@if [ ! -f .env ]; then \
		echo "❌ .env file not found!"; \
		echo ""; \
		echo "Please run setup first:"; \
		echo "  make setup"; \
		echo ""; \
		exit 1; \
	fi
	@echo "🚀 Starting local development mode..."
	@echo "   This will:"
	@echo "   - Start orchestrator and dispatcher with hot reload"
	@echo "   - Use devcontainer-built images for workers (built on demand)"
	@echo ""
	@if grep -q "DEPLOYMENT_MODE=" .env 2>/dev/null; then \
		DEPLOYMENT_MODE=$$(grep "DEPLOYMENT_MODE=" .env | cut -d'=' -f2); \
		if [ "$$DEPLOYMENT_MODE" = "k8s" ]; then \
			echo "Using Kubernetes mode (from .env)..."; \
			./bin/setup-slack.sh k8s-only; \
		else \
			echo "Using Docker mode (from .env)..."; \
			./bin/setup-slack.sh docker-only; \
		fi \
	else \
		read -p "Do you want to setup Kubernetes configuration? (y/N): " setup_k8s; \
		if [ "$$setup_k8s" = "y" ] || [ "$$setup_k8s" = "Y" ]; then \
			echo "Setting up Kubernetes configuration..."; \
			./bin/setup-slack.sh k8s-only; \
		else \
			echo "Using Docker mode..."; \
			./bin/setup-slack.sh docker-only; \
		fi \
	fi
	@export NODE_ENV=development && \
		bun --watch packages/orchestrator/src/index.ts & \
		bun --watch packages/dispatcher/src/index.ts

# Build base worker image for development (optional fallback)
build-worker:
	@echo "ℹ️ Worker images are now built dynamically using devcontainers"
	@echo "   Base images will be built on-demand when workers are created"

# Catch-all target to prevent errors when passing arguments
%:
	@:

# Run test bot
test:
	@echo "🧪 Running test bot..."
	@source .env && node slack-qa-bot.js --qa
# Clean up
clean:
	@echo "🧹 Cleaning up..."
	@docker stop $(shell docker ps -q --filter "label=app.kubernetes.io/component=worker") 2>/dev/null || true
	@docker rm $(shell docker ps -aq --filter "label=app.kubernetes.io/component=worker") 2>/dev/null || true
	@echo "✅ Docker containers cleaned up"