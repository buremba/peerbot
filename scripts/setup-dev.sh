#!/bin/bash
set -e

# Check dependencies
command -v redis-server >/dev/null || { echo "Install redis: brew install redis"; exit 1; }
command -v bun >/dev/null || { echo "Install bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v docker >/dev/null || { echo "Install Docker Desktop"; exit 1; }

# Create Redis data directory
mkdir -p .peerbot/redis-data

# Create Docker network for workers (if not exists)
docker network create peerbot-internal 2>/dev/null || true

# Build worker image
echo "Building worker image..."
docker build -t peerbot-worker:latest -f Dockerfile.worker --build-arg NODE_ENV=development .

# Build packages
echo "Building packages..."
make build-packages

echo "Setup complete! Processes will auto-start when you open this project in Claude Code."
