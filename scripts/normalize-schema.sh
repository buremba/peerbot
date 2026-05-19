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
# Lines patched:
#   schema_migrations.version  — pg18's pg_dump emits this column as bare
#                                `character varying`, dropping the explicit
#                                length dbmate declared. The committed form
#                                (and what CI keeps) is `character varying(128)`.
#                                Restoring the (128) here lets local regen
#                                under pg18 produce a byte-identical file.
#                                Other columns are unaffected — they have
#                                explicit lengths in migrations and pg18
#                                preserves them.
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
  # Restore schema_migrations.version length stripped by pg18 pg_dump.
  # Table-scoped: only inside `CREATE TABLE public.schema_migrations (...)`.
  # Without the scope guard, any future app table whose column happens to be
  # exactly `    version character varying NOT NULL` would also get silently
  # patched to (128) — which would be wrong.
  /^CREATE TABLE public\.schema_migrations \(/ { in_schema_migrations = 1 }
  in_schema_migrations && /^    version character varying NOT NULL$/ {
    sub(/character varying/, "character varying(128)")
  }
  in_schema_migrations && /^\);/ { in_schema_migrations = 0 }
  {
    if (pending_blank) { print ""; pending_blank = 0 }
    print
    seen = 1
  }
' "$file" >"$tmp"
mv "$tmp" "$file"
