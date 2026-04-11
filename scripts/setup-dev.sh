#!/bin/bash
set -e

# Check dependencies
command -v bun >/dev/null || { echo "Install bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v docker >/dev/null || { echo "Install Docker Desktop"; exit 1; }

# Build worker + packages
docker build -t lobu-worker:latest -f docker/Dockerfile.worker --build-arg NODE_ENV=development .
make build-packages

echo "Setup complete!"
echo ""
echo "If you haven't configured .env yet, run:"
echo "  npx @lobu/cli@latest"
echo ""
echo "To start development:"
echo "  redis-server &"
echo "  make watch-packages"
echo "  cd packages/gateway && bun run dev"
