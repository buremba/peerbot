# dev-app-url.sh — local dev UI URL (PUBLIC_GATEWAY_URL) for logs and OPEN=1.
# Sourced after .env / .env.local are loaded; REPO_ROOT must be set.

lobu_dev_app_url() {
  if [[ -n "${PUBLIC_GATEWAY_URL:-}" ]]; then
    printf '%s' "$PUBLIC_GATEWAY_URL"
    return 0
  fi
  local host="${HOST:-127.0.0.1}"
  local port="${PORT:-8787}"
  printf 'http://%s:%s/lobu' "$host" "$port"
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