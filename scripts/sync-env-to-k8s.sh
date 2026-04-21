#!/bin/bash
# Sync .env to Kubernetes secrets (for local development without Sealed Secrets)
#
# Usage:
#   ./scripts/sync-env-to-k8s.sh                # Sync to lobu namespace
#   ./scripts/sync-env-to-k8s.sh -n my-ns       # Sync to custom namespace

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_ROOT}/.env"
NAMESPACE="lobu"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -n|--namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [-n namespace]"
      echo ""
      echo "Syncs .env file to Kubernetes secrets"
      echo ""
      echo "Options:"
      echo "  -n, --namespace NS   Target namespace (default: lobu)"
      echo "  -h, --help           Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# Source .env file (handle commented lines)
# Use temp file instead of process substitution for compatibility
TEMP_ENV=$(mktemp)
grep -v '^#' "$ENV_FILE" | grep -v '^$' > "$TEMP_ENV"
set -a
source "$TEMP_ENV"
set +a
rm "$TEMP_ENV"

# Build secret args (only include non-empty values)
SECRET_ARGS=()
# shellcheck source=lib/secret-args.sh
source "$SCRIPT_DIR/lib/secret-args.sh"
build_secret_args

if [[ ${#SECRET_ARGS[@]} -eq 0 ]]; then
  echo "Error: No secrets found in .env file" >&2
  exit 1
fi

echo "Found ${#SECRET_ARGS[@]} secret(s) to sync" >&2

# Delete existing secret if it exists
kubectl delete secret lobu-secrets -n "$NAMESPACE" 2>/dev/null || true

# Create the secret with Helm labels for adoption
kubectl create secret generic lobu-secrets \
  -n "$NAMESPACE" \
  "${SECRET_ARGS[@]}"

# Add Helm labels so Helm can adopt the secrets
kubectl label secret lobu-secrets -n "$NAMESPACE" \
  app.kubernetes.io/managed-by=Helm --overwrite 2>/dev/null
kubectl annotate secret lobu-secrets -n "$NAMESPACE" \
  meta.helm.sh/release-name=lobu \
  meta.helm.sh/release-namespace="$NAMESPACE" --overwrite 2>/dev/null

echo "✅ Secrets synced to namespace: $NAMESPACE" >&2

# Trigger pod restart by patching the deployment with a new annotation
kubectl patch deployment lobu-gateway -n "$NAMESPACE" \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"secrets-sync\":\"$(date +%s)\"}}}}}" \
  2>/dev/null || echo "Note: Gateway deployment not found or not running" >&2
