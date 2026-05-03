#!/usr/bin/env bash
#
# End-to-end harness for `lobu apply` v1.
#
# Boots `start-local.ts` (auto-bootstraps an admin PAT on empty data dir),
# drives the CLI through create → noop → update → drift, and asserts the
# round-trip against PGlite.
#
# Idempotent: cleans up its own server, data dir, and project dir on exit.

set -euo pipefail

# ─── locations ─────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="/tmp/e2e-data"
PROJECT_DIR="/tmp/e2e-project"
SERVER_LOG="/tmp/e2e-server.log"
PORT=8801
SERVER_URL="http://localhost:${PORT}"
API_URL="${SERVER_URL}"
ORG_SLUG="dev"
SERVER_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> cleanup: killing server pid ${SERVER_PID}"
    kill "${SERVER_PID}" 2>/dev/null || true
    # Give it a moment, then SIGKILL if still alive.
    for _ in 1 2 3 4 5; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${DATA_DIR}" "${PROJECT_DIR}" 2>/dev/null || true
  if [[ ${exit_code} -ne 0 ]]; then
    echo "==> e2e FAILED (exit ${exit_code})"
    if [[ -f "${SERVER_LOG}" ]]; then
      echo "── server log (last 80 lines) ───────────────────────────────"
      tail -n 80 "${SERVER_LOG}" || true
      echo "─────────────────────────────────────────────────────────────"
    fi
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

# ─── pre-flight ────────────────────────────────────────────────────────
rm -rf "${DATA_DIR}" "${PROJECT_DIR}" "${SERVER_LOG}"
# Stale local build that the dev workflow occasionally produces.
rm -rf "${REPO_ROOT}/packages/owletto-cli/runtime" 2>/dev/null || true

# ─── 1. build ──────────────────────────────────────────────────────────
echo "==> step 1: build packages + CLI"
cd "${REPO_ROOT}"
make build-packages >/dev/null
(cd packages/cli && bun run build) >/dev/null

CLI_BIN="${REPO_ROOT}/packages/cli/bin/lobu.js"
if [[ ! -f "${CLI_BIN}" ]]; then
  echo "CLI binary not found at ${CLI_BIN}" >&2
  exit 1
fi
LOBU="node ${CLI_BIN}"

# ─── 2. start server ───────────────────────────────────────────────────
echo "==> step 2: start start-local.ts on :${PORT}"

# Unset DATABASE_URL — start-local.ts boots PGlite and writes its own
# socket URL into process.env. A pre-set DATABASE_URL would race with the
# socket bind.
env \
  -u DATABASE_URL \
  OWLETTO_DATA_DIR="${DATA_DIR}" \
  PORT="${PORT}" \
  HOST=127.0.0.1 \
  PG_SOCKET_PORT=0 \
  bun run "${REPO_ROOT}/packages/server/src/start-local.ts" \
    >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

echo "    server pid=${SERVER_PID} log=${SERVER_LOG}"

# Wait for /health.
for i in $(seq 1 60); do
  if curl -sf "${SERVER_URL}/health" >/dev/null 2>&1; then
    echo "    server up after ${i}s"
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "server died before becoming ready" >&2
    exit 1
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    echo "server did not become ready within 60s" >&2
    exit 1
  fi
done

# ─── 3. read bootstrap PAT ─────────────────────────────────────────────
echo "==> step 3: read bootstrap PAT"

# Wait briefly for the bootstrap path (runs after listen) to write the file.
PAT_FILE="${DATA_DIR}/bootstrap-pat.txt"
for i in $(seq 1 20); do
  if [[ -s "${PAT_FILE}" ]]; then break; fi
  sleep 0.5
done

if [[ ! -s "${PAT_FILE}" ]]; then
  echo "bootstrap PAT not written to ${PAT_FILE}" >&2
  exit 1
fi
PAT="$(cat "${PAT_FILE}")"
PAT="${PAT//$'\n'/}"
if [[ -z "${PAT}" || "${PAT}" != owl_pat_* ]]; then
  echo "bootstrap PAT looks malformed: ${PAT}" >&2
  exit 1
fi
echo "    PAT prefix: ${PAT:0:16}..."

# ─── 4. write sample project ───────────────────────────────────────────
echo "==> step 4: write sample lobu.toml + agent dir + models"
mkdir -p "${PROJECT_DIR}/agents/triage" "${PROJECT_DIR}/models"

cat > "${PROJECT_DIR}/lobu.toml" <<'TOML'
[agents.triage]
name = "Triage"
description = "Test triage agent for e2e harness"
dir = "./agents/triage"

[[agents.triage.providers]]
id = "anthropic"
model = "claude/sonnet-4-5"
key = "$ANTHROPIC_API_KEY"

[[agents.triage.platforms]]
type = "telegram"
config = { botToken = "$TELEGRAM_BOT_TOKEN", chatId = "12345" }

[memory.owletto]
enabled = true
org = "dev"
name = "Local Dev"
description = "Local dev memory"
models = "./models"
TOML

cat > "${PROJECT_DIR}/agents/triage/IDENTITY.md" <<'MD'
# Identity

You are a triage agent under e2e test.
MD

cat > "${PROJECT_DIR}/agents/triage/SOUL.md" <<'MD'
# Instructions

- Be concise.
MD

cat > "${PROJECT_DIR}/agents/triage/USER.md" <<'MD'
# User Context

- e2e harness driver
MD

cat > "${PROJECT_DIR}/models/person.yaml" <<'YAML'
version: 1
type: entity
slug: person
name: Person
description: Test person entity for e2e
metadata_schema:
  type: object
  properties:
    full_name:
      type: string
YAML

# ─── 5. configure CLI context + login ──────────────────────────────────
echo "==> step 5: configure CLI context + login with PAT"

# CLI config dir scoped to the test so we don't clobber the user's profile.
CLI_HOME="$(mktemp -d /tmp/e2e-clihome.XXXX)"
export HOME="${CLI_HOME}"
mkdir -p "${HOME}/.config/lobu"

# Add a context pointing at our local server, then mark it current.
${LOBU} context add e2e --api-url "${API_URL}" >/dev/null
${LOBU} context use e2e >/dev/null

# `lobu login --token <PAT>` saves the PAT verbatim (no OAuth round-trip).
LOGIN_OUT="$(${LOBU} login --token "${PAT}" --context e2e --force 2>&1 || true)"
echo "${LOGIN_OUT}" | sed 's/^/    /'

# Confirm credentials landed.
if ! grep -q "${PAT}" "${HOME}/.config/lobu/credentials.json" 2>/dev/null; then
  echo "credentials.json did not get the PAT" >&2
  echo "    HOME=${HOME}"
  ls -la "${HOME}/.config/lobu/" 2>&1 | sed 's/^/    /' || true
  cat "${HOME}/.config/lobu/credentials.json" 2>&1 | sed 's/^/    /' || true
  exit 1
fi

# Apply also looks at LOBU_API_TOKEN as a fast path; rely on it to dodge
# any context-resolution surprises in CI.
export LOBU_API_TOKEN="${PAT}"
export LOBU_CONTEXT=e2e
export LOBU_MEMORY_URL="${SERVER_URL}/mcp"

# ─── 6. fake secrets ───────────────────────────────────────────────────
export TELEGRAM_BOT_TOKEN="fake-tg-token-for-e2e"
export ANTHROPIC_API_KEY="fake-anth-key-for-e2e"

# ─── 7. dry-run ────────────────────────────────────────────────────────
echo "==> step 7: lobu apply --dry-run (expect creates)"
cd "${PROJECT_DIR}"
DRY_OUT="$(${LOBU} apply --dry-run --org "${ORG_SLUG}" --url "${SERVER_URL}" 2>&1)"
echo "${DRY_OUT}" | sed 's/^/    /'

# Assertions on dry-run output: at least one `+` per resource kind.
echo "${DRY_OUT}" | grep -E "\+\s+agent\s+triage" >/dev/null || {
  echo "dry-run missing '+ agent triage' line" >&2
  exit 1
}
echo "${DRY_OUT}" | grep -E "\+\s+platform" >/dev/null || {
  echo "dry-run missing '+ platform' line" >&2
  exit 1
}
echo "${DRY_OUT}" | grep -E "\+\s+entity[-_]type" >/dev/null || {
  echo "dry-run missing '+ entity-type' line" >&2
  exit 1
}

# ─── 8. apply --yes ────────────────────────────────────────────────────
echo "==> step 8: lobu apply --yes (expect success)"
APPLY_OUT="$(${LOBU} apply --yes --org "${ORG_SLUG}" --url "${SERVER_URL}" 2>&1)"
echo "${APPLY_OUT}" | sed 's/^/    /'
echo "${APPLY_OUT}" | grep -E "Apply complete" >/dev/null || {
  echo "apply did not report completion" >&2
  exit 1
}

# ─── 9. dry-run again — all noop ───────────────────────────────────────
echo "==> step 9: lobu apply --dry-run (expect noop)"
NOOP_OUT="$(${LOBU} apply --dry-run --org "${ORG_SLUG}" --url "${SERVER_URL}" 2>&1)"
echo "${NOOP_OUT}" | sed 's/^/    /'
if echo "${NOOP_OUT}" | grep -E "^\s*\+\s+(agent|platform|entity)" >/dev/null; then
  echo "second dry-run still shows + creates — not idempotent" >&2
  exit 1
fi
if echo "${NOOP_OUT}" | grep -E "^\s*~\s+(agent|platform|entity)" >/dev/null; then
  echo "second dry-run shows ~ updates — drift detected unexpectedly" >&2
  exit 1
fi

# ─── 10. mutate platform chatId, expect ~ update ──────────────────────
echo "==> step 10: edit platform chatId, expect platform update + restart"

# Same shape, different chatId.
sed -i.bak \
  -e 's/chatId = "12345"/chatId = "67890"/' \
  "${PROJECT_DIR}/lobu.toml"
rm -f "${PROJECT_DIR}/lobu.toml.bak"

UPDATE_OUT="$(${LOBU} apply --dry-run --org "${ORG_SLUG}" --url "${SERVER_URL}" 2>&1)"
echo "${UPDATE_OUT}" | sed 's/^/    /'
echo "${UPDATE_OUT}" | grep -E "~\s+platform" >/dev/null || {
  echo "expected '~ platform' line after edit" >&2
  exit 1
}
echo "${UPDATE_OUT}" | grep -E "will restart" >/dev/null || {
  echo "expected 'will restart' marker after platform config change" >&2
  exit 1
}

APPLY_UPDATE_OUT="$(${LOBU} apply --yes --org "${ORG_SLUG}" --url "${SERVER_URL}" 2>&1)"
echo "${APPLY_UPDATE_OUT}" | sed 's/^/    /'
echo "${APPLY_UPDATE_OUT}" | grep -E "Apply complete" >/dev/null || {
  echo "update apply did not complete" >&2
  exit 1
}

# ─── 11. verify rows landed in PG ──────────────────────────────────────
echo "==> step 11: verify rows in PG via REST"

AGENTS_JSON="$(curl -sf -H "Authorization: Bearer ${PAT}" "${SERVER_URL}/api/${ORG_SLUG}/agents")"
echo "${AGENTS_JSON}" | grep -q '"agentId":"triage"' || {
  echo "triage agent not found via /api/${ORG_SLUG}/agents" >&2
  echo "${AGENTS_JSON}"
  exit 1
}

PLATFORMS_JSON="$(curl -sf -H "Authorization: Bearer ${PAT}" "${SERVER_URL}/api/${ORG_SLUG}/agents/triage/platforms")"
echo "${PLATFORMS_JSON}" | grep -q '"platform":"telegram"' || {
  echo "telegram platform not found" >&2
  echo "${PLATFORMS_JSON}"
  exit 1
}

ENTITY_JSON="$(curl -sf -X POST \
  -H "Authorization: Bearer ${PAT}" \
  -H "Content-Type: application/json" \
  -d '{"schema_type":"entity_type","action":"list"}' \
  "${SERVER_URL}/api/${ORG_SLUG}/manage_entity_schema")"
echo "${ENTITY_JSON}" | grep -q '"slug":"person"' || {
  echo "person entity_type not found" >&2
  echo "${ENTITY_JSON}"
  exit 1
}

# ─── 12. cleanup handled by trap ───────────────────────────────────────
echo "==> step 12: e2e PASSED"
