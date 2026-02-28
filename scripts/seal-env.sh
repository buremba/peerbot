#!/bin/bash
# Convert .env to Kubernetes SealedSecret
#
# Prerequisites:
# 1. Install Sealed Secrets controller in cluster
# 2. Install kubeseal CLI: brew install kubeseal
#
# Usage:
#   ./scripts/seal-env.sh                    # Output to stdout
#   ./scripts/seal-env.sh -o values.yaml     # Output to file
#   ./scripts/seal-env.sh --apply            # Apply directly to cluster

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_ROOT}/.env"

# Parse arguments
OUTPUT_FILE=""
APPLY_DIRECT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -o|--output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --apply)
      APPLY_DIRECT=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [-o output.yaml] [--apply]"
      echo ""
      echo "Options:"
      echo "  -o, --output FILE   Write sealed secret values to file"
      echo "  --apply             Apply sealed secret directly to cluster"
      echo "  -h, --help          Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Check prerequisites
if ! command -v kubeseal &> /dev/null; then
  echo "Error: kubeseal not found. Install with: brew install kubeseal" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# Source .env file (handle commented lines)
set -a
source <(grep -v '^#' "$ENV_FILE" | grep -v '^$')
set +a

# Build secret from env vars (only include non-empty values)
SECRET_ARGS=()

# Slack credentials
[[ -n "$SLACK_BOT_TOKEN" ]] && SECRET_ARGS+=(--from-literal=slack-bot-token="$SLACK_BOT_TOKEN")
[[ -n "$SLACK_APP_TOKEN" ]] && SECRET_ARGS+=(--from-literal=slack-app-token="$SLACK_APP_TOKEN")
[[ -n "$SLACK_SIGNING_SECRET" ]] && SECRET_ARGS+=(--from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET")
[[ -n "$SLACK_CLIENT_ID" ]] && SECRET_ARGS+=(--from-literal=slack-client-id="$SLACK_CLIENT_ID")
[[ -n "$SLACK_CLIENT_SECRET" ]] && SECRET_ARGS+=(--from-literal=slack-client-secret="$SLACK_CLIENT_SECRET")

# Claude/Anthropic credentials
[[ -n "$ANTHROPIC_API_KEY" ]] && SECRET_ARGS+=(--from-literal=anthropic-api-key="$ANTHROPIC_API_KEY")
[[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]] && SECRET_ARGS+=(--from-literal=claude-code-oauth-token="$CLAUDE_CODE_OAUTH_TOKEN")

# Encryption key
[[ -n "$ENCRYPTION_KEY" ]] && SECRET_ARGS+=(--from-literal=encryption-key="$ENCRYPTION_KEY")

# Sentry
[[ -n "$SENTRY_DSN" ]] && SECRET_ARGS+=(--from-literal=sentry-dsn="$SENTRY_DSN")

# GitHub
[[ -n "$GITHUB_CLIENT_SECRET" ]] && SECRET_ARGS+=(--from-literal=github-client-secret="$GITHUB_CLIENT_SECRET")

# Telegram
[[ -n "$TELEGRAM_BOT_TOKEN" ]] && SECRET_ARGS+=(--from-literal=telegram-bot-token="$TELEGRAM_BOT_TOKEN")

# WhatsApp
[[ -n "$WHATSAPP_CREDENTIALS" ]] && [[ -f "$WHATSAPP_CREDENTIALS" ]] && \
  SECRET_ARGS+=(--from-file=whatsapp-credentials="$WHATSAPP_CREDENTIALS")

if [[ ${#SECRET_ARGS[@]} -eq 0 ]]; then
  echo "Error: No secrets found in .env file" >&2
  exit 1
fi

echo "Found ${#SECRET_ARGS[@]} secret(s) to seal" >&2

# Create and seal the secret
SEALED_SECRET=$(kubectl create secret generic lobu-secrets \
  "${SECRET_ARGS[@]}" \
  --dry-run=client -o yaml | \
kubeseal --controller-name=sealed-secrets-controller --controller-namespace=kube-system \
  --format yaml 2>/dev/null)

if [[ $? -ne 0 ]]; then
  echo "Error: Failed to seal secrets. Is the Sealed Secrets controller running?" >&2
  exit 1
fi

if [[ "$APPLY_DIRECT" == "true" ]]; then
  echo "$SEALED_SECRET" | kubectl apply -f -
  echo "SealedSecret applied to cluster" >&2
elif [[ -n "$OUTPUT_FILE" ]]; then
  echo "$SEALED_SECRET" > "$OUTPUT_FILE"
  echo "SealedSecret written to $OUTPUT_FILE" >&2
else
  echo "$SEALED_SECRET"
fi
