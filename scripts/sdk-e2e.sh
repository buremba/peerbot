#!/usr/bin/env bash
#
# SDK lifecycle end-to-end gate.
#
# Proves the WHOLE TypeScript-SDK path actually runs — not just that config maps
# correctly (unit/integration cover that), but that `lobu run` boots, auto-applies
# a project, exercises prune, and an agent completes a real turn through a spawned
# worker. Runs against a DETERMINISTIC mock OpenAI-compatible provider (see
# scripts/sdk-e2e/), so it needs no provider key and is reproducible in CI.
#
# It asserts, failing (non-zero exit → red CI) on any miss:
#   1. lobu run auto-applies the fixture → "Apply complete" (NOT halted). With a
#      prune:true fixture this also guards the system-type ($member) exemption —
#      an un-exempted prune halts every apply.
#   2. every declared definition is created (agent, entity/relationship types,
#      watcher).
#   3. `lobu chat` drives a real turn through the worker → the mock's reply.
#   4. a stable re-apply is idempotent (0 deletes).
#
# Usage: scripts/sdk-e2e.sh         (embedded Postgres, the default)
#        DATABASE_URL=... scripts/sdk-e2e.sh   (use an external Postgres)
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$WT/scripts/sdk-e2e"
LOBU="node $WT/packages/cli/bin/lobu.js"
GW_PORT="${GW_PORT:-8793}"
MOCK_PORT="${MOCK_PORT:-11434}"
MOCK_REPLY="SDK_E2E_OK"
RUN_DIR="$WT/.sdk-e2e-run"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
CHAT_OUT="$RUN_DIR/chat.out"

# Node 22-24 is required (the worker uses isolated-vm). Prefer a Homebrew node@22
# locally; CI provides node via actions/setup-node.
if [ -x /opt/homebrew/opt/node@22/bin/node ] && ! node --version 2>/dev/null | grep -qE '^v(22|23|24)\.'; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "❌ SDK e2e FAILED: $*" >&2; [ -f "$RUN_LOG" ] && { echo "--- last 40 lines of run.log ---" >&2; tail -40 "$RUN_LOG" >&2; }; exit 1; }

echo "▶ node $(node --version), gateway :$GW_PORT, mock :$MOCK_PORT"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR"
cleanup  # free ports from any prior run

# 0) Make embedded Postgres self-contained on Linux. The @embedded-postgres PG18
# binaries are NEEDED-linked against ICU 60 with an rpath of `$ORIGIN/../lib`,
# and that lib dir already SHIPS libicu{uc,i18n,data}.so.60.2 — it's only missing
# the `.so.60` SONAME symlinks the loader looks for. We create them (idempotent),
# so initdb loads its bundled ICU with NO system install, NO LD_LIBRARY_PATH and
# NO archive .deb download — identical in CI and on a local Linux dev box. No-op
# on macOS (its bundled .dylibs resolve already). Embedded PG only matters when
# DATABASE_URL is unset (the `lobu run` path); prod uses external Postgres.
if [ -z "${DATABASE_URL:-}" ]; then
  node "$HARNESS/fix-embedded-pg-icu.mjs" || fail "could not prepare embedded-postgres ICU symlinks"
fi

# 1) Mock OpenAI-compatible provider.
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" node "$HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true  # silence job-control "Killed" on cleanup
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || fail "mock server did not come up"
echo "✓ mock provider up"

# 2) Scaffold a project (inside the repo so jiti resolves the workspace @lobu/cli/config).
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
( cd "$PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -f "$PROJ/package.json"
cat > "$PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, defineConnection, defineEntityType, defineRelationshipType, defineWatcher, secret } from "@lobu/cli/config";

const agent = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
const company = defineEntityType({ key: "company", name: "Company" });
const contact = defineEntityType({ key: "contact", name: "Contact" });
const worksAt = defineRelationshipType({ key: "works-at", name: "Works at", rules: [{ source: contact, target: company }] });

// A local connector (./connectors/pulse.connector.ts) + a connection that wires
// its single feed. The gate triggers a sync via the API and asserts the
// connector's compiled code actually RAN and emitted ≥1 event — proving the
// whole compile→install→spawn→sync→persist path, not just that apply mapped it.
const pulseConn = defineConnection({
  slug: "pulse", connector: "sdke2e-pulse", name: "SDK e2e pulse",
  feeds: [{ feed: "pulse", name: "Pulse" }],
});

// The watcher runs an LLM extraction then a reaction script
// (./reactions/digest.reaction.ts) that writes an assertable knowledge event.
// `sources` selects the connector-emitted events by connector_key so the
// watcher's window has linked content — the reaction only fires on a non-empty
// window. The gate drives read_knowledge → complete_window deterministically
// (the agentic LLM turn never produces the complete_window tool-call against a
// fixed-reply mock) and asserts the reaction's side effect.
const digest = defineWatcher({
  slug: "digest", agent, name: "Digest", prompt: "summarize",
  extractionSchema: { type: "object", properties: { s: { type: "string" } } },
  reaction: "./reactions/digest.reaction.ts",
  sources: {
    content:
      "SELECT id, title, payload_text, author_name, occurred_at, origin_type FROM events WHERE connector_key = 'sdke2e-pulse' ORDER BY occurred_at DESC LIMIT 100",
  },
});

// prune:true so the gate exercises the destructive path on every run (this is
// what catches the system-type $member halt class of bug).
export default defineConfig({ prune: true, agents: [agent], entities: [company, contact], relationships: [worksAt], connections: [pulseConn], watchers: [digest] });
TS

# Local connector: deterministic, zero-dep, no network. `sync()` returns one
# fresh event per run (a monotonic origin_id off the checkpoint so re-syncs add
# rows rather than dedup to nothing). Proves the compiled ConnectorRuntime runs.
mkdir -p "$PROJ/connectors"
cat > "$PROJ/connectors/pulse.connector.ts" <<'TS'
import { ConnectorRuntime, type SyncContext, type SyncResult } from "@lobu/connector-sdk";

interface Checkpoint {
  seq: number;
}

/**
 * SDK e2e pulse connector — emits one deterministic event per sync. No fetch,
 * no auth, no deps: the gate is testing that a compiled local connector RUNS
 * and persists events, not any external integration.
 */
export default class PulseConnector extends ConnectorRuntime<Checkpoint> {
  readonly definition = {
    key: "sdke2e-pulse",
    name: "SDK e2e pulse",
    version: "1.0.0",
    authSchema: { methods: [{ type: "none" as const }] },
    feeds: { pulse: { key: "pulse", name: "Pulse" } },
  };

  async sync(ctx: SyncContext<Checkpoint>): Promise<SyncResult<Checkpoint>> {
    const seq = (ctx.checkpoint?.seq ?? 0) + 1;
    return {
      events: [
        {
          origin_id: `sdke2e-pulse-${seq}`,
          origin_type: "pulse",
          title: "SDK e2e pulse",
          payload_text: `SDKE2E_PULSE_EVENT seq=${seq}`,
          occurred_at: new Date(),
          metadata: { seq },
        },
      ],
      checkpoint: { seq },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
TS

# Watcher reaction: writes a deterministic, assertable knowledge event when the
# window completes. Kept in its own file so the SDK type-checks it.
mkdir -p "$PROJ/reactions"
cat > "$PROJ/reactions/digest.reaction.ts" <<'TS'
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export default async (ctx: ReactionContext, client: ReactionClient): Promise<void> => {
  await client.knowledge.save({
    content: "SDKE2E_REACTION_OK",
    semantic_type: "summary",
    metadata: {
      watcher_slug: ctx.watcher.slug,
      window_id: ctx.window.id,
      content_analyzed: ctx.window.content_analyzed,
    },
  });
};
TS

# Project env: mock key, allow loopback egress (mock provider), embedded PG unless
# DATABASE_URL was provided. Lead with a newline so the first line can't glue
# onto a scaffolded .env that lacks a trailing newline.
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  # The orchestrator wraps Linux workers in `systemd-run --user --scope` for
  # cgroup/network limits; CI runners have no user systemd session, so that
  # spawn fails. Disable it here — the worker only talks to the loopback mock,
  # and this gate isn't testing the prod network sandbox. No-op on macOS.
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  [ -n "${DATABASE_URL:-}" ] && echo "DATABASE_URL=$DATABASE_URL"
} >> "$PROJ/.env"

export LOBU_PROVIDER_REGISTRY_PATH="$HARNESS/providers.json"

# 2c) Static CLI checks (no server needed): the typed-config validator and the
# doctor health check. doctor must NOT false-fail the DB check on the scaffold's
# embedded `DATABASE_URL=file://.` — it once fed that path straight to
# postgres(), which parses host "." and dies with `getaddrinfo ENOTFOUND .`.
# We assert the embedded backend is recognized and that no connect error is
# printed. doctor's own exit code is ignored: the gateway isn't up yet, so its
# "server unreachable" check is expected to trip independently of the DB line.
VALIDATE_OUT="$RUN_DIR/validate.out"
( cd "$PROJ" && $LOBU validate > "$VALIDATE_OUT" 2>&1 ) || { cat "$VALIDATE_OUT" >&2; fail "lobu validate failed on the fixture config"; }
grep -qi "is valid" "$VALIDATE_OUT" || { cat "$VALIDATE_OUT" >&2; fail "lobu validate did not report the config valid"; }
echo "✓ lobu validate accepts the fixture config"

DOCTOR_OUT="$RUN_DIR/doctor.out"
( cd "$PROJ" && $LOBU doctor > "$DOCTOR_OUT" 2>&1 ) || true  # non-zero ok (gateway not up yet)
if grep -qiE "connect failed|ENOTFOUND" "$DOCTOR_OUT"; then cat "$DOCTOR_OUT" >&2; fail "lobu doctor false-failed the DB check (embedded file:// fed to postgres())"; fi
# The embedded-recognition message only applies when running against embedded PG
# (the default). With an external DATABASE_URL, doctor connects for real instead.
if [ -z "${DATABASE_URL:-}" ]; then
  grep -qi "embedded Postgres" "$DOCTOR_OUT" || { cat "$DOCTOR_OUT" >&2; fail "lobu doctor did not recognize the embedded Postgres backend"; }
fi
echo "✓ lobu doctor reports a healthy DB (no false connect failure on embedded file://)"

# 3) Boot lobu run — it auto-applies the project (the apply + prune E2E).
( cd "$PROJ" && $LOBU run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
for _ in $(seq 1 80); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done

grep -qi "Apply complete" "$RUN_LOG" || fail "auto-apply did not complete (skipped/halted?)"
grep -qiE "Apply halted" "$RUN_LOG" && fail "apply halted on a failure"
echo "✓ lobu run auto-applied the project (Apply complete)"

# 2b) Every declared definition created.
for marker in "+ entity-type company" "+ entity-type contact" "+ relationship-type works-at" "+ watcher digest"; do
  grep -qF "$marker" "$RUN_LOG" || fail "expected created definition not in plan: '$marker'"
done
# System $member must be ignorable drift, never a delete row (the prune-halt bug).
grep -qiE "entity-type .member \(removed from config — will be deleted\)|delete.*\\\$member" "$RUN_LOG" && fail "prune tried to delete the system \$member type"
echo "✓ all definitions created; \$member not pruned"

# 4) A real agent turn through the worker.
( cd "$PROJ" && timeout 90 $LOBU chat "say the safe word" -c local > "$CHAT_OUT" 2>&1 ) || fail "lobu chat exited non-zero"
grep -qF "$MOCK_REPLY" "$CHAT_OUT" || fail "agent turn did not return the mock reply '$MOCK_REPLY' (got: $(tr -d '\n' < "$CHAT_OUT" | tail -c 200))"
grep -qiE "Forwarding to upstream: POST http://127.0.0.1:$MOCK_PORT" "$RUN_LOG" || fail "worker never called the mock provider upstream"
echo "✓ agent completed a real turn through the worker (reply: $MOCK_REPLY)"

# ── API setup for the connector/watcher assertions ────────────────────────────
# Mint a personal access token bound to the loopback `local` context, and
# resolve the org slug the bootstrap auto-provisioned (don't hardcode it).
# trigger_feed / watcher trigger / complete_window / query_sql are owner-admin
# tools (tool-access.ts), so mint with mcp:admin — the local-install user is the
# org owner.
GW="http://localhost:$GW_PORT"
TOKEN="$( ( cd "$PROJ" && $LOBU token create -c local --scope "mcp:read mcp:write mcp:admin" --json 2>/dev/null ) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})' )"
[ -n "$TOKEN" ] || fail "could not mint a local API token (lobu token create -c local --json)"
ORG="$( ( cd "$PROJ" && $LOBU org current -c local 2>/dev/null ) | grep -oE '[a-z0-9][a-z0-9-]*' | grep -v '^local$' | tail -1 )"
[ -n "$ORG" ] || fail "could not resolve the local org slug (lobu org current -c local)"
echo "▶ API: org=$ORG token=…${TOKEN: -6}"

# POST a tool call through the generic /api/:org/:tool proxy. Args = $2 (JSON).
api() {
  curl -fsS -X POST "$GW/api/$ORG/$1" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$2"
}
# Extract a JSON field from stdin with node (no jq dependency).
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(2)};for(const k of process.argv[1].split("."))v=v?.[k];process.stdout.write(v==null?"":String(v))})' "$1"; }

# 4b) Client SDK consumption — drive @lobu/client (the CONSUMPTION SDK) against
#     the live gateway: create a session, send a message, stream the reply back.
#     This is the path an external JS app takes; the rest of the gate chats via
#     the `lobu chat` CLI, so without this the consumption SDK has no live-server
#     coverage (only unit tests vs mocked fetch). The consumer installs the
#     PACKED tarball into a throwaway project, proving the published artifact is
#     self-contained (zero deps). The Agent API requires a `device_worker:run`
#     token — an mcp PAT is rejected — so fetch the device_token from
#     /api/local-init (the same worker PAT `lobu chat` uses via getAgentApiToken).
CLIENT_DIR="$RUN_DIR/client-consumer"; mkdir -p "$CLIENT_DIR"
( cd "$WT/packages/client" && bun pm pack --destination "$CLIENT_DIR" >/dev/null 2>&1 ) \
  || fail "could not pack @lobu/client (was dist built by make build-packages?)"
CLIENT_TGZ="$(ls "$CLIENT_DIR"/lobu-client-*.tgz 2>/dev/null | head -1)"
[ -n "$CLIENT_TGZ" ] || fail "no @lobu/client tarball produced"
cat > "$CLIENT_DIR/package.json" <<JSON
{ "name": "sdk-e2e-consumer", "private": true, "type": "module", "dependencies": { "@lobu/client": "file:$CLIENT_TGZ" } }
JSON
cp "$HARNESS/client-consumer.mjs" "$CLIENT_DIR/consumer.mjs"
( cd "$CLIENT_DIR" && bun install >/dev/null 2>&1 ) \
  || fail "could not install the @lobu/client tarball into the consumer project"

DEVTOKEN="$(curl -fsS -X POST "$GW/api/local-init" -H 'X-Lobu-Client: cli' | jget device_token)"
[ -n "$DEVTOKEN" ] || fail "could not obtain an Agent-API token (device_token) from /api/local-init"

CLIENT_OUT="$RUN_DIR/client-consumer.out"
( cd "$CLIENT_DIR" && LOBU_BASE_URL="$GW/lobu" LOBU_TOKEN="$DEVTOKEN" LOBU_AGENT_ID="echo" \
    timeout 90 node consumer.mjs > "$CLIENT_OUT" 2>&1 ) \
  || { cat "$CLIENT_OUT" >&2; fail "@lobu/client consumer exited non-zero"; }
grep -qF "$MOCK_REPLY" "$CLIENT_OUT" \
  || { cat "$CLIENT_OUT" >&2; fail "@lobu/client stream did not return the agent reply '$MOCK_REPLY'"; }
echo "✓ @lobu/client created a session, sent a message, and streamed the agent reply ($MOCK_REPLY)"

# 6) Connector sync — prove the COMPILED connector actually RUNS and emits events.
#    Find the feed manage_feeds created from the `pulse` connection, trigger an
#    immediate sync, wait for the run to complete, then assert ≥1 event landed.
FEEDS="$RUN_DIR/feeds.json"
api manage_feeds '{"action":"list_feeds"}' > "$FEEDS" || fail "manage_feeds list_feeds failed"
FEED_ID="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=(j.feeds||[]).find(x=>x.feed_key==="pulse");process.stdout.write(f?String(f.id):"")})' < "$FEEDS")"
[ -n "$FEED_ID" ] || { cat "$FEEDS" >&2; fail "no 'pulse' feed found after apply (connection/feed not created?)"; }
echo "✓ apply created the pulse feed (id=$FEED_ID)"

api manage_feeds "{\"action\":\"trigger_feed\",\"feed_id\":$FEED_ID}" > "$RUN_DIR/trigger-feed.json" || { cat "$RUN_DIR/trigger-feed.json" >&2; fail "trigger_feed failed"; }

# Poll get_feed until the most recent sync run reaches a terminal state. Parse
# status/items with separate guarded node calls (process substitution + `read`
# trips `set -e` on a newline-less EOF), so the loop survives transient misses.
SYNC_OK=""; RUN_ITEMS=0
for _ in $(seq 1 90); do
  api manage_feeds "{\"action\":\"get_feed\",\"feed_id\":$FEED_ID}" > "$RUN_DIR/get-feed.json" 2>/dev/null || { sleep 1; continue; }
  RUN_STATUS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("none");return}const r=(j.recent_runs||[])[0]||{};process.stdout.write(String(r.status||"none"))})' < "$RUN_DIR/get-feed.json" || echo none)"
  RUN_ITEMS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("0");return}const r=(j.recent_runs||[])[0]||{};process.stdout.write(String(r.items_collected??0))})' < "$RUN_DIR/get-feed.json" || echo 0)"
  case "$RUN_STATUS" in
    completed) SYNC_OK=1; break ;;
    failed|error) cat "$RUN_DIR/get-feed.json" >&2; fail "connector sync run ended in status '$RUN_STATUS'" ;;
  esac
  sleep 1
done
[ -n "$SYNC_OK" ] || { cat "$RUN_DIR/get-feed.json" >&2; fail "connector sync run did not complete within timeout"; }

# Assert the connector emitted ≥1 event (items_collected on the run AND the
# feed-level event_count from list_feeds).
[ "${RUN_ITEMS:-0}" -ge 1 ] 2>/dev/null || fail "sync run completed but collected 0 items"
api manage_feeds '{"action":"list_feeds"}' > "$FEEDS" || fail "manage_feeds list_feeds (post-sync) failed"
EVENT_COUNT="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=(j.feeds||[]).find(x=>x.feed_key==="pulse");process.stdout.write(f?String(f.event_count??0):"0")})' < "$FEEDS")"
[ "${EVENT_COUNT:-0}" -ge 1 ] 2>/dev/null || fail "connector sync persisted 0 events (event_count=$EVENT_COUNT)"
echo "✓ connector sync ran the compiled connector and emitted events (items=$RUN_ITEMS, event_count=$EVENT_COUNT)"

# 7) Watcher reaction — prove the reaction script RUNS and produces a side
#    effect. Trigger the watcher (proves the dispatch path doesn't error), then
#    deterministically drive read_knowledge → complete_window so the reaction
#    fires regardless of the fixed-reply mock (the agentic turn would never
#    produce a complete_window tool-call). The reaction saves SDKE2E_REACTION_OK.
WATCHERS="$RUN_DIR/watchers.json"
api list_watchers '{}' > "$WATCHERS" 2>/dev/null || fail "could not list watchers"
WATCHER_ID="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const arr=j.watchers||j.items||(Array.isArray(j)?j:[]);const w=arr.find(x=>x.slug==="digest")||arr[0];const id=w?(w.watcher_id??w.id):null;process.stdout.write(id!=null?String(id):"")})' < "$WATCHERS")"
[ -n "$WATCHER_ID" ] || { cat "$WATCHERS" >&2; fail "no 'digest' watcher found after apply"; }
echo "✓ apply created the digest watcher (id=$WATCHER_ID)"

# Trigger the watcher — exercise the FULL dispatch path. This mints an internal
# service token (needs the `lobu-internal` oauth_client, ensured by
# getLobuServiceToken) and dispatches a watcher run to a spawned worker. We
# assert the trigger returns a run_id, that dispatch did NOT fail on the service
# token (the regression this guards — a missing `lobu-internal` client fails
# every watcher run), and that a watcher worker session actually started.
TW="$RUN_DIR/trigger-watcher.json"
api manage_watchers "{\"action\":\"trigger\",\"watcher_id\":\"$WATCHER_ID\"}" > "$TW" 2>/dev/null \
  || { cat "$TW" >&2; fail "watcher trigger failed"; }
TRIG_RUN_ID="$(jget run_id < "$TW" 2>/dev/null || echo)"
[ -n "$TRIG_RUN_ID" ] || { cat "$TW" >&2; fail "watcher trigger did not dispatch a run (no run_id)"; }
grep -qi "Failed to generate an embedded Lobu service token" "$RUN_LOG" \
  && fail "watcher dispatch failed on the service token (lobu-internal oauth_client missing)"
for _ in $(seq 1 30); do
  grep -qiE "OpenClaw worker for session: session-[^ ]*watcher_${WATCHER_ID}_run" "$RUN_LOG" && break
  sleep 1
done
grep -qiE "OpenClaw worker for session: session-[^ ]*watcher_${WATCHER_ID}_run" "$RUN_LOG" \
  || fail "watcher run ${TRIG_RUN_ID} did not dispatch to a worker"
echo "✓ watcher trigger dispatched a run to a worker (run_id=$TRIG_RUN_ID)"

# Deterministic reaction drive: read_knowledge over the window holding the
# connector events → window_token → complete_window with extracted_data. The
# window has linked content (the synced pulse event), so the reaction fires.
SINCE="$(node -e 'process.stdout.write("2000-01-01")')"
UNTIL="$(node -e 'const d=new Date(Date.now()+86400000);process.stdout.write(d.toISOString().slice(0,10))')"
RK="$RUN_DIR/read-knowledge.json"
api read_knowledge "{\"watcher_id\":$WATCHER_ID,\"since\":\"$SINCE\",\"until\":\"$UNTIL\"}" > "$RK" 2>/dev/null \
  || { cat "$RK" >&2; fail "read_knowledge (watcher-mode) failed"; }
WINDOW_TOKEN="$(jget window_token < "$RK")"
[ -n "$WINDOW_TOKEN" ] || { cat "$RK" >&2; fail "read_knowledge returned no window_token (no content in window — connector events missing?)"; }

CW="$RUN_DIR/complete-window.json"
api manage_watchers "$(node -e 'const t=process.argv[1],w=process.argv[2];process.stdout.write(JSON.stringify({action:"complete_window",watcher_id:w,window_token:t,extracted_data:{s:"SDKE2E_OK"},run_metadata:{executor:"sdk-e2e"}}))' "$WINDOW_TOKEN" "$WATCHER_ID")" > "$CW" 2>/dev/null \
  || { cat "$CW" >&2; fail "complete_window failed"; }
grep -q '"action":"complete_window"\|"action": "complete_window"' "$CW" || { cat "$CW" >&2; fail "complete_window did not return the expected action"; }

# Assert the reaction's side effect: a SDKE2E_REACTION_OK knowledge event exists.
# query_sql auto-scopes to the org and auto-adds ORDER BY/LIMIT, so we pass a
# bare SELECT (no ORDER BY/LIMIT) plus the required sort_by, and count rows
# script-side.
# query_sql validates against the data-source table allowlist where `events`
# maps to current_event_records (the superseded-masking view); use `events`.
REACT="$RUN_DIR/reaction-check.json"
REACT_QUERY="$(node -e 'process.stdout.write(JSON.stringify({sql:"SELECT id FROM events WHERE payload_text = '"'"'SDKE2E_REACTION_OK'"'"'",sort_by:"id"}))')"
REACT_OK=""
for _ in $(seq 1 30); do
  api query_sql "$REACT_QUERY" > "$REACT" 2>/dev/null || { sleep 1; continue; }
  N="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stdout.write("0");return}const rows=j.rows||j.result||j.data||(Array.isArray(j)?j:[]);process.stdout.write(String(Array.isArray(rows)?rows.length:0))})' < "$REACT")"
  if [ "${N:-0}" -ge 1 ] 2>/dev/null; then REACT_OK=1; break; fi
  sleep 1
done
[ -n "$REACT_OK" ] || { cat "$CW" >&2; cat "$REACT" >&2; fail "watcher reaction did not produce its SDKE2E_REACTION_OK knowledge event"; }
echo "✓ watcher reaction ran and saved its assertable side effect (SDKE2E_REACTION_OK)"

# 5) Idempotent re-apply (stable config → 0 deletes). Unlike `lobu run`, `lobu
# apply` does not auto-load the project .env, so pass the secret it resolves for
# the provider-key push explicitly.
REAPPLY="$RUN_DIR/reapply.out"
( cd "$PROJ" && MOCK_API_KEY=mock-key-e2e $LOBU apply --url "http://localhost:$GW_PORT" --yes > "$REAPPLY" 2>&1 ) || { cat "$REAPPLY" >&2; fail "re-apply exited non-zero"; }
# A fully-idempotent re-apply prints "Nothing to apply." (everything noop/drift);
# a partial one prints "Apply complete.". Either is fine — a delete row is not.
grep -qiE "Nothing to apply|Apply complete" "$REAPPLY" || { cat "$REAPPLY" >&2; fail "re-apply neither completed nor was a noop"; }
if grep -qE "Summary:.*[1-9][0-9]* delete" "$REAPPLY"; then fail "re-apply was not idempotent (deleted something on a stable config)"; fi
echo "✓ re-apply is idempotent (no deletes on a stable config)"

echo "✅ SDK lifecycle e2e PASSED"
