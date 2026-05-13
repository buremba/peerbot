#!/usr/bin/env bash
# Strip non-deterministic / env-dependent lines from a pg_dump output so the
# file is byte-stable across pg_dump versions and runs. Used by the
# `migrations` CI job's schema-drift check.
#
# Lines removed:
#   \restrict <random>     — pg17+ session token at the top of the dump
#   \unrestrict <random>   — matching footer
#   -- Dumped from database version <...>
#   -- Dumped by pg_dump version <...>
#   SET transaction_timeout = 0;   — emitted only by pg17+
#
# Adjacent blank lines that result from deletions are collapsed and any
# leading blanks at the top of the file are dropped, so the output is the
# same regardless of which lines were originally present.
#
# Usage: scripts/normalize-schema.sh db/schema.sql
set -euo pipefail
file="${1:?usage: $0 <schema.sql>}"
tmp="$(mktemp)"
awk '
  /^\\restrict [^[:space:]]+$/   { next }
  /^\\unrestrict [^[:space:]]+$/ { next }
  /^-- Dumped from database version / { next }
  /^-- Dumped by pg_dump version /    { next }
  /^SET transaction_timeout = 0;$/    { next }
  /^$/ {
    # Drop leading blanks before any content. Once content has been emitted,
    # collapse runs of blank lines: queue one and emit it before the next
    # non-blank line.
    if (!seen) next
    pending_blank = 1
    next
  }
  {
    if (pending_blank) { print ""; pending_blank = 0 }
    print
    seen = 1
  }
' "$file" >"$tmp"
mv "$tmp" "$file"
