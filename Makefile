# Development Makefile for Lobu

# Resolve deployment mode once: honor explicit env var, else parse .env, else default to docker.
DEPLOYMENT_MODE := $(shell \
	if [ -n "$$DEPLOYMENT_MODE" ]; then \
		echo "$$DEPLOYMENT_MODE"; \
	elif [ -f .env ]; then \
		grep "^DEPLOYMENT_MODE=" .env | cut -d'=' -f2 | tr -d ' '; \
	else \
		echo docker; \
	fi)

.PHONY: help setup build test eval clean logs deploy down build-packages dev

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup                                 - Setup development environment (run once)"
	@echo "  make dev                                   - Start dev environment (Docker Compose Watch)"
	@echo "  make build-packages                        - Build all TypeScript packages"
	@echo "  make build-worker                          - Build worker Docker image"
	@echo "  make deploy                                - Deploy to K8s using values-local.yaml"
	@echo "  make deploy TARGET=production              - Deploy to K8s using values-production.yaml"
	@echo "  make test                                  - Run test bot"
	@echo "  make eval                                  - Run agent evals"
	@echo "  make clean                                 - Stop all services and clean up"
	@echo "  make clean-workers                         - Remove worker containers only"

# Build all TypeScript packages in dependency order
build-packages:
	@echo "📦 Building all TypeScript packages..."
	@echo "   1️⃣  Building packages/core..."
	@cd packages/core && bun run build
	@echo "   2️⃣  Building packages/gateway..."
	@cd packages/gateway && bun run build
	@echo "   3️⃣  Building packages/worker..."
	@cd packages/worker && bun run build
	@echo "✅ All packages built successfully!"

# Start dev environment with Docker Compose Watch
dev:
	docker compose --env-file .env -f docker/docker-compose.yml watch

# Setup development environment (run once)
setup:
	@./scripts/setup-dev.sh

# Build the worker image
build-worker:
	@echo "📦 Building worker image..."
	@docker build -t lobu-worker:latest -t ghcr.io/lobu-ai/lobu-worker-base:latest -f docker/Dockerfile.worker --build-arg NODE_ENV=development .

# Catch-all target to prevent errors when passing arguments
%:
	@:

# Run test bot
test:
	@./scripts/test-bot.sh "@me test from make command"

# Run agent evals
eval:
	@npx @lobu/cli@latest eval
# Deploy to Kubernetes
# Usage: make deploy [--target=environment]
deploy:
	@# Skip .env check in CI environment
	@if [ -z "$$GITHUB_ACTIONS" ] && [ ! -f .env ]; then \
		echo "❌ .env file not found!"; \
		echo ""; \
		echo "Please run setup first:"; \
		echo "  make setup"; \
		echo ""; \
		exit 1; \
	fi
	@# Use TARGET environment variable or make variable
	@if [ -n "$$TARGET" ] || [ -n "$(TARGET)" ]; then \
		TARGET_PATH="$${TARGET:-$(TARGET)}"; \
		if [ -f "$$TARGET_PATH" ]; then \
			VALUES_FILE="$$TARGET_PATH"; \
			echo "📋 Using custom values file: $$VALUES_FILE"; \
		elif [ -f "charts/lobu/values-$$TARGET_PATH.yaml" ]; then \
			VALUES_FILE="charts/lobu/values-$$TARGET_PATH.yaml"; \
			echo "📋 Using environment file: $$VALUES_FILE"; \
		else \
			echo "❌ Values file not found: $$TARGET_PATH"; \
			echo "❌ Also tried: charts/lobu/values-$$TARGET_PATH.yaml"; \
			exit 1; \
		fi; \
	elif [ -f "charts/lobu/values-local.yaml" ]; then \
		VALUES_FILE="charts/lobu/values-local.yaml"; \
		echo "📋 Using existing $$VALUES_FILE"; \
	else \
		VALUES_FILE="charts/lobu/values-local.yaml"; \
		echo "🔄 Creating $$VALUES_FILE from .env and base values.yaml..."; \
		cp "charts/lobu/values.yaml" "$$VALUES_FILE"; \
		./scripts/sync-env-to-values.sh local; \
	fi; \
	echo "🎯 Deploying using $$VALUES_FILE"; \
	echo "🚀 Building and deploying to K8s..."; \
	if [ -z "$$GITHUB_ACTIONS" ]; then \
		echo "📦 Building Docker images..."; \
		docker build -f docker/Dockerfile.gateway -t lobu-gateway:latest .; \
		docker build -f docker/Dockerfile.worker -t lobu-worker:latest .; \
	else \
		echo "📦 Using pre-built Docker images from registry..."; \
	fi; \
	if command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -q kind; then \
		echo "📦 Loading images into kind..."; \
		kind load docker-image lobu-gateway:latest; \
		kind load docker-image lobu-worker:latest; \
	fi; \
	echo "🔧 Deploying with Helm..."; \
	if [ -z "$$GITHUB_ACTIONS" ]; then \
		set -a; source .env; set +a; \
	fi; \
	echo "📋 Final values file: $$VALUES_FILE"; \
	if [ -n "$$GITHUB_ACTIONS" ]; then \
		IMAGE_REPO="$${DOCKER_NAMESPACE:-ghcr.io/lobu-ai}"; \
		IMAGE_TAG="$${IMAGE_TAG:-latest}"; \
		WORKER_IMAGE_DIGEST="$${WORKER_IMAGE_DIGEST:-}"; \
		WORKER_IMAGE_REPO="$$IMAGE_REPO/lobu-worker-base"; \
		if [ -n "$$WORKER_IMAGE_DIGEST" ]; then \
			WORKER_IMAGE_REF="$$WORKER_IMAGE_REPO@$$WORKER_IMAGE_DIGEST"; \
		else \
			WORKER_IMAGE_REF="$$WORKER_IMAGE_REPO:$$IMAGE_TAG"; \
		fi; \
		echo "🔎 Running worker image preflight: $$WORKER_IMAGE_REF"; \
		./scripts/preflight-worker-image.sh "$$WORKER_IMAGE_REF"; \
		IMAGE_OVERRIDES="--set gateway.image.repository=$$IMAGE_REPO/lobu-gateway \
			--set gateway.image.tag=$$IMAGE_TAG \
			--set worker.image.repository=$$WORKER_IMAGE_REPO \
			--set worker.image.tag=$$IMAGE_TAG \
			--set worker.image.digest=$$WORKER_IMAGE_DIGEST"; \
	else \
		IMAGE_OVERRIDES=""; \
	fi; \
		helm upgrade --install "$${DEPLOYMENT_NAME:-lobu}" charts/lobu/ \
			--dependency-update \
			--create-namespace \
			--namespace "$${NAMESPACE:-lobu}" \
			-f "$$VALUES_FILE" \
			$$IMAGE_OVERRIDES \
			--set secrets.encryptionKey="$$ENCRYPTION_KEY" \
			--set secrets.adminPassword="$$ADMIN_PASSWORD" \
			--set secrets.claudeCodeOAuthToken="$$CLAUDE_CODE_OAUTH_TOKEN" \
			--wait \
			--timeout "$${HELM_TIMEOUT:-10m}"
	@echo "✅ Deployed to K8s. Check status with:"
	@echo "  kubectl get pods -n $${NAMESPACE:-lobu}"
	@echo "  kubectl logs -f deployment/$${DEPLOYMENT_NAME:-lobu}-gateway -n $${NAMESPACE:-lobu}"

# View logs based on deployment mode
logs:
	@if [ "$(DEPLOYMENT_MODE)" = "kubernetes" ] || [ "$(DEPLOYMENT_MODE)" = "k8s" ]; then \
		echo "☸️  Viewing Kubernetes logs..."; \
		echo "Select a pod to view logs:"; \
		kubectl get pods -n lobu; \
		echo ""; \
		echo "View logs with:"; \
		echo "  kubectl logs -f <pod-name> -n lobu"; \
	else \
		echo "View logs with:"; \
		echo "  docker compose logs -f gateway"; \
	fi

# Stop worker containers
down:
	@echo "🛑 Stopping lobu worker containers..."
	@docker ps -q --filter "label=app.kubernetes.io/component=worker" | xargs -r docker stop 2>/dev/null || true
	@docker ps -aq --filter "label=app.kubernetes.io/component=worker" | xargs -r docker rm 2>/dev/null || true
	@echo "✅ Worker containers stopped"

# Clean up everything including volumes
clean:
	@echo "🧹 Cleaning up lobu resources (mode: $(DEPLOYMENT_MODE))..."; \
	if [ "$(DEPLOYMENT_MODE)" = "kubernetes" ] || [ "$(DEPLOYMENT_MODE)" = "k8s" ]; then \
		echo "☸️  Cleaning Kubernetes resources..."; \
		helm uninstall lobu -n lobu 2>/dev/null || true; \
		kubectl delete namespace lobu --wait=false 2>/dev/null || true; \
		echo "✅ Kubernetes resources cleaned up"; \
	else \
		echo "🐳 Cleaning Docker worker containers..."; \
		docker ps -q --filter "label=app.kubernetes.io/component=worker" | xargs -r docker stop 2>/dev/null || true; \
		docker ps -aq --filter "label=app.kubernetes.io/component=worker" | xargs -r docker rm 2>/dev/null || true; \
		docker volume ls -q --filter "name=lobu-workspace-" | xargs -r docker volume rm 2>/dev/null || true; \
		docker network rm lobu-internal 2>/dev/null || true; \
		echo "✅ Docker containers and volumes cleaned up"; \
	fi

clean-workers:
	@echo "🧹 Removing worker containers (mode: $(DEPLOYMENT_MODE))..."; \
	if [ "$(DEPLOYMENT_MODE)" = "kubernetes" ] || [ "$(DEPLOYMENT_MODE)" = "k8s" ]; then \
		echo "☸️  Removing Kubernetes worker pods..."; \
		kubectl delete pods -n lobu -l app.kubernetes.io/component=worker --wait=false 2>/dev/null || true; \
		echo "✅ Kubernetes worker pods removed"; \
	else \
		echo "🐳 Removing Docker worker containers..."; \
		docker ps -a --filter "label=app.kubernetes.io/component=worker" -q | xargs docker rm -f 2>/dev/null || true; \
		echo "✅ Docker worker containers removed"; \
	fi; \
	echo "✅ New workers will use updated code"
