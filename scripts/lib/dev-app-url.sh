# dev-app-url.sh — local dev UI URL for logs and OPEN=1.
# Sourced after .env / .env.local are loaded; REPO_ROOT must be set.
#
# PUBLIC_GATEWAY_URL is the *Agent API* base (mounted at /lobu on the wrapper
# app — see server-lifecycle.ts). The SPA is pathless at the origin. Never open
# …/lobu in a browser; that mount is API + docs, not the UI.

# Strip a trailing /lobu path (and trailing slashes) so a gateway URL becomes
# the pathless SPA origin. Leaves other path suffixes alone.
lobu_dev_spa_origin_from_gateway_url() {
  local raw="${1:-}"
  # Drop query/fragment if present.
  raw="${raw%%\?*}"
  raw="${raw%%#*}"
  # Strip trailing slashes, then a final /lobu segment.
  while [[ "$raw" == */ ]]; do raw="${raw%/}"; done
  if [[ "$raw" == */lobu ]]; then
    raw="${raw%/lobu}"
  fi
  while [[ "$raw" == */ ]]; do raw="${raw%/}"; done
  printf '%s' "$raw"
}

lobu_dev_app_url() {
  if [[ -n "${PUBLIC_GATEWAY_URL:-}" ]]; then
    lobu_dev_spa_origin_from_gateway_url "$PUBLIC_GATEWAY_URL"
    return 0
  fi
  local host="${HOST:-127.0.0.1}"
  local port="${PORT:-8787}"
  printf 'http://%s:%s' "$host" "$port"
}

lobu_dev_print_app_url() {
  local url
  url="$(lobu_dev_app_url)"
  echo "→ App (browser):  $url"
  echo "   OPEN=1 make dev — open in the default browser once the server is up"
}

lobu_dev_schedule_open() {
  local url delay
  url="$(lobu_dev_app_url)"
  delay="${LOBU_OPEN_DELAY:-5}"
  (
    sleep "$delay"
    if command -v open >/dev/null 2>&1; then
      open "$url" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" >/dev/null 2>&1 || true
    else
      echo "→ OPEN=1: no open/xdg-open; visit $url" >&2
    fi
  ) &
}
