#!/bin/bash

# Load environment variables
export $(cat .env | grep -v '^#' | xargs)

# Set HTTP mode
export SLACK_HTTP_MODE=true

echo "🚀 Starting dispatcher with token rotation..."
echo "   SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN:0:30}..."
echo "   SLACK_REFRESH_TOKEN: ${SLACK_REFRESH_TOKEN:0:30}..."
echo "   SLACK_CLIENT_ID: $SLACK_CLIENT_ID"
echo "   SLACK_CLIENT_SECRET: ${SLACK_CLIENT_SECRET:0:20}..."
echo ""

cd packages/dispatcher
bun run src/index.ts