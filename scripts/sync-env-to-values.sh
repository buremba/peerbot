#!/bin/bash
set -euo pipefail

# Sync .env values to Helm values.yaml
# Usage: ./scripts/sync-env-to-values.sh [values-file] [environment]

ENV_FILE=".env"

if ! command -v yq >/dev/null 2>&1; then
    echo "❌ yq is required. Install it and retry:" >&2
    case "$(uname -s)" in
        Darwin) echo "   brew install yq" >&2 ;;
        Linux)  echo "   sudo apt-get install -y yq  (or see https://github.com/mikefarah/yq#install)" >&2 ;;
        *)      echo "   https://github.com/mikefarah/yq#install" >&2 ;;
    esac
    exit 1
fi

# Determine values file based on environment or explicit path
ARG1="${1:-}"
ARG2="${2:-}"
if [ -n "$ARG2" ]; then
    # Environment specified (dev, production, local)
    VALUES_FILE="charts/lobu/values-$ARG2.yaml"
elif [ -n "$ARG1" ] && [[ "$ARG1" == *.yaml ]]; then
    # Explicit values file path provided
    VALUES_FILE="$ARG1"
elif [ -n "$ARG1" ]; then
    # Environment name provided as first argument
    VALUES_FILE="charts/lobu/values-$ARG1.yaml"
else
    # Default to base values.yaml
    VALUES_FILE="charts/lobu/values.yaml"
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ .env file not found!"
    exit 1
fi

if [ ! -f "$VALUES_FILE" ]; then
    echo "❌ Values file not found: $VALUES_FILE"
    exit 1
fi

echo "🔄 Syncing .env to $VALUES_FILE..."

# Source the .env file
set -a
source "$ENV_FILE"
set +a

# Create a temporary file for the updated values
TEMP_VALUES=$(mktemp)
cp "$VALUES_FILE" "$TEMP_VALUES"

# Function to update YAML value
update_yaml_value() {
    local key=$1
    local value=$2
    local yaml_path=$3

    if [ -n "$value" ]; then
        echo "  ✓ $key: $value"
        yq eval "$yaml_path = \"$value\"" -i "$TEMP_VALUES"
    fi
}

# Sync orchestrator configuration
if [ -n "${MAX_WORKER_DEPLOYMENTS:-}" ]; then
    update_yaml_value "MAX_WORKER_DEPLOYMENTS" "$MAX_WORKER_DEPLOYMENTS" ".orchestrator.maxWorkerDeployments"
fi

if [ -n "${WORKER_IDLE_CLEANUP_MINUTES:-}" ]; then
    update_yaml_value "WORKER_IDLE_CLEANUP_MINUTES" "$WORKER_IDLE_CLEANUP_MINUTES" ".orchestrator.idleCleanupMinutes"
fi

# Sync worker configuration
if [ -n "${WORKER_CPU_LIMIT:-}" ]; then
    update_yaml_value "WORKER_CPU_LIMIT" "$WORKER_CPU_LIMIT" ".worker.resources.limits.cpu"
fi

if [ -n "${WORKER_MEMORY_LIMIT:-}" ]; then
    update_yaml_value "WORKER_MEMORY_LIMIT" "$WORKER_MEMORY_LIMIT" ".worker.resources.limits.memory"
fi

if [ -n "${WORKER_CPU_REQUEST:-}" ]; then
    update_yaml_value "WORKER_CPU_REQUEST" "$WORKER_CPU_REQUEST" ".worker.resources.requests.cpu"
fi

if [ -n "${WORKER_MEMORY_REQUEST:-}" ]; then
    update_yaml_value "WORKER_MEMORY_REQUEST" "$WORKER_MEMORY_REQUEST" ".worker.resources.requests.memory"
fi

# Sync agent model configuration
if [ -n "${AGENT_DEFAULT_MODEL:-}" ]; then
    update_yaml_value "AGENT_DEFAULT_MODEL" "$AGENT_DEFAULT_MODEL" ".claude.model"
fi

if [ -n "${CLAUDE_TIMEOUT_MINUTES:-}" ]; then
    update_yaml_value "CLAUDE_TIMEOUT_MINUTES" "$CLAUDE_TIMEOUT_MINUTES" ".claude.timeoutMinutes"
fi

# Replace the original values file
mv "$TEMP_VALUES" "$VALUES_FILE"

echo "✅ Environment variables synced to $VALUES_FILE"
