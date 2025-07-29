#!/bin/bash

# Script to update Kubernetes secrets without bot token

echo "🔄 Updating Kubernetes secrets (removing bot token requirement)..."

# Source the .env file
source .env

# First, backup the existing GCS service account
echo "📦 Backing up existing GCS service account..."
kubectl get secret peerbot-secrets -n peerbot -o jsonpath='{.data.gcs-service-account}' | base64 -d > /tmp/gcs-key-backup.json

# Create the secret with a dummy bot token for now
echo "📝 Creating new secret with dummy bot token..."
kubectl create secret generic peerbot-secrets \
  --from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET" \
  --from-literal=slack-bot-token="xoxb-dummy-token" \
  --from-literal=slack-app-token="$SLACK_APP_TOKEN" \
  --from-literal=slack-client-id="$SLACK_CLIENT_ID" \
  --from-literal=slack-client-secret="$SLACK_CLIENT_SECRET" \
  --from-literal=slack-refresh-token="$SLACK_REFRESH_TOKEN" \
  --from-literal=github-token="$GITHUB_TOKEN" \
  --from-file=gcs-service-account=/tmp/gcs-key-backup.json \
  --namespace=peerbot \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ Secrets updated with dummy bot token!"

# Clean up backup
rm -f /tmp/gcs-key-backup.json

echo "⚠️  Note: The application still requires code changes to use token rotation"
echo "⚠️  The dummy bot token will cause authentication to fail"