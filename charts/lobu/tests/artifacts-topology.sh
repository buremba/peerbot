#!/usr/bin/env bash
set -euo pipefail

chart_dir="${1:-charts/lobu}"
render() {
  helm template topology-test "$chart_dir" "$@"
}

default_render="$(render)"
grep -q 'value: "/tmp/lobu-artifacts"' <<<"$default_render"

rwo_render="$(render --set app.artifacts.enabled=true --set app.replicaCount=1 --set app.artifacts.accessMode=ReadWriteOnce)"
grep -q 'accessModes:' <<<"$rwo_render"
grep -q -- '- ReadWriteOnce' <<<"$rwo_render"
grep -q 'mountPath: /var/lib/lobu/artifacts' <<<"$rwo_render"
grep -q 'value: "/var/lib/lobu/artifacts"' <<<"$rwo_render"

rwx_render="$(render --set app.artifacts.enabled=true --set app.replicaCount=2 --set app.artifacts.accessMode=ReadWriteMany)"
grep -q -- '- ReadWriteMany' <<<"$rwx_render"
grep -q 'replicas: 2' <<<"$rwx_render"

if render --show-only templates/deployment.yaml --set app.artifacts.enabled=true --set app.replicaCount=2 --set app.artifacts.accessMode=ReadWriteOnce >/dev/null 2>&1; then
  echo "expected multi-replica ReadWriteOnce artifact storage to fail" >&2
  exit 1
fi

if render --set app.artifacts.enabled=true --set app.env.LOBU_ARTIFACTS_DIR=/tmp/wrong >/dev/null 2>&1; then
  echo "expected an artifact directory outside the PVC mount to fail" >&2
  exit 1
fi
