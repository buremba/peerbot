#!/bin/bash

# Script to update Kubernetes secrets from .env file

echo "🔄 Updating Kubernetes secrets from .env file..."

# Source the .env file
source .env

# Update each secret individually
echo "📝 Updating Slack secrets..."

kubectl create secret generic peerbot-secrets \
  --from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET" \
  --from-literal=slack-bot-token="$SLACK_BOT_TOKEN" \
  --from-literal=slack-app-token="$SLACK_APP_TOKEN" \
  --from-literal=slack-client-id="$SLACK_CLIENT_ID" \
  --from-literal=slack-client-secret="$SLACK_CLIENT_SECRET" \
  --from-literal=slack-refresh-token="$SLACK_REFRESH_TOKEN" \
  --from-literal=github-token="$GITHUB_TOKEN" \
  --from-file=gcs-service-account=gcs-key.json \
  --namespace=peerbot \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ Secrets updated!"

# Restart the pods to pick up new secrets
echo "🔄 Restarting dispatcher pods..."
kubectl rollout restart deployment peerbot-dispatcher -n peerbot

# Wait for rollout to complete
echo "⏳ Waiting for rollout to complete..."
kubectl rollout status deployment peerbot-dispatcher -n peerbot

echo "✅ Update complete!"