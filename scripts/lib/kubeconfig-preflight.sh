#!/bin/sh
set -eu

# Securely install and validate the kubeconfig used by mutating workflows.
# Secret material is accepted only through KUBECONFIG_B64 and is never placed
# in an argument, log line, GitHub output, or GitHub environment value.
set +x

usage() {
  echo "usage: $0 setup|cleanup" >&2
  exit 2
}

fail() {
  echo "kubeconfig preflight failed: $1; refusing Kubernetes mutation" >&2
  exit 1
}

decode_base64() {
  if base64 --decode </dev/null >/dev/null 2>&1; then
    base64 --decode
  else
    base64 -D
  fi
}

setup() {
  umask 077

  [ -n "${KUBECONFIG_B64:-}" ] || fail "credential secret is empty"
  [ -n "${KUBE_EXPECTED_CONTEXT:-}" ] || fail "expected context is not configured"
  [ -n "${KUBE_EXPECTED_SERVER:-}" ] || fail "expected API server is not configured"
  [ -n "${KUBE_EXPECTED_CLUSTER_UID:-}" ] || fail "expected cluster fingerprint is not configured"
  [ -n "${KUBE_REQUIRED_CAPABILITIES:-}" ] || fail "required RBAC capabilities are not configured"
  [ -n "${GITHUB_ENV:-}" ] || fail "GITHUB_ENV is not available"

  temp_root=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
  config_path=
  capabilities_file=
  keep_config=0
  cleanup_setup() {
    [ -z "$capabilities_file" ] || rm -f "$capabilities_file"
    if [ "$keep_config" -eq 0 ] && [ -n "$config_path" ]; then
      rm -f "$config_path"
    fi
  }
  trap cleanup_setup 0
  trap 'cleanup_setup; exit 1' HUP INT TERM

  config_path=$(mktemp "$temp_root/lobu-kubeconfig.XXXXXX") ||
    fail "cannot create secure kubeconfig file"
  chmod 600 "$config_path" || fail "cannot protect kubeconfig file"

  if ! printf '%s' "$KUBECONFIG_B64" | decode_base64 >"$config_path" 2>/dev/null; then
    fail "credential secret is not valid base64"
  fi
  normalized_b64=$(printf '%s' "$KUBECONFIG_B64" | tr -d '\r\n')
  roundtrip_b64=$(base64 <"$config_path" 2>/dev/null | tr -d '\r\n') || {
    fail "credential secret is not valid base64"
  }
  [ "$roundtrip_b64" = "$normalized_b64" ] || {
    fail "credential secret is not valid base64"
  }
  [ -s "$config_path" ] || {
    fail "credential secret decoded to an empty kubeconfig"
  }

  export KUBECONFIG=$config_path

  kubectl config view >/dev/null 2>&1 || {
    fail "decoded credential is not a valid kubeconfig"
  }

  current_context=$(kubectl config current-context 2>/dev/null) || fail "cannot read kubeconfig context"
  [ "$current_context" = "$KUBE_EXPECTED_CONTEXT" ] || fail "unexpected kubeconfig context"

  server=$(kubectl config view --minify -o 'jsonpath={.clusters[0].cluster.server}' 2>/dev/null) ||
    fail "cannot read kubeconfig server"
  [ "$server" = "$KUBE_EXPECTED_SERVER" ] || fail "unexpected Kubernetes API server"

  kubectl get --raw=/readyz --request-timeout=15s >/dev/null 2>&1 ||
    fail "Kubernetes API TLS/auth reachability check failed"

  cluster_uid=$(kubectl get namespace kube-system -o 'jsonpath={.metadata.uid}' --request-timeout=15s 2>/dev/null) ||
    fail "cannot read cluster identity fingerprint"
  [ -n "$cluster_uid" ] || fail "cluster identity fingerprint is empty"
  [ "$cluster_uid" = "$KUBE_EXPECTED_CLUSTER_UID" ] || fail "unexpected cluster identity fingerprint"

  capabilities_file=$(mktemp "$temp_root/lobu-kube-capabilities.XXXXXX") ||
    fail "cannot prepare RBAC preflight"
  printf '%s\n' "$KUBE_REQUIRED_CAPABILITIES" >"$capabilities_file"
  while IFS='|' read -r verb resource namespace; do
    [ -n "$verb$resource$namespace" ] || continue
    all_namespaces=0
    case "$namespace" in
      @PREVIEW_NS)
        [ -n "${PREVIEW_NS:-}" ] || fail "preview namespace is not configured"
        namespace=$PREVIEW_NS
        ;;
      @WILDCARD_TLS_NS)
        [ -n "${WILDCARD_TLS_NS:-}" ] || fail "wildcard TLS namespace is not configured"
        namespace=$WILDCARD_TLS_NS
        ;;
      @ALL_NAMESPACES) namespace=; all_namespaces=1 ;;
    esac
    [ -n "$verb" ] && [ -n "$resource" ] || fail "invalid RBAC preflight configuration"
    if [ "$all_namespaces" -eq 1 ]; then
      kubectl auth can-i "$verb" "$resource" --all-namespaces --quiet >/dev/null 2>&1 ||
        fail "required Kubernetes access is not granted"
    elif [ -n "${namespace:-}" ]; then
      kubectl auth can-i "$verb" "$resource" -n "$namespace" --quiet >/dev/null 2>&1 ||
        fail "required Kubernetes access is not granted"
    else
      kubectl auth can-i "$verb" "$resource" --quiet >/dev/null 2>&1 ||
        fail "required Kubernetes access is not granted"
    fi
  done <"$capabilities_file"

  rm -f "$capabilities_file"
  capabilities_file=
  # GitHub persists only the path for later steps; never persist the secret.
  printf 'KUBECONFIG=%s\n' "$config_path" >>"$GITHUB_ENV"
  keep_config=1
  echo "Kubernetes kubeconfig preflight passed for $KUBE_EXPECTED_CONTEXT"
}

cleanup() {
  config_path=${KUBECONFIG:-}
  if [ -n "$config_path" ] && [ -f "$config_path" ]; then
    temp_root=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
    case "$config_path" in
      "$temp_root"/lobu-kubeconfig.*) ;;
      *) fail "refusing to remove a non-temporary kubeconfig path" ;;
    esac
    rm -f "$config_path"
  fi
}

[ "$#" -eq 1 ] || usage
case "$1" in
  setup) setup ;;
  cleanup) cleanup ;;
  *) usage ;;
esac
