#!/bin/bash
# Shared secret-args builder for .env → Kubernetes secret tooling.
#
# Sourced by `scripts/seal-env.sh` and `scripts/sync-env-to-k8s.sh`. Reads
# env vars from the current shell (callers `set -a; source .env; set +a`
# beforehand) and populates a SECRET_ARGS bash array with
# `--from-literal=<k8s-key>=<value>` entries for every non-empty secret.
#
# Usage:
#   SECRET_ARGS=()
#   source "$SCRIPT_DIR/lib/secret-args.sh"
#   build_secret_args
#   # SECRET_ARGS is now populated

build_secret_args() {
  # Slack credentials
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] && SECRET_ARGS+=(--from-literal=slack-bot-token="$SLACK_BOT_TOKEN")
  [[ -n "${SLACK_APP_TOKEN:-}" ]] && SECRET_ARGS+=(--from-literal=slack-app-token="$SLACK_APP_TOKEN")
  [[ -n "${SLACK_SIGNING_SECRET:-}" ]] && SECRET_ARGS+=(--from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET")
  [[ -n "${SLACK_CLIENT_ID:-}" ]] && SECRET_ARGS+=(--from-literal=slack-client-id="$SLACK_CLIENT_ID")
  [[ -n "${SLACK_CLIENT_SECRET:-}" ]] && SECRET_ARGS+=(--from-literal=slack-client-secret="$SLACK_CLIENT_SECRET")

  # Claude/Anthropic credentials
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && SECRET_ARGS+=(--from-literal=anthropic-api-key="$ANTHROPIC_API_KEY")
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && SECRET_ARGS+=(--from-literal=claude-code-oauth-token="$CLAUDE_CODE_OAUTH_TOKEN")

  # Encryption key
  [[ -n "${ENCRYPTION_KEY:-}" ]] && SECRET_ARGS+=(--from-literal=encryption-key="$ENCRYPTION_KEY")

  # Sentry
  [[ -n "${SENTRY_DSN:-}" ]] && SECRET_ARGS+=(--from-literal=sentry-dsn="$SENTRY_DSN")

  # GitHub
  [[ -n "${GITHUB_CLIENT_SECRET:-}" ]] && SECRET_ARGS+=(--from-literal=github-client-secret="$GITHUB_CLIENT_SECRET")

  # Telegram
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && SECRET_ARGS+=(--from-literal=telegram-bot-token="$TELEGRAM_BOT_TOKEN")
}
