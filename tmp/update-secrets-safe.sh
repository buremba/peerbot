#!/bin/bash

# Script to update Kubernetes secrets from .env file safely

echo "🔄 Updating Kubernetes secrets from .env file..."

# Source the .env file
source .env

# First, backup the existing GCS service account
echo "📦 Backing up existing GCS service account..."
kubectl get secret peerbot-secrets -n peerbot -o jsonpath='{.data.gcs-service-account}' | base64 -d > /tmp/gcs-key-backup.json

# Create the secret with all values
echo "📝 Creating new secret with updated values..."
kubectl create secret generic peerbot-secrets \
  --from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET" \
  --from-literal=slack-bot-token="$SLACK_BOT_TOKEN" \
  --from-literal=slack-app-token="$SLACK_APP_TOKEN" \
  --from-literal=slack-client-id="$SLACK_CLIENT_ID" \
  --from-literal=slack-client-secret="$SLACK_CLIENT_SECRET" \
  --from-literal=slack-refresh-token="$SLACK_REFRESH_TOKEN" \
  --from-literal=github-token="$GITHUB_TOKEN" \
  --from-file=gcs-service-account=/tmp/gcs-key-backup.json \
  --namespace=peerbot \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ Secrets updated!"

# Show the updated token prefix to verify
echo "🔍 Verifying updated bot token..."
kubectl get secret peerbot-secrets -n peerbot -o jsonpath='{.data.slack-bot-token}' | base64 -d | cut -c1-30
echo "..."

# Restart the pods to pick up new secrets
echo "🔄 Restarting dispatcher pods..."
kubectl rollout restart deployment peerbot-dispatcher -n peerbot

# Clean up backup
rm -f /tmp/gcs-key-backup.json

echo "✅ Update complete!"