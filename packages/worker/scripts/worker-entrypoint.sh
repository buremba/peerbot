#!/bin/bash
set -e

# Container entrypoint script for Claude Worker
echo "🚀 Starting Lobu Worker..."

# Function to handle cleanup on exit
cleanup() {
    echo "📦 Container shutting down, performing cleanup..."
    
    # Kill any background processes
    jobs -p | xargs -r kill || true
    
    # Give processes time to exit gracefully
    sleep 2
    
    echo "✅ Cleanup completed"
    exit 0
}

# Setup signal handlers for graceful shutdown
trap cleanup SIGTERM SIGINT

echo "🔍 Environment variables provided by orchestrator:"
echo "  - USER_ID: ${USER_ID:-not set}" 
echo "  - CHANNEL_ID: ${CHANNEL_ID:-not set}"
echo "  - REPOSITORY_URL: ${REPOSITORY_URL:-not set}"
echo "  - DEPLOYMENT_NAME: ${DEPLOYMENT_NAME:-not set}"

# Basic validation for critical variables
if [[ -z "${USER_ID:-}" ]]; then
    echo "❌ Error: USER_ID is required"
    exit 1
fi

if [[ -z "${DEPLOYMENT_NAME:-}" ]]; then
    echo "❌ Error: DEPLOYMENT_NAME is required"
    exit 1
fi

# Setup workspace directory
echo "📁 Setting up workspace directory..."
WORKSPACE_DIR="/workspace"

# Workspace permissions are fixed by gateway before container starts
# Just verify we can write to it
if [ ! -w "$WORKSPACE_DIR" ]; then
    echo "❌ Error: Cannot write to workspace directory $WORKSPACE_DIR"
    exit 1
fi

cd "$WORKSPACE_DIR"

echo "✅ Workspace directory ready: $WORKSPACE_DIR"

# Log container information
echo "📊 Container Information:"
echo "  - Session Key: $SESSION_KEY"
echo "  - Repository: $REPOSITORY_URL"
echo "  - Working Directory: $(pwd)"
echo "  - Container Hostname: $(hostname)"
echo "  - Container Memory Limit: $(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 'unknown')"
echo "  - Container CPU Limit: $(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo 'unknown')"

# Setup git global configuration
echo "⚙️ Setting up git configuration..."
git config --global user.name "Lobu Worker"
git config --global user.email "lobu@noreply.github.com"
git config --global init.defaultBranch main
git config --global pull.rebase false
git config --global safe.directory '*'

# In development mode, ensure core package can find its dependencies
# The packages/ dir is mounted as a volume which may contain node_modules from host
if [ "${NODE_ENV}" = "development" ]; then
    # Remove any existing node_modules that aren't symlinks
    if [ -e "/app/packages/core/node_modules" ] && [ ! -L "/app/packages/core/node_modules" ]; then
        echo "🗑️  Removing host node_modules from /app/packages/core/"
        rm -rf /app/packages/core/node_modules
    fi
    if [ ! -e "/app/packages/core/node_modules" ]; then
        echo "🔗 Creating symlink for core package dependencies..."
        ln -sf /app/node_modules /app/packages/core/node_modules
        echo "✅ Symlink created: /app/packages/core/node_modules -> /app/node_modules"
    fi

    # Also for worker package if needed
    if [ -e "/app/packages/worker/node_modules" ] && [ ! -L "/app/packages/worker/node_modules" ]; then
        rm -rf /app/packages/worker/node_modules
    fi
    if [ ! -e "/app/packages/worker/node_modules" ]; then
        ln -sf /app/node_modules /app/packages/worker/node_modules
    fi
fi

# Source Nix profile if installed (non-interactive shells don't source /etc/profile.d)
if [ -f /home/claude/.nix-profile/etc/profile.d/nix.sh ]; then
    . /home/claude/.nix-profile/etc/profile.d/nix.sh
    # Set NIX_PATH for nix-shell -p to find nixpkgs
    export NIX_PATH="nixpkgs=/home/claude/.nix-defexpr/channels/nixpkgs"
fi

# Docker fallback: persist Nix store on workspace PVC via symlinks
# (K8s uses init container + subPath mounts instead, detected by .nix-pvc-mounted marker)
if [ -n "${NIX_PACKAGES:-}${NIX_FLAKE_URL:-}" ] && [ ! -d "/nix/store/.nix-pvc-mounted" ]; then
    NIX_PVC_STORE="/workspace/.nix-store"
    NIX_PVC_VAR="/workspace/.nix-var"
    MARKER="/workspace/.nix-bootstrapped"
    if [ ! -f "$MARKER" ]; then
        echo "Bootstrapping Nix store to PVC..."
        cp -a /nix/store "$NIX_PVC_STORE"
        cp -a /nix/var "$NIX_PVC_VAR"
        touch "$MARKER"
    fi
    rm -rf /nix/store /nix/var
    ln -sf "$NIX_PVC_STORE" /nix/store
    ln -sf "$NIX_PVC_VAR" /nix/var
    echo "Nix store linked to PVC"
fi

# Nix environment activation
# Priority: API env vars > repo files
activate_nix_env() {
    local cmd="$1"

    # Check if Nix is installed
    if ! command -v nix &> /dev/null; then
        echo "⚠️  Nix not installed, skipping environment activation"
        exec $cmd
    fi

    # 1. API-provided flake URL takes highest priority
    if [ -n "${NIX_FLAKE_URL:-}" ]; then
        echo "🔧 Activating Nix flake environment: $NIX_FLAKE_URL"
        exec nix develop "$NIX_FLAKE_URL" --command $cmd
    fi

    # 2. API-provided packages list
    if [ -n "${NIX_PACKAGES:-}" ]; then
        # Convert comma-separated to space-separated
        local packages="${NIX_PACKAGES//,/ }"
        echo "🔧 Activating Nix packages: $packages"
        exec nix-shell -p $packages --command "$cmd"
    fi

    # 3. Check for nix files in workspace (git-based config)
    if [ -f "$WORKSPACE_DIR/flake.nix" ]; then
        echo "🔧 Detected flake.nix in workspace, activating..."
        exec nix develop "$WORKSPACE_DIR" --command $cmd
    fi

    if [ -f "$WORKSPACE_DIR/shell.nix" ]; then
        echo "🔧 Detected shell.nix in workspace, activating..."
        exec nix-shell "$WORKSPACE_DIR/shell.nix" --command "$cmd"
    fi

    # 4. Check for simple .nix-packages file (one package per line)
    if [ -f "$WORKSPACE_DIR/.nix-packages" ]; then
        local packages=$(cat "$WORKSPACE_DIR/.nix-packages" | tr '\n' ' ')
        echo "🔧 Detected .nix-packages file, activating: $packages"
        exec nix-shell -p $packages --command "$cmd"
    fi

    # No nix config found, run directly
    exec $cmd
}

# Start the worker process
echo "🚀 Executing Claude Worker..."
# Check if we're already in the worker directory
if [ "$(pwd)" != "/app/packages/worker" ]; then
    cd /app/packages/worker || { echo "❌ Failed to cd to /app/packages/worker"; exit 1; }
fi

# In development mode, run from source to avoid path resolution issues with modules
if [ "${NODE_ENV}" = "development" ]; then
    echo "📝 Running in development mode from source..."
    activate_nix_env "bun run src/index.ts"
else
    activate_nix_env "bun run dist/index.js"
fi