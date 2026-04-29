#!/bin/bash
set -euo pipefail

# Check dependencies
command -v bun >/dev/null || { echo "Install bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v redis-cli >/dev/null || {
  case "$(uname -s)" in
    Darwin) echo "Install redis: brew install redis" ;;
    Linux)  echo "Install redis: sudo apt-get install -y redis-server" ;;
    *)      echo "Install redis: https://redis.io/docs/getting-started/" ;;
  esac
  exit 1
}

make build-packages

echo "Setup complete!"
echo ""
echo "If you haven't configured .env yet, run:"
echo "  npx @lobu/cli@latest"
echo ""
echo "To start development:"
echo "  redis-server &       # local redis on :6379"
echo "  make dev             # boots embedded gateway + workers + Vite HMR"
