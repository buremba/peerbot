#!/bin/bash
set -euo pipefail

# Check dependencies
command -v bun >/dev/null || { echo "Install bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }

make build-packages

echo "Setup complete!"
echo ""
echo "If you haven't configured .env yet, run:"
echo "  npx @lobu/cli@latest"
echo ""
echo "To start development:"
echo "  make dev             # boots embedded gateway + workers + Vite HMR"
