#!/bin/bash
set -e

# Simplified Claude Code Worker entrypoint for devcontainer-built images
echo "🚀 Starting Claude Code Worker..."

# Function to handle cleanup on exit
cleanup() {
    echo "📦 Container shutting down..."
    jobs -p | xargs -r kill || true
    sleep 1
    echo "✅ Cleanup completed"
    exit 0
}

# Setup signal handlers for graceful shutdown
trap cleanup SIGTERM SIGINT

# Basic validation for critical variables
if [[ -z "${SESSION_KEY:-}" ]]; then
    echo "❌ Error: SESSION_KEY is required"
    exit 1
fi

echo "✅ Environment: Session ${SESSION_KEY}, User ${USER_ID:-unknown}"

# Setup workspace directory
WORKSPACE_DIR="/workspace"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# Repository is pre-cloned in the image, just pull for updates
if [[ -n "${REPOSITORY_URL:-}" ]] && [[ -d ".git" ]]; then
    echo "🔄 Pulling latest changes..."
    timeout 30 git pull origin main 2>/dev/null || {
        echo "⚠️ Git pull failed or timed out, continuing with existing code"
    }
else
    echo "ℹ️ No git repository to update"
fi

# MCP servers and dependencies are pre-installed in the image
# Just verify Claude CLI is available
if ! command -v claude >/dev/null 2>&1; then
    echo "❌ Error: Claude CLI not found"
    exit 1
fi

echo "✅ Claude CLI ready"

# Start the worker process
echo "🚀 Starting worker..."
cd /app/packages/worker
exec bun run dist/index.js