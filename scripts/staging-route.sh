#!/usr/bin/env bash
#
# Reconcile the single public staging host to one of four targets:
#   preview        a PR preview Service
#   local-tailnet  an allowlisted tailnet device reached through the operator
#   offline        a stable 503 sink
#   refresh-tls    reconcile the shared objects (the wildcard TLS secret among
#                  them) and leave the current route exactly as it is
#
# The Ingress itself is permanent and always points at a small router in the
# lobu-staging namespace. That exact-host route prevents staging.lobu.ai from
# ever falling through to production's *.lobu.ai Ingress.

set -euo pipefail

TARGET="${1:-}"
PR_NUM="${2:-}"

# Public DNS, not the tailnet name: an MCP host (claude.ai, ChatGPT) resolves
# and calls /mcp from its own backend, so a tailnet-only name is unreachable to
# it and the connector fails at discovery.
STAGING_HOST="${STAGING_HOST:-staging.lobu.ai}"
STAGING_SYSTEM_NS="${STAGING_SYSTEM_NS:-lobu-staging}"
STAGING_INGRESS="${STAGING_INGRESS:-lobu-staging}"
STAGING_ROUTER="${STAGING_ROUTER:-lobu-staging-router}"
LOCAL_EGRESS_SERVICE="${LOCAL_EGRESS_SERVICE:-lobu-staging-tailnet}"
WILDCARD_TLS_NS="${WILDCARD_TLS_NS:-summaries-prod}"
WILDCARD_TLS_SECRET="${WILDCARD_TLS_SECRET:-wildcard-lobu-ai-tls}"
RUN_KEY="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

fail() {
  echo "staging-route: $*" >&2
  exit 1
}

assert_non_prod_health() {
  local body="$1"
  if jq -e '.environment == "production"' >/dev/null 2>&1 <<<"$body"; then
    fail "refusing to route staging to production"
  fi
  jq -e '.status == "healthy" and .environment != "production"' >/dev/null 2>&1 <<<"$body" ||
    fail "backend health was not a healthy non-production response: $body"
}

verify_non_prod_health() {
  local url="$1"
  local attempt body pod_name
  for attempt in $(seq 1 5); do
    pod_name="staging-health-${RUN_KEY//[^a-zA-Z0-9-]/-}-$attempt"
    # A Pod name is a DNS-1123 label, so it has to stay under 63 characters.
    pod_name="${pod_name:0:62}"
    kubectl -n "$STAGING_SYSTEM_NS" delete pod "$pod_name" --ignore-not-found >/dev/null 2>&1 || true
    kubectl -n "$STAGING_SYSTEM_NS" run "$pod_name" \
      --image="curlimages/curl:8.17.0" \
      --restart=Never \
      --command -- curl -fsS --max-time 20 "$url" >/dev/null
    if kubectl -n "$STAGING_SYSTEM_NS" wait \
      --for=jsonpath='{.status.phase}'=Succeeded \
      "pod/$pod_name" --timeout=30s >/dev/null 2>&1; then
      body="$(kubectl -n "$STAGING_SYSTEM_NS" logs "$pod_name")"
      kubectl -n "$STAGING_SYSTEM_NS" delete pod "$pod_name" --wait=false >/dev/null
      assert_non_prod_health "$body"
      return 0
    fi
    kubectl -n "$STAGING_SYSTEM_NS" logs "$pod_name" >&2 || true
    kubectl -n "$STAGING_SYSTEM_NS" delete pod "$pod_name" --ignore-not-found >/dev/null 2>&1 || true
    echo "backend health probe failed; retrying ($attempt/5)" >&2
    sleep 2
  done
  fail "backend health probe could not complete after 5 attempts"
}

write_router_config() {
  local target="$1"
  local upstream="${2:-}"

  if [ "$target" = "offline" ]; then
    kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: $STAGING_ROUTER
  namespace: $STAGING_SYSTEM_NS
data:
  default.conf: |
    server {
      listen 8080;
      server_name _;
      location = /__staging_router_ready { return 204; }
      location = /api/health {
        default_type application/json;
        return 503 '{"status":"offline","service":"lobu-staging-router","environment":"staging"}';
      }
      location / { return 503; }
    }
EOF
  else
    kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: $STAGING_ROUTER
  namespace: $STAGING_SYSTEM_NS
data:
  default.conf: |
    server {
      listen 8080;
      server_name _;
      client_max_body_size 50m;
      location = /__staging_router_ready { return 204; }
      location / {
        proxy_pass http://$upstream;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
      }
    }
EOF
  fi
}

roll_router() {
  kubectl -n "$STAGING_SYSTEM_NS" patch deployment "$STAGING_ROUTER" --type merge \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"lobu.ai/config-revision\":\"$RUN_KEY-$RANDOM\"}}}}}" >/dev/null &&
    kubectl -n "$STAGING_SYSTEM_NS" rollout status "deployment/$STAGING_ROUTER" --timeout=180s
}

current_owner() {
  kubectl -n "$STAGING_SYSTEM_NS" get ingress "$STAGING_INGRESS" -o json 2>/dev/null |
    jq -r '.metadata.annotations["lobu.ai/staging-owner"] // ""'
}

set_ingress_state() {
  local owner="$1"
  local target="$2"
  kubectl -n "$STAGING_SYSTEM_NS" annotate ingress "$STAGING_INGRESS" \
    "lobu.ai/staging-owner=$owner" \
    "lobu.ai/staging-target=$target" \
    --overwrite >/dev/null
}

cleanup_local_egress() {
  kubectl -n "$STAGING_SYSTEM_NS" delete service "$LOCAL_EGRESS_SERVICE" \
    --ignore-not-found >/dev/null
}

rollback_to_offline() {
  local failed=0
  echo "staging target publication failed; rolling staging back to offline" >&2
  write_router_config offline || failed=1
  roll_router || failed=1
  set_ingress_state none offline || failed=1
  cleanup_local_egress || failed=1
  return "$failed"
}

ensure_system_route() {
  kubectl create namespace "$STAGING_SYSTEM_NS" --dry-run=client -o yaml | kubectl apply -f -

  if ! kubectl -n "$STAGING_SYSTEM_NS" get configmap "$STAGING_ROUTER" >/dev/null 2>&1; then
    write_router_config offline
  fi

  kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $STAGING_ROUTER
  namespace: $STAGING_SYSTEM_NS
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: $STAGING_ROUTER }
  template:
    metadata:
      labels: { app: $STAGING_ROUTER }
    spec:
      containers:
        - name: router
          image: nginxinc/nginx-unprivileged:1.27.4-alpine
          ports:
            - { name: http, containerPort: 8080 }
          readinessProbe:
            httpGet: { path: /__staging_router_ready, port: http }
            periodSeconds: 3
            failureThreshold: 20
          resources:
            requests: { cpu: 10m, memory: 24Mi }
            limits: { cpu: 250m, memory: 128Mi }
          volumeMounts:
            - name: config
              mountPath: /etc/nginx/conf.d/default.conf
              subPath: default.conf
              readOnly: true
      volumes:
        - name: config
          configMap: { name: $STAGING_ROUTER }
---
apiVersion: v1
kind: Service
metadata:
  name: $STAGING_ROUTER
  namespace: $STAGING_SYSTEM_NS
spec:
  selector: { app: $STAGING_ROUTER }
  ports:
    - { name: http, port: 80, targetPort: http }
EOF

  # cert-manager issues the *.lobu.ai wildcard into the prod namespace, and a
  # TLS secret is only readable from its own namespace — copy it next to the
  # ingress that references it.
  kubectl -n "$WILDCARD_TLS_NS" get secret "$WILDCARD_TLS_SECRET" -o json |
    jq --arg ns "$STAGING_SYSTEM_NS" \
      '{apiVersion, kind, type, data, metadata: {name: .metadata.name, namespace: $ns}}' |
    kubectl apply -f -

  # `--ignore-not-found` distinguishes first-run absence (success with no body)
  # from an API read failure. Only real absence may initialize the annotations;
  # a transient read error must not overwrite a live owner with bootstrap state.
  local ingress_json owner target
  ingress_json="$(
    kubectl -n "$STAGING_SYSTEM_NS" get ingress "$STAGING_INGRESS" \
      -o json --ignore-not-found
  )" || fail "could not read the current staging Ingress"
  if [ -n "$ingress_json" ]; then
    owner="$(jq -r '.metadata.annotations["lobu.ai/staging-owner"] // "none"' <<<"$ingress_json")"
    target="$(jq -r '.metadata.annotations["lobu.ai/staging-target"] // "offline"' <<<"$ingress_json")"
  else
    owner=none
    target=offline
  fi

  kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: $STAGING_INGRESS
  namespace: $STAGING_SYSTEM_NS
  annotations:
    lobu.ai/staging-owner: "$owner"
    lobu.ai/staging-target: "$target"
spec:
  ingressClassName: traefik
  tls:
    - hosts: ["$STAGING_HOST"]
      secretName: $WILDCARD_TLS_SECRET
  rules:
    - host: $STAGING_HOST
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: $STAGING_ROUTER
                port: { number: 80 }
EOF

  kubectl -n "$STAGING_SYSTEM_NS" rollout status "deployment/$STAGING_ROUTER" --timeout=180s

  # Two Ingresses claiming the same host leave the backend up to whichever one
  # traefik picks, so sweep every other namespace's copy — the pre-router
  # workflow left one there — but only once the permanent route is ready.
  local namespaces
  namespaces="$(
    kubectl get ingress -A \
      --field-selector "metadata.name=$STAGING_INGRESS" \
      -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}'
  )" || fail "could not list staging Ingress claims"
  while IFS= read -r namespace; do
    [ -z "$namespace" ] && continue
    if [ "$namespace" != "$STAGING_SYSTEM_NS" ]; then
      kubectl -n "$namespace" delete ingress "$STAGING_INGRESS" --ignore-not-found
    fi
  done <<<"$namespaces"
}

strip_other_staging_labels() {
  local keep="${1:-}"
  [ -n "${GH_TOKEN:-}" ] || return 0
  # Each gh call gets its own assignment and its own `|| return 1`. Read
  # straight from a pipe or a process substitution, this shell would take
  # grep's status (or an empty list): a rate limit or 5xx would read as "no
  # other PR is labelled" and leave two PRs holding `staging` while one holds
  # the route. The explicit return is what carries that failure out: the
  # routing callers run this inside the condition of an `if !`, where Bash
  # disables errexit, so `-e` alone would let a gh outage pass for "nobody
  # else holds the label" and route anyway.
  local numbers number labels
  numbers="$(gh pr list --state open --limit 200 --json number --jq '.[].number')" || return 1
  while IFS= read -r number; do
    [ -z "$number" ] && continue
    [ -n "$keep" ] && [ "$number" = "$keep" ] && continue
    labels="$(gh pr view "$number" --json labels --jq '.labels[].name')" || return 1
    if printf '%s\n' "$labels" | grep -qx staging; then
      gh pr edit "$number" --remove-label staging || return 1
      echo "stripped staging label from PR #$number"
    fi
  done <<<"$numbers"
}

pr_has_staging_label() {
  local number="$1"
  local labels
  [ -n "${GH_TOKEN:-}" ] || return 2
  labels="$(gh pr view "$number" --json labels --jq '.labels[].name')" || return 2
  printf '%s\n' "$labels" | grep -qx staging
}

# Best-effort on purpose: the commonest caller is the `closed` release, and by
# then preview.yml has already deleted the namespace this would write to.
restore_private_preview() {
  local number="$1"
  local namespace="lobu-preview-$number"
  local name="lobu-pr-$number"
  kubectl -n "$namespace" set env "deployment/$name" \
    PUBLIC_GATEWAY_URL- LOBU_LOCAL_INIT_ALLOW_PROXY=1 >/dev/null 2>&1 || true
}

# Whoever holds the route is about to lose it, and its preview is still carrying
# the public-host settings route_preview gave it. Stripping that PR's `staging`
# label does not hand them back: the edit runs on GITHUB_TOKEN, which fires no
# workflow run, so no owner-scoped release ever follows it.
#
# Reading and restoring are separate steps because they belong on opposite sides
# of publication. set_ingress_state overwrites the annotation read here, so the
# lookup has to happen first; the restore must not, because it hands the
# outgoing holder LOBU_LOCAL_INIT_ALLOW_PROXY=1 back and until the route has
# moved the public host still resolves to that preview.
displaced_pr_holder() {
  local keep="${1:-}"
  local current
  current="$(current_owner)" || return 1
  if [[ "$current" =~ ^pr-([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" != "$keep" ]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
  return 0
}

# Empty means nothing was displaced, so callers can call this unconditionally.
restore_displaced_preview() {
  [ -n "${1:-}" ] || return 0
  restore_private_preview "$1"
}

# Refuses by exiting, so both callers invoke it in a subshell: the exit has to
# stop at that boundary or it would skip the rollback that puts the host back on
# the offline sink.
verify_public_target() {
  local body=""
  local attempt
  for attempt in $(seq 1 20); do
    body="$(curl -fsS --max-time 15 "https://$STAGING_HOST/api/health?staging_probe=$RUN_KEY" 2>/dev/null || true)"
    if jq -e '.status == "healthy" and .environment != "production"' >/dev/null 2>&1 <<<"$body"; then
      break
    fi
    if jq -e '.environment == "production"' >/dev/null 2>&1 <<<"$body"; then
      fail "refusing to route staging to production"
    fi
    sleep 3
  done
  assert_non_prod_health "$body"

  local metadata
  metadata="$(curl -fsS --max-time 15 "https://$STAGING_HOST/.well-known/oauth-authorization-server")"
  [ "$(jq -r '.issuer' <<<"$metadata")" = "https://$STAGING_HOST" ] ||
    fail "OAuth issuer does not match https://$STAGING_HOST"

  # Send the header a real client sends. The CSRF header is the LAST of
  # assertLoopbackClient's checks, so a probe without it is refused as
  # missing_client_header even when the forwarded-* boundary is wide open — a
  # 403 indistinguishable from the closed-boundary one, masking exactly the
  # open boundary this check exists to catch.
  local local_init_status
  local_init_status="$(
    curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
      -H 'X-Lobu-Client: staging-probe' \
      -X POST "https://$STAGING_HOST/api/local-init"
  )"
  [ "$local_init_status" = "403" ] ||
    fail "public /api/local-init returned $local_init_status instead of 403"
}

verify_public_offline() {
  local response_file status body attempt
  response_file="$(mktemp)"
  status=""
  body=""
  # The router just went through a Recreate rollout, so traefik's endpoints can
  # lag it by a second or two. Retry on the same budget as verify_public_target
  # rather than reading that lag as a failed release.
  for attempt in $(seq 1 20); do
    status="$(
      curl -sS --max-time 15 -o "$response_file" -w '%{http_code}' \
        "https://$STAGING_HOST/api/health?staging_probe=$RUN_KEY" 2>/dev/null || true
    )"
    body="$(<"$response_file")"
    [ "$status" = "503" ] && break
    sleep 3
  done
  rm -f "$response_file"
  [ "$status" = "503" ] || fail "offline staging returned HTTP $status instead of 503"
  jq -e '.status == "offline" and .environment == "staging"' >/dev/null 2>&1 <<<"$body" ||
    fail "offline staging returned an unexpected body: $body"
}

route_preview() {
  [[ "$PR_NUM" =~ ^[0-9]+$ ]] || fail "preview target requires a numeric PR number"
  # GitHub keeps only one pending job per concurrency group. A post-deploy
  # reconcile can therefore replace an older label-event run before that run
  # starts. Read the current label instead of trusting either event payload: the
  # surviving job must perform the canceled acquire or scoped release, never a
  # route-neutral no-op.
  if pr_has_staging_label "$PR_NUM"; then
    :
  else
    local label_status=$?
    [ "$label_status" -eq 1 ] ||
      fail "could not read the current staging label for PR #$PR_NUM"
    echo "PR #$PR_NUM no longer has the staging label; reconciling its release"
    route_offline
    return 0
  fi
  local owner_before_prepare
  owner_before_prepare="$(current_owner)" ||
    fail "could not read the current staging lock owner"
  local namespace="lobu-preview-$PR_NUM"
  local name="lobu-pr-$PR_NUM"

  local attempt
  for attempt in $(seq 1 36); do
    kubectl -n "$namespace" get service "$name" >/dev/null 2>&1 && break
    echo "waiting for $namespace/$name service... ($attempt)"
    sleep 10
  done
  kubectl -n "$namespace" get service "$name" >/dev/null 2>&1 ||
    fail "preview service $namespace/$name was not found"

  # preview.yml sets LOBU_LOCAL_INIT_ALLOW_PROXY=1 because a plain preview is
  # tailnet-only; on this public host that same setting would let anyone on the
  # internet mint an owner session (auth/routes.ts names public tunnels as the
  # case it refuses by default). PUBLIC_GATEWAY_URL pins resolvePublicOrigin —
  # the MCP App asset URLs — which otherwise falls back to the request URL and
  # reads as http behind the ingress. OAuth discovery deliberately ignores it
  # (skipEnvOverride, auth/oauth/routes.ts) and derives its issuer from the
  # X-Forwarded-* pair the router sets, which is what verify_public_target
  # checks.
  local upstream="$name.$namespace.svc.cluster.local:80"
  if ! (
    kubectl -n "$namespace" set env "deployment/$name" \
      LOBU_LOCAL_INIT_ALLOW_PROXY- \
      "PUBLIC_GATEWAY_URL=https://$STAGING_HOST/lobu" &&
      kubectl -n "$namespace" rollout status "deployment/$name" --timeout=600s &&
      verify_non_prod_health "http://$upstream/api/health"
  ); then
    if [ "$owner_before_prepare" = "pr-$PR_NUM" ]; then
      if rollback_to_offline; then
        restore_private_preview "$PR_NUM"
        fail "preview backend $namespace/$name never became healthy; staging rolled back to offline"
      fi
      fail "preview backend $namespace/$name never became healthy and offline rollback failed; public-safe settings retained"
    fi
    restore_private_preview "$PR_NUM"
    fail "preview backend $namespace/$name never became healthy; private settings restored"
  fi
  # Same rule as route_local_tailnet: leave the current holder's label alone
  # until the replacement target has proved healthy, or a preview that never
  # comes up strips the label off a PR that still owns the route.
  local displaced=''
  if ! displaced="$(displaced_pr_holder "$PR_NUM")" ||
    ! strip_other_staging_labels "$PR_NUM"; then
    if [ "$owner_before_prepare" = "pr-$PR_NUM" ]; then
      fail "could not prepare staging lock transfer; current owner retains public-safe settings"
    fi
    restore_private_preview "$PR_NUM"
    fail "could not prepare staging lock transfer; private preview settings restored"
  fi
  if ! (
    write_router_config preview "$upstream" &&
      roll_router &&
      set_ingress_state "pr-$PR_NUM" preview &&
      cleanup_local_egress &&
      verify_public_target
  ); then
    rollback_to_offline ||
      fail "preview publication failed and offline rollback also failed"
    restore_private_preview "$PR_NUM"
    restore_displaced_preview "$displaced"
    fail "preview publication failed; staging rolled back to offline"
  fi
  # The public host resolves to this PR now, so the outgoing holder can have its
  # passwordless bootstrap back.
  restore_displaced_preview "$displaced"

  # preview.yml's post-deploy reconcile sets STAGING_SKIP_COMMENT: it re-points
  # the router at a Service its own deploy just recreated, and the lock it
  # announces is one this PR already held.
  if [ -n "${GH_TOKEN:-}" ] && [ "${STAGING_SKIP_COMMENT:-0}" != 1 ]; then
    # The rollout above restarted the pod and the preview's data volume is an
    # emptyDir, so the sign-in has to happen after the lock — and from inside
    # the pod, where the peer really is loopback.
    gh pr comment "$PR_NUM" --body "$(printf "%s\n" \
      "## Staging URL locked to this PR" \
      "- **App**: https://$STAGING_HOST" \
      "- **MCP endpoint**: https://$STAGING_HOST/mcp" \
      "" \
      "This host is publicly reachable, so a cloud MCP host can call it. Passwordless bootstrap is disabled on it; sign in once from inside the pod:" \
      "" \
      "\`\`\`" \
      "kubectl -n $namespace exec deploy/$name -- \\" \
      "  curl -sS -X POST -H 'X-Lobu-Client: staging-bootstrap' http://127.0.0.1:8787/api/local-init" \
      "\`\`\`" \
      "" \
      "Removing the \`staging\` label takes the public host back to its offline sink.")"
  fi
  echo "staging locked to PR #$PR_NUM at https://$STAGING_HOST"
}

route_local_tailnet() {
  local fqdn="${STAGING_LOCAL_TAILNET_FQDN:-}"
  local tailnet_domain="${TAILNET_DOMAIN:-}"
  local port="${STAGING_LOCAL_TAILNET_PORT:-}"
  fqdn="${fqdn%.}"
  tailnet_domain="${tailnet_domain%.}"
  [ -n "$fqdn" ] || fail "STAGING_LOCAL_TAILNET_FQDN repository variable is required"
  [ -n "$tailnet_domain" ] || fail "TAILNET_DOMAIN repository variable is required"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "STAGING_LOCAL_TAILNET_PORT must be numeric"
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] ||
    fail "STAGING_LOCAL_TAILNET_PORT must be between 1024 and 65535"
  if [ "$fqdn" != "$tailnet_domain" ] &&
    [[ "$fqdn" != *."$tailnet_domain" ]]; then
    fail "local target $fqdn is outside the configured tailnet domain"
  fi

  # The egress Service is private to the cluster, but it still reaches a
  # developer machine. Remove it if any readiness or health check fails, and
  # do not disturb the current staging label until the replacement target has
  # proved healthy.
  local upstream="$LOCAL_EGRESS_SERVICE.$STAGING_SYSTEM_NS.svc.cluster.local:$port"
  if ! (
    kubectl apply -f - <<EOF || exit 1
apiVersion: v1
kind: Service
metadata:
  name: $LOCAL_EGRESS_SERVICE
  namespace: $STAGING_SYSTEM_NS
  annotations:
    tailscale.com/tailnet-fqdn: "$fqdn"
spec:
  type: ExternalName
  externalName: placeholder.invalid
  ports:
    - name: http
      protocol: TCP
      port: $port
      targetPort: $port
EOF

    kubectl -n "$STAGING_SYSTEM_NS" wait \
      --for=condition=TailscaleProxyReady \
      "service/$LOCAL_EGRESS_SERVICE" \
      --timeout=180s || exit 1

    verify_non_prod_health "http://$upstream/api/health"
  ); then
    cleanup_local_egress
    fail "local tailnet target $fqdn did not become ready and healthy; cluster egress removed"
  fi
  local displaced=''
  if ! displaced="$(displaced_pr_holder)" || ! strip_other_staging_labels; then
    cleanup_local_egress
    fail "could not prepare staging lock transfer; local egress removed"
  fi
  if ! (
    write_router_config local-tailnet "$upstream" &&
      roll_router &&
      set_ingress_state local-tailnet local-tailnet &&
      verify_public_target
  ); then
    rollback_to_offline ||
      fail "local-tailnet publication failed and offline rollback also failed"
    restore_displaced_preview "$displaced"
    fail "local-tailnet publication failed; staging rolled back to offline"
  fi
  restore_displaced_preview "$displaced"
  echo "staging locked to local tailnet target at https://$STAGING_HOST"
}

route_offline() {
  # An owner scope that is not a PR number can never match the annotation, so
  # without this a typo in the dispatch input would silently exit 0 with the
  # public host still published.
  [ -z "$PR_NUM" ] || [[ "$PR_NUM" =~ ^[0-9]+$ ]] ||
    fail "offline owner scope must be a numeric PR number"
  local displaced=''
  if [ -n "$PR_NUM" ]; then
    local current
    current="$(current_owner)" ||
      fail "could not read the current staging lock owner"
    if [ "$current" != "pr-$PR_NUM" ]; then
      # The public host does not resolve to this preview, so handing back its
      # private-host settings now opens nothing.
      restore_private_preview "$PR_NUM"
      echo "lock owner is $current; leaving it unchanged"
      return 0
    fi
    displaced="$PR_NUM"
  else
    # A manual force-off has no pull-request event to remove the displaced
    # holder's label either. Queued unlabeled events remain harmless because
    # their owner-scoped release will observe owner=none.
    displaced="$(displaced_pr_holder)" ||
      fail "could not read the current staging lock owner"
  fi

  write_router_config offline
  roll_router
  set_ingress_state none offline
  cleanup_local_egress
  verify_public_offline
  # Only now is the public host off that preview.
  restore_displaced_preview "$displaced"
  if [ -z "$PR_NUM" ]; then
    strip_other_staging_labels ||
      fail "staging is offline but its PR labels could not be cleaned up"
  fi
  echo "staging is offline at https://$STAGING_HOST (exact-host 503 sink)"
}

case "$TARGET" in
  preview | local-tailnet | offline | refresh-tls) ;;
  *) fail "target must be preview, local-tailnet, offline, or refresh-tls" ;;
esac

ensure_system_route

case "$TARGET" in
  preview) route_preview ;;
  local-tailnet) route_local_tailnet ;;
  offline) route_offline ;;
  refresh-tls) echo "staging wildcard TLS secret refreshed; route unchanged" ;;
esac
