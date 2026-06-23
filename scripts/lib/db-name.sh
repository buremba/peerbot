#!/usr/bin/env bash
# Single source of truth for the per-branch dev database name.
# `dev-db.sh` creates `lobu_<slug>`; `task-clean.sh` drops it. Keeping the slug
# derivation here means the two can never drift — a mismatch would silently
# orphan databases (the exact bug this consolidation prevents).
#
# Usage:  db="$(lobu_db_name "$raw_name")"

lobu_db_name() {
  local raw="$1" slug db
  # Sanitize to a legal lowercase PG identifier — `feat/sidebar` → `feat_sidebar`.
  slug="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')"
  db="lobu_${slug:-dev}"
  # Postgres silently truncates identifiers past 63 bytes, which would collide
  # two long branch names into one database. Cap with a short hash of the full
  # name so distinct long branches stay distinct.
  if [ "${#db}" -gt 63 ]; then
    db="${db:0:52}_$(printf '%s' "$db" | cksum | cut -d' ' -f1)"
  fi
  printf '%s' "$db"
}
