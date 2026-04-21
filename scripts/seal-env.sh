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

set -euo pipefail

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

# Source .env file (handle commented lines, quote values for special chars)
TEMP_ENV=$(mktemp)
grep -v '^#' "$ENV_FILE" | grep -v '^$' | sed 's/^\([^=]*\)=\(.*\)$/\1="\2"/' > "$TEMP_ENV"
set -a
source "$TEMP_ENV"
set +a
rm -f "$TEMP_ENV"

# Build secret from env vars (only include non-empty values)
SECRET_ARGS=()
# shellcheck source=lib/secret-args.sh
source "$SCRIPT_DIR/lib/secret-args.sh"
build_secret_args

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
  --scope namespace-wide --format yaml)

if [[ "$APPLY_DIRECT" == "true" ]]; then
  echo "$SEALED_SECRET" | kubectl apply -f -
  echo "SealedSecret applied to cluster" >&2
elif [[ -n "$OUTPUT_FILE" ]]; then
  echo "$SEALED_SECRET" > "$OUTPUT_FILE"
  echo "SealedSecret written to $OUTPUT_FILE" >&2
else
  echo "$SEALED_SECRET"
fi
