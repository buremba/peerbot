#!/usr/bin/env bash
#
# scripts/staging-route.sh decides where the one public staging host points,
# executed rather than read. Two of its decisions are load-bearing:
#
#   - The exact-host Ingress must survive a release. Delete it and
#     staging.lobu.ai falls through to production's *.lobu.ai Ingress, so an
#     apparently idle test URL silently becomes production.
#   - A release is owner-scoped. An `unlabeled` event for a PR that no longer
#     holds the lock arrives *after* the new holder acquired it (the workflow
#     serializes on one concurrency group), so an unscoped release would tear
#     down whoever just took the host.
#
# `kubectl`, `gh`, `curl` and `sleep` are stubbed on PATH. Stub invocations and
# the script's own output share one log, so an assertion can read both what the
# script issued and why it refused.
#
# A few assertions read .github/workflows/staging.yml directly: the script only
# ever reconciles the target it is handed, so which events reach it — and with
# which target — is a decision only the workflow makes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER="$SCRIPT_DIR/../../staging-route.sh"
STAGING_WORKFLOW="$SCRIPT_DIR/../../../.github/workflows/staging.yml"
PREVIEW_WORKFLOW="$SCRIPT_DIR/../../../.github/workflows/preview.yml"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "jq is required (staging-route.sh parses kubectl/curl JSON with it)"

STUBS="$(mktemp -d)"
LOG="$(mktemp)"
trap 'rm -rf "$STUBS" "$LOG"' EXIT

cat >"$STUBS/kubectl" <<'STUB'
#!/usr/bin/env bash
args="$*"
printf 'kubectl %s\n' "$args" >>"$KUBECTL_LOG"
case "$args" in
  *"apply -f -"*)
    # Manifests arrive on stdin; fold them into the same log so assertions can
    # read what was actually applied, not just that an apply happened.
    manifest="$(cat)"
    { echo '--- applied'; printf '%s\n' "$manifest"; } >>"$KUBECTL_LOG"
    if grep -Fq 'name: lobu-staging-tailnet' <<<"$manifest"; then
      [ "$FAKE_TAILSCALE_APPLY" = ok ] || exit 1
    fi
    ;;
  "create namespace"*)
    printf 'apiVersion: v1\nkind: Namespace\n'
    ;;
  *"get configmap"*)
    [ "$FAKE_CONFIGMAP" = present ] || exit 1
    ;;
  *"get ingress -A --field-selector metadata.name=lobu-staging"*)
    printf '%s' "$FAKE_STRAY_INGRESS_NS"
    exit "$FAKE_STRAY_INGRESS_STATUS"
    ;;
  *"get ingress lobu-staging -o json --ignore-not-found"*)
    [ "$FAKE_ENSURE_INGRESS_STATUS" = 0 ] || exit "$FAKE_ENSURE_INGRESS_STATUS"
    if [ "$FAKE_ENSURE_INGRESS_STATE" = present ]; then
      printf '{"metadata":{"annotations":{"lobu.ai/staging-owner":"%s","lobu.ai/staging-target":"%s"}}}\n' \
        "$FAKE_OWNER" "$FAKE_TARGET"
    fi
    ;;
  *"get ingress lobu-staging -o json"*)
    printf '{"metadata":{"annotations":{"lobu.ai/staging-owner":"%s","lobu.ai/staging-target":"%s"}}}\n' \
      "$FAKE_OWNER" "$FAKE_TARGET"
    exit "$FAKE_OWNER_LOOKUP_STATUS"
    ;;
  *"get secret"*)
    printf '{"apiVersion":"v1","kind":"Secret","type":"kubernetes.io/tls","data":{"tls.crt":"eA=="},"metadata":{"name":"wildcard-lobu-ai-tls","namespace":"summaries-prod"}}\n'
    ;;
  *"get service"*)
    [ "$FAKE_PREVIEW_SERVICE" = present ] || exit 1
    ;;
  *"wait --for=condition=TailscaleProxyReady"*)
    [ "$FAKE_TAILSCALE" = ready ] || exit 1
    ;;
  *"wait --for=jsonpath"*)
    [ "$FAKE_HEALTH_POD" = ok ] || exit 1
    ;;
  *"rollout status deployment/lobu-pr-"*)
    [ "$FAKE_PREVIEW_ROLLOUT" = ready ] || exit 1
    ;;
  *"rollout status deployment/lobu-staging-router"*)
    rollout_count="$(grep -Fc 'rollout status deployment/lobu-staging-router' "$KUBECTL_LOG")"
    if [ "$FAKE_ROUTER_ROLLOUT" = fail-second ] && [ "$rollout_count" = 2 ]; then
      exit 1
    fi
    ;;
  *" logs "*)
    printf '%s' "$FAKE_BACKEND_HEALTH"
    ;;
esac
exit 0
STUB

cat >"$STUBS/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$KUBECTL_LOG"
case "$1 $2" in
  "pr list") printf '%s' "$FAKE_OPEN_PRS"; exit "$FAKE_GH_LIST_STATUS" ;;
  "pr view") printf '%s' "$FAKE_PR_LABELS"; exit "$FAKE_GH_VIEW_STATUS" ;;
esac
exit 0
STUB

cat >"$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$KUBECTL_LOG"
url=''
outfile=''
want_code=0
fail_on_error=0
expect_outfile=0
for arg in "$@"; do
  if [ "$expect_outfile" = 1 ]; then
    outfile="$arg"
    expect_outfile=0
    continue
  fi
  case "$arg" in
    -o) expect_outfile=1 ;;
    '%{http_code}') want_code=1 ;;
    -f | -fsS) fail_on_error=1 ;;
    http://* | https://*) url="$arg" ;;
  esac
done

status=200
body=''
case "$url" in
  *'/.well-known/oauth-authorization-server'*)
    body="$FAKE_OAUTH_METADATA"
    ;;
  *'/api/local-init'*)
    status="$FAKE_LOCAL_INIT_STATUS"
    body='{"error":"proxied_request_refused"}'
    ;;
  *'/api/health'*)
    status="$FAKE_PUBLIC_STATUS"
    body="$FAKE_PUBLIC_HEALTH"
    ;;
esac

if [ -n "$outfile" ]; then
  printf '%s' "$body" >"$outfile"
else
  printf '%s' "$body"
fi
[ "$want_code" = 1 ] && printf '%s' "$status"
if [ "$fail_on_error" = 1 ] && [ "$status" -ge 400 ]; then
  exit 22
fi
exit 0
STUB

# The script's retry loops sleep between attempts; the decisions under test do
# not depend on wall-clock time.
cat >"$STUBS/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

chmod +x "$STUBS/kubectl" "$STUBS/gh" "$STUBS/curl" "$STUBS/sleep"

HEALTHY='{"status":"healthy","service":"lobu-api","environment":"development"}'
PRODUCTION='{"status":"healthy","service":"lobu-api","environment":"production"}'
OFFLINE_BODY='{"status":"offline","service":"lobu-staging-router","environment":"staging"}'
OAUTH_METADATA='{"issuer":"https://staging.lobu.ai"}'

# Run the real script with a fully specified fake cluster. Callers override a
# single fact by exporting the matching FAKE_* before calling.
run_route() {
  : >"$LOG"
  # The public probe reads whatever the router now serves, so the fake host
  # answers as the sink for a release and as a backend for a route.
  local default_public_health="$HEALTHY" default_public_status=200
  if [ "${1:-}" = offline ]; then
    default_public_health="$OFFLINE_BODY"
    default_public_status=503
  fi
  set +e
  env \
    PATH="$STUBS:$PATH" \
    KUBECTL_LOG="$LOG" \
    GH_TOKEN=fake-token \
    FAKE_CONFIGMAP="${FAKE_CONFIGMAP:-present}" \
    FAKE_OWNER="${FAKE_OWNER:-none}" \
    FAKE_OWNER_LOOKUP_STATUS="${FAKE_OWNER_LOOKUP_STATUS:-0}" \
    FAKE_ENSURE_INGRESS_STATUS="${FAKE_ENSURE_INGRESS_STATUS:-0}" \
    FAKE_ENSURE_INGRESS_STATE="${FAKE_ENSURE_INGRESS_STATE:-present}" \
    FAKE_TARGET="${FAKE_TARGET:-offline}" \
    FAKE_STRAY_INGRESS_NS="${FAKE_STRAY_INGRESS_NS:-}" \
    FAKE_STRAY_INGRESS_STATUS="${FAKE_STRAY_INGRESS_STATUS:-0}" \
    FAKE_PREVIEW_SERVICE="${FAKE_PREVIEW_SERVICE:-present}" \
    FAKE_TAILSCALE_APPLY="${FAKE_TAILSCALE_APPLY:-ok}" \
    FAKE_TAILSCALE="${FAKE_TAILSCALE:-ready}" \
    FAKE_ROUTER_ROLLOUT="${FAKE_ROUTER_ROLLOUT:-ready}" \
    FAKE_PREVIEW_ROLLOUT="${FAKE_PREVIEW_ROLLOUT:-ready}" \
    FAKE_HEALTH_POD="${FAKE_HEALTH_POD:-ok}" \
    FAKE_BACKEND_HEALTH="${FAKE_BACKEND_HEALTH:-$HEALTHY}" \
    FAKE_PUBLIC_HEALTH="${FAKE_PUBLIC_HEALTH:-$default_public_health}" \
    FAKE_PUBLIC_STATUS="${FAKE_PUBLIC_STATUS:-$default_public_status}" \
    FAKE_OAUTH_METADATA="${FAKE_OAUTH_METADATA:-$OAUTH_METADATA}" \
    FAKE_LOCAL_INIT_STATUS="${FAKE_LOCAL_INIT_STATUS:-403}" \
    FAKE_OPEN_PRS="${FAKE_OPEN_PRS:-}" \
    FAKE_PR_LABELS="${FAKE_PR_LABELS-staging}" \
    FAKE_GH_LIST_STATUS="${FAKE_GH_LIST_STATUS:-0}" \
    FAKE_GH_VIEW_STATUS="${FAKE_GH_VIEW_STATUS:-0}" \
    STAGING_LOCAL_TAILNET_FQDN="${STAGING_LOCAL_TAILNET_FQDN:-}" \
    STAGING_LOCAL_TAILNET_PORT="${STAGING_LOCAL_TAILNET_PORT:-10080}" \
    TAILNET_DOMAIN="${TAILNET_DOMAIN:-}" \
    bash "$ROUTER" "$@" >>"$LOG" 2>&1
  local code=$?
  set -e
  return $code
}

assert_ok() {
  run_route "${@:2}" || fail "$1: script exited nonzero"
}

assert_fails() {
  run_route "${@:2}" && fail "$1: script exited 0 where it must refuse"
  return 0
}

assert_logged() {
  grep -Fq -- "$2" "$LOG" || {
    sed 's/^/  | /' "$LOG" >&2
    fail "$1: expected to see '$2'"
  }
}

assert_not_logged() {
  grep -Fq -- "$2" "$LOG" && fail "$1: must not have issued '$2'"
  return 0
}

# route_preview pins the public-host settings and restore_private_preview hands
# them back with the same `set env` verb on the same deployment — only the
# argument list separates them, so assertions name the restore by its arguments.
restored_private() {
  printf 'set env deployment/lobu-pr-%s PUBLIC_GATEWAY_URL- LOBU_LOCAL_INIT_ALLOW_PROXY=1' "$1"
}

# The log is append-ordered, so "before" is a line-number comparison. Both
# needles must appear, or the ordering claim is vacuous.
assert_logged_before() {
  local first second
  first="$(grep -nF -- "$2" "$LOG" | head -1 | cut -d: -f1)"
  second="$(grep -nF -- "$3" "$LOG" | head -1 | cut -d: -f1)"
  [ -n "$first" ] || fail "$1: expected to see '$2'"
  [ -n "$second" ] || fail "$1: expected to see '$3'"
  [ "$first" -lt "$second" ] || fail "$1: '$2' must be issued before '$3'"
}

# `service:` appears only in the Ingress backend, so the line after it is the
# Service the public host actually resolves to.
assert_ingress_backend() {
  grep -A1 -F 'service:' "$LOG" | grep -Fq "name: $2" ||
    fail "$1: staging Ingress does not point at $2"
}

assert_workflow_contains() {
  grep -Fq -- "$2" "$STAGING_WORKFLOW" ||
    fail "$1: staging workflow must contain '$2'"
}

assert_preview_workflow_contains() {
  grep -Fq -- "$2" "$PREVIEW_WORKFLOW" ||
    fail "$1: preview workflow must contain '$2'"
}

# --- the workflow reaches the script on the right events -------------------

# Closing a PR fires no `unlabeled` event, so without the `closed` type a merged
# holder would keep the public host pointed at the namespace preview.yml deletes
# on that same event.
assert_workflow_contains "closed PR release" 'types: [labeled, unlabeled, closed]'
assert_workflow_contains "closed PR reconcile" "github.event.action == 'closed'"
# ...but only for the holder. The concurrency group is global and GitHub keeps
# one pending run per group, so a run queued by an unrelated PR closing would
# cancel a release already waiting behind the run in flight.
assert_workflow_contains "closed PR label gate" \
  "github.event.action == 'closed' && contains(github.event.pull_request.labels.*.name, 'staging')"
# Preview ownership is label-driven, including the closed-event release above.
# Manual dispatch therefore exposes only the two non-label targets.
assert_workflow_contains "manual targets" 'options: [local-tailnet, offline]'
# The wildcard secret is copied, not watched, so nothing re-copies a renewed
# certificate while staging sits idle for a full renewal cycle.
assert_workflow_contains "scheduled TLS refresh" '- cron:'
assert_workflow_contains "scheduled TLS target" "github.event_name == 'schedule' && 'refresh-tls'"

# Preview redeploys recreate the ClusterIP Service. nginx resolves the static
# Service hostname when its config loads, so a successful staging-labelled
# preview deploy must reconcile the router again under the same global lock.
assert_preview_workflow_contains "post-deploy staging reconcile" 'reconcile-staging:'
assert_preview_workflow_contains "post-deploy dependency" 'needs: preview'
assert_preview_workflow_contains "post-deploy staging lock" 'group: staging-lock'
assert_preview_workflow_contains "post-deploy PR number" \
  "PR_NUMBER: \${{ github.event.pull_request.number }}"
assert_preview_workflow_contains "post-deploy route command" \
  "bash scripts/staging-route.sh preview \"\$PR_NUMBER\""
assert_preview_workflow_contains "post-deploy current-label reconciliation" \
  'contains(github.event.pull_request.labels.*.name, '\''staging'\'')'

# --- the exact-host Ingress is permanent -----------------------------------

# A fresh cluster has no router config yet, and the Deployment mounts that
# ConfigMap by name — so the first reconcile has to create it, pointed at the
# sink. An existing one is left alone: rewriting it here would drop whatever
# target the current owner is published on.
FAKE_CONFIGMAP=absent assert_ok "first router config" refresh-tls
assert_logged "first router config" 'kind: ConfigMap'
assert_logged "first router config" '"status":"offline"'
assert_ok "existing router config" refresh-tls
assert_not_logged "existing router config" 'kind: ConfigMap'

# A genuinely absent first-run Ingress bootstraps offline. An API read failure
# is different: it must abort before overwriting a possibly live owner with the
# bootstrap defaults.
FAKE_ENSURE_INGRESS_STATE=missing assert_ok "first reconcile" refresh-tls
assert_logged "first reconcile" 'lobu.ai/staging-owner: "none"'
assert_logged "first reconcile" 'lobu.ai/staging-target: "offline"'

FAKE_ENSURE_INGRESS_STATUS=1 assert_fails "ensure ingress outage" refresh-tls
assert_not_logged "ensure ingress outage" 'kind: Ingress'

assert_ok "offline" offline
# Released staging still owns staging.lobu.ai explicitly, backed by the router.
assert_logged "offline" 'kind: Ingress'
assert_logged "offline" '- host: staging.lobu.ai'
assert_ingress_backend "offline" 'lobu-staging-router'
assert_logged "offline" 'staging-owner=none'
assert_logged "offline" 'staging-target=offline'
# Deleting it is exactly the fall-through-to-production bug.
assert_not_logged "offline" 'delete ingress lobu-staging'

# A pre-router Ingress parked in a preview namespace is the one that must go —
# and only after the permanent route exists.
FAKE_STRAY_INGRESS_NS=$'lobu-preview-9\n' assert_ok "stray cleanup" offline
assert_logged "stray cleanup" '-n lobu-preview-9 delete ingress lobu-staging'

# A list outage is not equivalent to an empty list: continuing would allow a
# pre-router Ingress to keep competing for the public hostname.
FAKE_STRAY_INGRESS_STATUS=1 assert_fails "stray ingress list outage" refresh-tls
assert_logged "stray ingress list outage" 'could not list staging Ingress claims'

# --- releasing is owner-scoped ---------------------------------------------

# PR 7 drops its label after PR 8 took the host: PR 8 keeps it.
FAKE_OWNER=pr-8 FAKE_TARGET=preview assert_ok "stale release" offline 7
assert_not_logged "stale release" 'staging-owner=none'
# The stale PR's own preview is still handed back its private-host settings.
assert_logged "stale release" "$(restored_private 7)"

# The holder releasing its own lock does take the host offline.
FAKE_OWNER=pr-7 FAKE_TARGET=preview assert_ok "owner release" offline 7
assert_logged "owner release" 'staging-owner=none'
assert_logged "owner release" "$(restored_private 7)"
assert_logged_before "owner release" 'staging-owner=none' "$(restored_private 7)"

# A manual force-off has no PR event payload. It still restores the displaced
# preview and clears the label whose later event would otherwise surprise the
# next operator.
FAKE_OWNER=pr-7 FAKE_TARGET=preview FAKE_OPEN_PRS=$'7\n' FAKE_PR_LABELS='staging' \
  assert_ok "manual force-off" offline
assert_logged "manual force-off" "$(restored_private 7)"
assert_logged_before "manual force-off" 'staging-owner=none' "$(restored_private 7)"
assert_logged "manual force-off" 'pr edit 7 --remove-label staging'

# GitHub label cleanup cannot block the emergency action itself. The workflow
# may fail so the cleanup can be retried, but the host is already offline and
# the displaced preview has its private settings back.
FAKE_OWNER=pr-7 FAKE_TARGET=preview FAKE_GH_LIST_STATUS=1 \
  assert_fails "manual force-off gh outage" offline
assert_logged "manual force-off gh outage" 'staging-owner=none'
assert_logged "manual force-off gh outage" 'staging-target=offline'
assert_logged "manual force-off gh outage" \
  "$(restored_private 7)"

# --- the health gate -------------------------------------------------------

# A backend that reports itself as production must never be published, however
# it got selected.
FAKE_BACKEND_HEALTH="$PRODUCTION" assert_fails "prod backend" preview 12
assert_logged "prod backend" 'refusing to route staging to production'
# Refused before the router or the Ingress ever named it.
assert_not_logged "prod backend" 'proxy_pass http://lobu-pr-12'
assert_not_logged "prod backend" 'staging-owner=pr-12'

# Same gate on the public side: the host itself answering as production.
FAKE_PUBLIC_HEALTH="$PRODUCTION" assert_fails "prod public" preview 12
assert_logged "prod public" 'refusing to route staging to production'

# An unreachable or unhealthy backend is not a route either.
FAKE_HEALTH_POD=failed FAKE_OPEN_PRS=$'11\n12\n' FAKE_PR_LABELS='staging' \
  assert_fails "unhealthy backend" preview 12
assert_logged "unhealthy backend" 'backend health probe could not complete'
# The current holder keeps its label until the replacement is proved healthy.
assert_not_logged "unhealthy backend" 'pr edit 11 --remove-label staging'
FAKE_PREVIEW_SERVICE=missing assert_fails "missing preview service" preview 12
assert_logged "missing preview service" 'preview service lobu-preview-12/lobu-pr-12 was not found'

# Public-host settings are provisional until the preview deployment is healthy.
# A failed rollout for a preview that does not own the route hands the private
# settings back before exiting.
FAKE_PREVIEW_ROLLOUT=failed assert_fails "preview deployment rollout" preview 12
assert_logged "preview deployment rollout" "$(restored_private 12)"
assert_not_logged "preview deployment rollout" 'proxy_pass http://lobu-pr-12'

# If this preview already owns the public route, restoring passwordless proxy
# bootstrap while the router still points at it would expose /api/local-init.
# Take the exact host offline first, then restore its private-host settings.
FAKE_OWNER=pr-12 FAKE_TARGET=preview FAKE_PREVIEW_ROLLOUT=failed \
  assert_fails "current owner preview rollout" preview 12
assert_logged "current owner preview rollout" 'staging target publication failed; rolling staging back to offline'
assert_logged "current owner preview rollout" 'staging-owner=none'
assert_logged_before "current owner preview rollout" \
  'staging-owner=none' "$(restored_private 12)"

# --- preview ---------------------------------------------------------------

# A post-deploy reconcile can replace the one pending label-event job. It reads
# current desired state, so an event captured before an unlabel performs the
# canceled scoped release instead of re-acquiring from stale payload data.
FAKE_OWNER=pr-12 FAKE_TARGET=preview FAKE_PR_LABELS='' \
  FAKE_PUBLIC_STATUS=503 FAKE_PUBLIC_HEALTH="$OFFLINE_BODY" \
  assert_ok "stale post-deploy reconcile releases" preview 12
assert_logged "stale post-deploy reconcile releases" 'PR #12 no longer has the staging label'
assert_logged "stale post-deploy reconcile releases" 'staging-owner=none'
assert_logged "stale post-deploy reconcile releases" "$(restored_private 12)"
assert_not_logged "stale post-deploy reconcile releases" 'proxy_pass http://lobu-pr-12'

# If another PR already owns the host, the same stale reconcile is a scoped
# release and must leave that owner unchanged.
FAKE_OWNER=pr-11 FAKE_TARGET=preview FAKE_PR_LABELS='' \
  assert_ok "displaced stale reconcile" preview 12
assert_logged "displaced stale reconcile" 'lock owner is pr-11; leaving it unchanged'
assert_not_logged "displaced stale reconcile" 'staging-owner=none'

# Conversely, if a post-deploy job replaces a pending acquisition while the
# label is still present, it performs the acquisition itself.
FAKE_OWNER=pr-11 FAKE_TARGET=preview FAKE_PR_LABELS=staging \
  assert_ok "post-deploy replaces pending acquire" preview 12
assert_logged "post-deploy replaces pending acquire" 'staging-owner=pr-12'
assert_logged "post-deploy replaces pending acquire" 'proxy_pass http://lobu-pr-12.lobu-preview-12.svc.cluster.local:80'

FAKE_OPEN_PRS=$'11\n12\n' FAKE_PR_LABELS='staging' assert_ok "preview" preview 12
assert_logged "preview" 'proxy_pass http://lobu-pr-12.lobu-preview-12.svc.cluster.local:80'
assert_logged "preview" 'staging-owner=pr-12'
# Public host, so the passwordless bootstrap env must be stripped before the
# rollout, and PUBLIC_GATEWAY_URL pinned to the public name.
assert_logged "preview" 'LOBU_LOCAL_INIT_ALLOW_PROXY-'
assert_logged "preview" 'PUBLIC_GATEWAY_URL=https://staging.lobu.ai/lobu'
# Single holder: every other labelled PR loses the label, this one keeps it.
assert_logged "preview" 'pr edit 11 --remove-label staging'
assert_not_logged "preview" 'pr edit 12 --remove-label staging'

# The PR losing the host still has PUBLIC_GATEWAY_URL pinned and passwordless
# bootstrap off, and the label strip above runs on GITHUB_TOKEN — which fires no
# `unlabeled` run to hand them back. So this run has to do it.
FAKE_OWNER=pr-11 FAKE_TARGET=preview FAKE_OPEN_PRS=$'11\n12\n' FAKE_PR_LABELS='staging' \
  assert_ok "preview displaces holder" preview 12
assert_logged "preview displaces holder" "$(restored_private 11)"
# ...but only once the route has moved. Those settings put
# LOBU_LOCAL_INIT_ALLOW_PROXY=1 back on PR 11, and until the router points at
# PR 12 the public host still resolves to PR 11 — handing them back first
# reopens passwordless bootstrap on staging.lobu.ai for the length of the
# rollout.
assert_logged_before "preview displaces holder" \
  'proxy_pass http://lobu-pr-12' "$(restored_private 11)"

# Re-acquiring for the PR that already holds the route displaces nobody: handing
# back the private-host settings would undo the ones this run just applied.
FAKE_OWNER=pr-12 FAKE_TARGET=preview FAKE_OPEN_PRS=$'12\n' FAKE_PR_LABELS='staging' \
  assert_ok "preview re-acquire" preview 12
assert_not_logged "preview re-acquire" "$(restored_private 12)"

# A public host that still mints passwordless sessions is the failure this
# check exists to catch.
FAKE_LOCAL_INIT_STATUS=200 assert_fails "open bootstrap" preview 12
assert_logged "open bootstrap" 'public /api/local-init returned 200'
assert_logged "open bootstrap" 'staging target publication failed; rolling staging back to offline'
assert_logged "open bootstrap" 'staging-owner=none'
assert_logged "open bootstrap" 'staging-target=offline'
assert_logged "open bootstrap" "$(restored_private 12)"
# ...and that 403-vs-200 reading is only worth anything because the probe sends
# the header a real client sends. The CSRF check is the LAST of
# assertLoopbackClient's layers, so a probe without it is refused as
# missing_client_header even with the forwarded-* boundary wide open - a 403
# indistinguishable from the closed-boundary one.
assert_logged "open bootstrap" '-H X-Lobu-Client: staging-probe'

# The router is what makes the issuer right: OAuth discovery skips
# PUBLIC_GATEWAY_URL (skipEnvOverride, auth/oauth/routes.ts) and derives the
# issuer from the X-Forwarded-* pair nginx sets. A router that drops them
# publishes a host whose discovery document points somewhere else, which every
# cloud MCP host reads before it ever calls /mcp.
FAKE_OAUTH_METADATA='{"issuer":"https://lobu-pr-12.tail1234.ts.net"}' \
  assert_fails "wrong OAuth issuer" preview 12
assert_logged "wrong OAuth issuer" 'OAuth issuer does not match https://staging.lobu.ai'
assert_logged "wrong OAuth issuer" 'staging-target=offline'
assert_logged "wrong OAuth issuer" "$(restored_private 12)"

# Changing the ConfigMap is provisional too: if the router rollout times out,
# it may still converge later. The public host therefore has to be rolled back
# before that unverified target can become reachable.
FAKE_ROUTER_ROLLOUT=fail-second assert_fails "preview router rollout" preview 12
assert_logged "preview router rollout" 'staging target publication failed; rolling staging back to offline'
assert_logged "preview router rollout" 'staging-owner=none'
assert_logged "preview router rollout" 'staging-target=offline'
assert_logged "preview router rollout" "$(restored_private 12)"

# Single-holder rests on gh answering. A rate limit or 5xx read through a pipe
# would take grep's status and pass for "that PR is not labelled", leaving two
# PRs labelled `staging` while one holds the route — so it has to abort instead,
# and abort before the host is pointed anywhere. By then this PR's preview is
# already carrying the public-host settings, so the run also has to hand them
# back on its way out.
FAKE_OPEN_PRS=$'11\n' FAKE_GH_VIEW_STATUS=1 assert_fails "gh outage reading labels" preview 12
assert_not_logged "gh outage reading labels" 'staging-owner=pr-12'
assert_not_logged "gh outage reading labels" 'PUBLIC_GATEWAY_URL=https://staging.lobu.ai/lobu'
FAKE_GH_LIST_STATUS=1 assert_fails "gh outage listing PRs" preview 12
assert_not_logged "gh outage listing PRs" 'staging-owner=pr-12'
assert_logged "gh outage listing PRs" "$(restored_private 12)"

# A lock-transfer failure after a successful public-safe rollout must not hand
# passwordless proxy bootstrap back to the preview that still owns the host.
FAKE_OWNER=pr-12 FAKE_TARGET=preview FAKE_GH_LIST_STATUS=1 \
  assert_fails "current owner lock transfer outage" preview 12
assert_logged "current owner lock transfer outage" 'current owner retains public-safe settings'
assert_not_logged "current owner lock transfer outage" "$(restored_private 12)"
assert_logged "current owner lock transfer outage" 'LOBU_LOCAL_INIT_ALLOW_PROXY-'

# Reading who currently holds the route is the same kind of dependency: an
# unreadable annotation must not pass for "nobody holds it", or the displaced
# holder would keep the public-host settings this run never released it from.
FAKE_OWNER_LOOKUP_STATUS=1 assert_fails "owner lookup outage" preview 12
assert_not_logged "owner lookup outage" 'staging-owner=pr-12'
assert_not_logged "owner lookup outage" 'PUBLIC_GATEWAY_URL=https://staging.lobu.ai/lobu'

assert_fails "non-numeric PR" preview not-a-number
assert_logged "non-numeric PR" 'preview target requires a numeric PR number'
assert_fails "preview without a PR" preview
assert_logged "preview without a PR" 'preview target requires a numeric PR number'

# Same class on the release path, where reading it wrong is worst: an owner
# that cannot be read must not pass for "this PR is not the holder", or the
# run would report a successful no-op with the host still published.
FAKE_OWNER=pr-7 FAKE_TARGET=preview FAKE_OWNER_LOOKUP_STATUS=1 \
  assert_fails "release owner lookup outage" offline 7
assert_not_logged "release owner lookup outage" 'leaving it unchanged'
assert_not_logged "release owner lookup outage" 'staging-owner=none'

# The dispatch input is free text. A typed owner scope that is not a PR number
# matches no annotation, so an unvalidated release would report success while
# leaving the public host published.
FAKE_OWNER=pr-7 FAKE_TARGET=preview assert_fails "non-numeric owner scope" offline 'pr-7'
assert_logged "non-numeric owner scope" 'offline owner scope must be a numeric PR number'
assert_not_logged "non-numeric owner scope" 'staging-owner=none'

# A certificate refresh is route-neutral: ensure_system_route copies the
# wildcard secret and preserves the current owner/target annotations.
FAKE_OWNER=pr-7 FAKE_TARGET=preview assert_ok "TLS refresh" refresh-tls
assert_logged "TLS refresh" '"kind": "Secret"'
assert_logged "TLS refresh" 'lobu.ai/staging-owner: "pr-7"'
assert_logged "TLS refresh" 'lobu.ai/staging-target: "preview"'
assert_not_logged "TLS refresh" 'delete service lobu-staging-tailnet'
assert_logged "TLS refresh" 'route unchanged'

# --- local tailnet ---------------------------------------------------------

# The target is a repository variable, but it is still checked against the
# configured tailnet so a mistyped value cannot turn the cluster into an
# arbitrary outbound proxy.
STAGING_LOCAL_TAILNET_FQDN='box.evil.example' TAILNET_DOMAIN='tail1234.ts.net' \
  assert_fails "off-tailnet target" local-tailnet
assert_logged "off-tailnet target" 'outside the configured tailnet domain'
assert_not_logged "off-tailnet target" 'tailscale.com/tailnet-fqdn'

STAGING_LOCAL_TAILNET_FQDN='' assert_fails "unset tailnet target" local-tailnet
assert_logged "unset tailnet target" 'STAGING_LOCAL_TAILNET_FQDN repository variable is required'
STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' TAILNET_DOMAIN='' \
  assert_fails "unset tailnet domain" local-tailnet
assert_logged "unset tailnet domain" 'TAILNET_DOMAIN repository variable is required'
assert_not_logged "unset tailnet domain" 'tailscale.com/tailnet-fqdn'
STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' STAGING_LOCAL_TAILNET_PORT='80' \
  TAILNET_DOMAIN='tail1234.ts.net' \
  assert_fails "privileged port" local-tailnet
assert_logged "privileged port" 'STAGING_LOCAL_TAILNET_PORT must be between 1024 and 65535'

STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' TAILNET_DOMAIN='tail1234.ts.net' \
  assert_ok "local tailnet" local-tailnet
assert_logged "local tailnet" 'tailscale.com/tailnet-fqdn: "box.tail1234.ts.net"'
assert_logged "local tailnet" 'type: ExternalName'
assert_logged "local tailnet" 'wait --for=condition=TailscaleProxyReady'
assert_logged "local tailnet" 'proxy_pass http://lobu-staging-tailnet.lobu-staging.svc.cluster.local:10080'
assert_logged "local tailnet" 'staging-owner=local-tailnet'

# Taking the host to a local machine displaces a PR holder the same way.
FAKE_OWNER=pr-11 FAKE_TARGET=preview STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_ok "local tailnet displaces holder" local-tailnet
assert_logged "local tailnet displaces holder" "$(restored_private 11)"
assert_logged_before "local tailnet displaces holder" \
  'proxy_pass http://lobu-staging-tailnet' "$(restored_private 11)"

# A lock-transfer metadata outage happens after the egress Service proved
# healthy but before publication. It must still remove that unused egress.
FAKE_GH_LIST_STATUS=1 STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_fails "local gh outage" local-tailnet
assert_not_logged "local gh outage" 'staging-owner=local-tailnet'
assert_logged "local gh outage" 'delete service lobu-staging-tailnet'

FAKE_OWNER_LOOKUP_STATUS=1 STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_fails "local owner outage" local-tailnet
assert_not_logged "local owner outage" 'staging-owner=local-tailnet'
assert_logged "local owner outage" 'delete service lobu-staging-tailnet'

# A machine that does not become healthy is never allowed to steal the lock,
# and its cluster egress Service is cleaned up on the error path.
FAKE_HEALTH_POD=failed FAKE_OPEN_PRS=$'12\n' FAKE_PR_LABELS='staging' \
  STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' TAILNET_DOMAIN='tail1234.ts.net' \
  assert_fails "unhealthy local tailnet" local-tailnet
assert_not_logged "unhealthy local tailnet" 'pr edit 12 --remove-label staging'
assert_logged "unhealthy local tailnet" 'delete service lobu-staging-tailnet'

# The apply and readiness checks are both gates. Because the subshell is the
# condition of `if !`, Bash disables errexit inside it; each command therefore
# has to short-circuit explicitly instead of falling through to a health probe.
FAKE_TAILSCALE_APPLY=failed STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_fails "tailnet apply failure" local-tailnet
assert_not_logged "tailnet apply failure" 'wait --for=condition=TailscaleProxyReady'
assert_not_logged "tailnet apply failure" 'run staging-health-'
assert_logged "tailnet apply failure" 'delete service lobu-staging-tailnet'

FAKE_TAILSCALE=failed STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_fails "tailnet readiness failure" local-tailnet
assert_logged "tailnet readiness failure" 'wait --for=condition=TailscaleProxyReady'
assert_not_logged "tailnet readiness failure" 'run staging-health-'
assert_logged "tailnet readiness failure" 'delete service lobu-staging-tailnet'

# The target is only provisional until its public path proves the bootstrap
# guard. If that post-publish check fails, the exact host must be put back on
# the 503 sink and the personal-machine egress removed before the run exits.
FAKE_LOCAL_INIT_STATUS=200 STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_fails "open local bootstrap" local-tailnet
assert_logged "open local bootstrap" 'public /api/local-init returned 200'
assert_logged "open local bootstrap" 'staging target publication failed; rolling staging back to offline'
assert_logged "open local bootstrap" 'staging-owner=none'
assert_logged "open local bootstrap" 'staging-target=offline'
assert_logged "open local bootstrap" 'delete service lobu-staging-tailnet'

FAKE_ROUTER_ROLLOUT=fail-second STAGING_LOCAL_TAILNET_FQDN='box.tail1234.ts.net' \
  TAILNET_DOMAIN='tail1234.ts.net' assert_fails "local router rollout" local-tailnet
assert_logged "local router rollout" 'staging target publication failed; rolling staging back to offline'
assert_logged "local router rollout" 'staging-owner=none'
assert_logged "local router rollout" 'staging-target=offline'
assert_logged "local router rollout" 'delete service lobu-staging-tailnet'

# Egress to a personal machine must not outlive the route that needed it.
assert_ok "offline cleanup" offline
assert_logged "offline cleanup" 'delete service lobu-staging-tailnet'

# A release that leaves the host still serving a backend is not a release.
FAKE_PUBLIC_STATUS=200 FAKE_PUBLIC_HEALTH="$HEALTHY" assert_fails "release not applied" offline
assert_logged "release not applied" 'offline staging returned HTTP 200 instead of 503'

# The status code alone cannot tell the sink apart from anyone else answering
# for the host - production's *.lobu.ai Ingress serves a 503 of its own. Only
# the body identifies the exact-host route, so releasing has to read it.
FAKE_PUBLIC_STATUS=503 FAKE_PUBLIC_HEALTH='<html>503 Service Unavailable</html>' \
  assert_fails "release answered by someone else" offline
assert_logged "release answered by someone else" 'offline staging returned an unexpected body'

# --- input validation ------------------------------------------------------

assert_fails "unknown target" someone-elses-cluster
assert_logged "unknown target" 'target must be preview, local-tailnet, offline, or refresh-tls'
assert_fails "no target"
assert_logged "no target" 'target must be preview, local-tailnet, offline, or refresh-tls'

echo "ok - staging routing keeps an exact-host route, scopes releases to the lock owner, and health-gates every target"
