#!/usr/bin/env bash
set -euo pipefail

chart_dir="${1:-charts/lobu}"

render() {
  helm template lobu "$chart_dir" --namespace lobu "$@"
}

# The Service and the Deployment both carry `metadata.name: lobu-embeddings`, so
# matching the name alone concatenates two documents and lets a present-assertion
# be satisfied by the wrong one. Track `kind` and open the window only under the
# Deployment.
deployment() {
  awk '
    /^---$/ { kind = ""; keep = 0 }
    /^kind: / { kind = $2 }
    /^  name: lobu-embeddings$/ { if (kind == "Deployment") keep = 1 }
    keep { print }
  '
}

assert_absent() {
  local text="$1"
  local pattern="$2"
  if grep -qE "$pattern" <<<"$text"; then
    echo "unexpected rendered match: $pattern" >&2
    exit 1
  fi
}

assert_present() {
  local text="$1"
  local pattern="$2"
  grep -qE "$pattern" <<<"$text" || {
    echo "missing rendered match: $pattern" >&2
    exit 1
  }
}

default_render="$(render --set secretName=lobu-shared)"
default_embeddings="$(deployment <<<"$default_render")"
assert_present "$default_embeddings" '^      automountServiceAccountToken: false$'
assert_present "$default_embeddings" 'name: EMBEDDINGS_SERVICE_TOKEN'
assert_present "$default_embeddings" 'key: EMBEDDINGS_SERVICE_TOKEN'
assert_present "$default_embeddings" 'name: EMBEDDINGS_API_KEY'
assert_present "$default_embeddings" 'key: EMBEDDINGS_API_KEY'
# Asserted as an ABSENCE: EMBEDDINGS_SERVICE_TOKEN always renders `optional:
# true`, so a present-match here passes even if the API key is hardcoded
# `optional: false` -- which is the only value this test exists to pin.
assert_absent "$default_embeddings" 'optional: false'
assert_absent "$default_embeddings" '^          envFrom:'
assert_absent "$default_embeddings" 'key: (ENCRYPTION_KEY|BETTER_AUTH_SECRET|DATABASE_URL|DB_[A-Z_]+|WORKER_API_TOKEN|OPENAI_API_KEY|GOOGLE_[A-Z_]+|GITHUB_[A-Z_]+|SLACK_[A-Z_]+|OAUTH_[A-Z_]+|ARBITRARY_SHARED_KEY)$'

local_render="$(render --set secretName=lobu-shared --set embeddings.env.EMBEDDINGS_BACKEND=local --set embeddings.env.EMBEDDINGS_MODEL=local-model --set embeddings.env.EMBEDDINGS_BATCH_SIZE=8)"
local_embeddings="$(deployment <<<"$local_render")"
assert_present "$local_embeddings" 'name: EMBEDDINGS_BACKEND'
assert_present "$local_embeddings" 'value: "local"'
assert_present "$local_embeddings" 'name: EMBEDDINGS_MODEL'
assert_present "$local_embeddings" 'value: "local-model"'
assert_present "$local_embeddings" 'name: EMBEDDINGS_BATCH_SIZE'
assert_present "$local_embeddings" 'value: "8"'
assert_present "$local_embeddings" 'key: EMBEDDINGS_API_KEY'
assert_absent "$local_embeddings" 'optional: false'

openai_render="$(render --set secretName=lobu-shared --set embeddings.env.EMBEDDINGS_BACKEND=openai --set embeddings.env.EMBEDDINGS_MODEL=text-embedding-3-small --set embeddings.env.EMBEDDINGS_API_URL=https://api.openai.com/v1/embeddings)"
openai_embeddings="$(deployment <<<"$openai_render")"
assert_present "$openai_embeddings" 'value: "openai"'
assert_present "$openai_embeddings" 'value: "text-embedding-3-small"'
assert_present "$openai_embeddings" 'value: "https://api.openai.com/v1/embeddings"'
assert_present "$openai_embeddings" 'key: EMBEDDINGS_API_KEY'
assert_present "$openai_embeddings" 'optional: false'

disabled_render="$(render --set embeddings.enabled=false --set secretName=lobu-shared)"
assert_absent "$disabled_render" 'app.kubernetes.io/component: embeddings'

# An operator who clears the block entirely leaves `embeddings.env` null, not
# an empty map. The template's `default (dict)` guard is what keeps that from
# erroring on a range over nil, and `--set` cannot produce it.
null_env_values="$(mktemp)"
invalid_render="$(mktemp)"
trap 'rm -f "$null_env_values" "$invalid_render"' EXIT
printf 'secretName: lobu-shared\nembeddings:\n  env:\n' >"$null_env_values"
null_env_embeddings="$(deployment <<<"$(render -f "$null_env_values")")"
assert_present "$null_env_embeddings" 'name: EMBEDDINGS_SERVICE_TOKEN'
assert_absent "$null_env_embeddings" '^          envFrom:'

if render --set embeddings.env.PORT=9999 >"$invalid_render" 2>&1; then
  echo "expected chart-owned embeddings.env override to fail" >&2
  exit 1
fi
grep -q 'embeddings.env cannot override chart-owned PORT' "$invalid_render"

echo "embeddings secret projection renders default/local/openai/disabled paths without shared-secret leakage"
