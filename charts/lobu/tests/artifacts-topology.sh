#!/usr/bin/env bash
set -euo pipefail

chart_dir="${1:-charts/lobu}"
render() {
  helm template topology-test "$chart_dir" "$@"
}

default_render="$(render)"
grep -q 'value: "/tmp/lobu-artifacts"' <<<"$default_render"

null_env_values="$(mktemp)"
trap 'rm -f "$null_env_values"' EXIT
printf 'app:\n  env:\n' >"$null_env_values"
render -f "$null_env_values" >/dev/null

rwo_render="$(render --set app.artifacts.enabled=true --set app.replicaCount=1 --set app.artifacts.accessMode=ReadWriteOnce)"
grep -q 'accessModes:' <<<"$rwo_render"
grep -q -- '- ReadWriteOnce' <<<"$rwo_render"
grep -q 'mountPath: /var/lib/lobu/artifacts' <<<"$rwo_render"
grep -q 'value: "/var/lib/lobu/artifacts"' <<<"$rwo_render"

rwx_render="$(render --set app.artifacts.enabled=true --set app.replicaCount=2 --set app.artifacts.accessMode=ReadWriteMany)"
grep -q -- '- ReadWriteMany' <<<"$rwx_render"
grep -q 'replicas: 2' <<<"$rwx_render"

# Assert on the guard's own message, not just a non-zero exit: any unrelated
# chart error would otherwise satisfy a bare "helm template failed" check and
# leave the topology guard untested.
expect_render_failure() {
  local expected="$1"
  shift
  local output
  if output="$(render "$@" 2>&1)"; then
    echo "expected rendering to fail: $expected" >&2
    exit 1
  fi
  if ! grep -qF "$expected" <<<"$output"; then
    echo "rendering failed for the wrong reason; wanted: $expected" >&2
    echo "$output" >&2
    exit 1
  fi
}

expect_render_failure \
  "requires app.artifacts.accessMode=ReadWriteMany" \
  --show-only templates/deployment.yaml \
  --set app.artifacts.enabled=true \
  --set app.replicaCount=2 \
  --set app.artifacts.accessMode=ReadWriteOnce

expect_render_failure \
  "app.env.LOBU_ARTIFACTS_DIR must equal app.artifacts.mountPath" \
  --set app.artifacts.enabled=true \
  --set app.env.LOBU_ARTIFACTS_DIR=/tmp/wrong
