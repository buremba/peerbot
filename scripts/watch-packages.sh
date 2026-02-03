#!/usr/bin/env bash

# Watch TypeScript packages and rebuild on changes
# Uses bun's built-in watch mode for fast rebuilds

echo "👀 Starting package watch mode..."
echo "   Watching: packages/{core,gateway,worker}/src/**/*.ts"
echo "   Press Ctrl+C to stop"
echo ""

# Build all packages first
echo "📦 Initial build..."
make build-packages

echo ""
echo "✅ Initial build complete. Now watching for changes..."
echo ""

# Watch all packages in parallel using bun
(cd packages/core && bun run build --watch) &
(cd packages/gateway && bun run build --watch) &
(cd packages/worker && bun run build --watch) &

# Wait for all background processes
wait
