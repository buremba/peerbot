#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
SCRIPT=$ROOT/scripts/lib/kubeconfig-preflight.sh
TMP=$(mktemp -d "${TMPDIR:-/tmp}/lobu-kubeconfig-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

STUBS=$TMP/stubs
mkdir "$STUBS"
KUBECTL_LOG=$TMP/kubectl.log
export KUBECTL_LOG

cat >"$STUBS/kubectl" <<'STUB'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$KUBECTL_LOG"
case "${KUBE_STUB_MODE:-happy}:$*" in
  wrong-context:config\ current-context) printf '%s\n' wrong-context ;;
  wrong-server:config\ view*) printf '%s\n' https://old.example.test ;;
  *:config\ current-context) printf '%s\n' lobu-prod ;;
  *:config\ view*) printf '%s\n' https://api.example.test ;;
  stale-ca:get\ --raw=/readyz*) exit 1 ;;
  stale-auth:get\ --raw=/readyz*) exit 1 ;;
  wrong-uid:get\ namespace*) printf '%s\n' old-cluster-uid ;;
  *:get\ namespace*) printf '%s\n' cluster-uid ;;
  insufficient-rbac:auth\ can-i*) exit 1 ;;
  *:auth\ can-i*) printf '%s\n' yes ;;
esac
STUB
chmod 700 "$STUBS/kubectl"
export PATH="$STUBS:$PATH"

config_b64=$(printf '%s' 'apiVersion: v1
clusters: []
contexts: []
users:
  - token: kubeconfig-secret-sentinel' | base64 | tr -d '\n')

run_setup() {
  mode=$1
  runner_dir=$TMP/runner-$mode
  github_env=$TMP/github-env-$mode
  mkdir -p "$runner_dir"
  : >"$KUBECTL_LOG"
  : >"$github_env"
  env \
    RUNNER_TEMP="$runner_dir" \
    KUBE_STUB_MODE="$mode" \
    KUBECONFIG_B64="$config_b64" \
    KUBE_EXPECTED_CONTEXT=lobu-prod \
    KUBE_EXPECTED_SERVER=https://api.example.test \
    KUBE_EXPECTED_CLUSTER_UID=cluster-uid \
    KUBE_REQUIRED_CAPABILITIES='get|namespaces|
list|ingresses.networking.k8s.io|@ALL_NAMESPACES
get|services|@PREVIEW_NS
get|secrets|@WILDCARD_TLS_NS' \
    PREVIEW_NS=lobu-preview-1 \
    WILDCARD_TLS_NS=summaries-prod \
    GITHUB_ENV="$github_env" \
    "$SCRIPT" setup
}

assert_cleanup_refuses() {
  label=$1
  config=$2
  sentinel=$3
  if RUNNER_TEMP="$TMP/runner-happy" KUBECONFIG="$config" \
    "$SCRIPT" cleanup >"$TMP/stdout" 2>"$TMP/stderr"; then
    echo "expected cleanup to reject $label" >&2
    exit 1
  fi
  grep -q 'refusing to remove a non-temporary kubeconfig path' "$TMP/stderr"
  grep -q "$sentinel" "$config"
}

assert_kubectl_log_is_read_only() {
  if grep -Ev '^(config|get|auth can-i)( |$)' "$KUBECTL_LOG" | grep -q .; then
    echo 'preflight attempted a Kubernetes mutation after validation failed' >&2
    exit 1
  fi
}

assert_fails_without_mutation() {
  mode=$1
  if run_setup "$mode" >"$TMP/stdout" 2>"$TMP/stderr"; then
    echo "expected $mode to fail the kubeconfig preflight" >&2
    exit 1
  fi
  assert_kubectl_log_is_read_only
  if grep -Eq 'apiVersion|clusters:|users:|BEGIN |token|certificate|kubeconfig-secret-sentinel' \
    "$TMP/stdout" "$TMP/stderr"; then
    echo 'preflight leaked kubeconfig material after validation failed' >&2
    exit 1
  fi
  grep -q 'refusing Kubernetes mutation' "$TMP/stderr"
  [ -z "$(find "$TMP/runner-$mode" -type f -name 'lobu-kubeconfig.*' -print)" ]
}

assert_fails_without_mutation wrong-context
assert_fails_without_mutation wrong-server
assert_fails_without_mutation stale-ca
assert_fails_without_mutation stale-auth
assert_fails_without_mutation wrong-uid
assert_fails_without_mutation insufficient-rbac

: >"$KUBECTL_LOG"
mkdir -p "$TMP/runner-malformed"
if env \
  RUNNER_TEMP="$TMP/runner-malformed" \
  KUBECONFIG_B64='not base64' \
  KUBE_EXPECTED_CONTEXT=lobu-prod \
  KUBE_EXPECTED_SERVER=https://api.example.test \
  KUBE_EXPECTED_CLUSTER_UID=cluster-uid \
  KUBE_REQUIRED_CAPABILITIES='get|namespaces|' \
  GITHUB_ENV="$TMP/github-env-malformed" \
  "$SCRIPT" setup >"$TMP/stdout" 2>"$TMP/stderr"; then
  echo 'expected malformed base64 to fail' >&2
  exit 1
fi
grep -q 'valid base64' "$TMP/stderr"
if grep -q 'not base64' "$TMP/stdout" "$TMP/stderr"; then
  echo 'preflight leaked malformed credential input' >&2
  exit 1
fi
assert_kubectl_log_is_read_only
[ -z "$(find "$TMP/runner-malformed" -type f -name 'lobu-kubeconfig.*' -print)" ]

: >"$KUBECTL_LOG"
mkdir -p "$TMP/runner-empty"
if env \
  RUNNER_TEMP="$TMP/runner-empty" \
  KUBECONFIG_B64='' \
  KUBE_EXPECTED_CONTEXT=lobu-prod \
  KUBE_EXPECTED_SERVER=https://api.example.test \
  KUBE_EXPECTED_CLUSTER_UID=cluster-uid \
  KUBE_REQUIRED_CAPABILITIES='get|namespaces|' \
  GITHUB_ENV="$TMP/github-env-empty" \
  "$SCRIPT" setup >"$TMP/stdout" 2>"$TMP/stderr"; then
  echo 'expected empty base64 to fail' >&2
  exit 1
fi
grep -q 'credential secret is empty' "$TMP/stderr"
grep -q 'refusing Kubernetes mutation' "$TMP/stderr"
[ ! -s "$KUBECTL_LOG" ]
[ -z "$(find "$TMP/runner-empty" -type f -name 'lobu-kubeconfig.*' -print)" ]

: >"$KUBECTL_LOG"
run_setup happy >"$TMP/stdout" 2>"$TMP/stderr"
config_path=$(sed -n 's/^KUBECONFIG=//p' "$TMP/github-env-happy")
[ -n "$config_path" ]
[ -n "$(find "$config_path" -prune -perm 600 -print)" ]
[ -f "$config_path" ]
grep -q 'Kubernetes kubeconfig preflight passed' "$TMP/stdout"
grep -q 'auth can-i get namespaces --quiet' "$KUBECTL_LOG"
grep -q 'auth can-i list ingresses.networking.k8s.io --all-namespaces --quiet' "$KUBECTL_LOG"
grep -q 'auth can-i get services -n lobu-preview-1 --quiet' "$KUBECTL_LOG"
grep -q 'auth can-i get secrets -n summaries-prod --quiet' "$KUBECTL_LOG"
RUNNER_TEMP="$TMP/runner-happy" KUBECONFIG="$config_path" "$SCRIPT" cleanup
[ ! -e "$config_path" ]

# Both cleanup guards have to refuse on their own, so exercise each in
# isolation: a foreign name inside RUNNER_TEMP, then our own name outside it.
foreign_name=$TMP/runner-happy/operator-config
printf '%s\n' keep-foreign-name >"$foreign_name"
assert_cleanup_refuses 'a foreign filename inside RUNNER_TEMP' "$foreign_name" keep-foreign-name

foreign_dir=$TMP/lobu-kubeconfig.decoy
printf '%s\n' keep-foreign-dir >"$foreign_dir"
assert_cleanup_refuses 'a matching filename outside RUNNER_TEMP' "$foreign_dir" keep-foreign-dir

# ..and the directory comparison must be exact, not a prefix match.
mkdir "$TMP/runner-happy/lobu-kubeconfig.escape"
escaped_config=$TMP/operator-config-escape
printf '%s\n' keep-escaped >"$escaped_config"
assert_cleanup_refuses 'a traversal-shaped kubeconfig path' \
  "$TMP/runner-happy/lobu-kubeconfig.escape/../../operator-config-escape" keep-escaped

echo 'kubeconfig preflight tests passed'
