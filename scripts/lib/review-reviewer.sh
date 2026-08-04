#!/usr/bin/env bash

review_is_codex_harness() {
  [ -n "${CODEX_THREAD_ID:-}" ] ||
    [ -n "${CODEX_MANAGED_PACKAGE_ROOT:-}" ] ||
    [ "${CODEX_CI:-}" = "1" ]
}

review_select_reviewer() {
  case "$1" in
    auto)
      if review_is_codex_harness; then
        printf 'claude\n'
      else
        printf 'codex\n'
      fi
      ;;
    codex|claude|pi)
      printf '%s\n' "$1"
      ;;
    *)
      echo "invalid REVIEWER_CLI=$1 (expected auto, codex, claude, or pi)" >&2
      return 2
      ;;
  esac
}

review_validate_claude_model() {
  case "$1" in
    fable|opus|claude-opus-?*) return 0 ;;
    *)
      echo "invalid CLAUDE_REVIEW_MODEL=$1 (only fable, opus, or a claude-opus-* model is allowed)" >&2
      return 2
      ;;
  esac
}

review_should_retry_inline() {
  [ "$1" -eq 0 ] || return 1
  [ -z "$(printf '%s' "$2" | tr -d '[:space:]')" ]
}

review_fail_closed_message() {
  local reviewer="$1"
  local detail="$2"
  printf "Independent review could not be completed by '%s': %s. The review gate fails closed and will not fall back to another reviewer. Fix the selected reviewer's installation, authentication, quota, or configuration, then rerun; use REVIEWER_CLI=claude|codex|pi only to explicitly select the intended independent reviewer.\n" \
    "$reviewer" "$detail"
}
