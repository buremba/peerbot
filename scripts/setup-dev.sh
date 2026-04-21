#!/bin/bash
set -euo pipefail

# Check dependencies
command -v bun >/dev/null || { echo "Install bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v docker >/dev/null || { echo "Install Docker Desktop"; exit 1; }
if ! command -v yq >/dev/null; then
  case "$(uname -s)" in
    Darwin) echo "Install yq: brew install yq" ;;
    Linux)  echo "Install yq: sudo apt-get install -y yq  (or see https://github.com/mikefarah/yq#install)" ;;
    *)      echo "Install yq: https://github.com/mikefarah/yq#install" ;;
  esac
  exit 1
fi

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
