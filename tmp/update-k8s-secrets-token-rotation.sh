#!/bin/bash

# Script to update Kubernetes secrets with token rotation credentials

set -e

echo "🔒 Updating Kubernetes Secrets for Token Rotation"
echo "================================================"

# Load environment variables
source .env

# Check if all required variables are set
required_vars=(
    "SLACK_BOT_TOKEN"
    "SLACK_REFRESH_TOKEN"
    "SLACK_CLIENT_ID"
    "SLACK_CLIENT_SECRET"
    "SLACK_SIGNING_SECRET"
    "SLACK_APP_TOKEN"
    "GITHUB_TOKEN"
)

echo -e "\n📋 Checking environment variables..."
missing_vars=()
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ $var is not set"
        missing_vars+=($var)
    else
        echo "✅ $var is set"
    fi
done

if [ ${#missing_vars[@]} -gt 0 ]; then
    echo -e "\n❌ Missing required environment variables: ${missing_vars[*]}"
    exit 1
fi

# Set namespace
NAMESPACE="peerbot"

echo -e "\n🔄 Deleting existing secrets..."
kubectl delete secret claude-secrets -n $NAMESPACE --ignore-not-found=true

echo -e "\n🔑 Creating new secrets with token rotation credentials..."
kubectl create secret generic claude-secrets -n $NAMESPACE \
    --from-literal=slack-bot-token="$SLACK_BOT_TOKEN" \
    --from-literal=slack-refresh-token="$SLACK_REFRESH_TOKEN" \
    --from-literal=slack-client-id="$SLACK_CLIENT_ID" \
    --from-literal=slack-client-secret="$SLACK_CLIENT_SECRET" \
    --from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET" \
    --from-literal=slack-app-token="$SLACK_APP_TOKEN" \
    --from-literal=github-token="$GITHUB_TOKEN" \
    --from-literal=gcs-service-account=""

echo -e "\n✅ Secrets updated successfully!"

echo -e "\n📊 Verifying secrets..."
kubectl get secret claude-secrets -n $NAMESPACE -o jsonpath='{.data}' | jq -r 'keys[]' | while read key; do
    echo "   ✓ $key"
done

echo -e "\n🚀 Ready to deploy updated services with token rotation!"