#!/bin/bash
# PreToolUse hook: refuse to prove a schema NEGATIVE from truncated output.
#
# Why this exists: a session queried `pg_indexes` for the unique indexes on
# `connections`, piped it through `head -6`, and the 7th row — the partial
# unique index that made the whole finding a false positive — was amputated.
# That single dropped row cost an 85-confidence wrong claim, a dispatched
# agent, and a near-miss brief authorising deletion of a load-bearing branch.
#
# The rule: truncation is fine when you are confirming something EXISTS (the
# first match proves it). It is never fine when the conclusion is "there is no
# other index/constraint/policy", because the row that refutes you is exactly
# the one that scrolls off.
#
# Scope is deliberately narrow — only the catalogs that describe CONSTRAINTS
# (pg_indexes / pg_constraint / pg_policies). information_schema is excluded:
# it is dominated by "does this column exist" checks, where `| head -1` is a
# legitimate positive test. Measured over 156,887 historical Bash calls in
# this project, this matcher fires 2 times, and both are the dangerous shape.
#
# Escape hatch (matches the repo's existing `raw-array-ok` / `squawk-ignore`
# convention): add `# TRUNCATION-OK: <reason>` to the command.

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# Explicit opt-out, with a stated reason.
echo "$command" | grep -qE '#[[:space:]]*TRUNCATION-OK:' && exit 0

# (a) Does it read a constraint-shaped catalog?
echo "$command" | grep -qE 'pg_indexes|pg_constraint|pg_policies' || exit 0

# (b) Is the result truncated? `head`/`tail` through a pipe, or a SQL LIMIT.
echo "$command" | grep -qE '\|[[:space:]]*(head|tail)([[:space:]]|$)|[Ll][Ii][Mm][Ii][Tt][[:space:]]+[0-9]' || exit 0

cat >&2 <<'MSG'
BLOCKED: truncated schema-catalog query.

You are reading pg_indexes/pg_constraint/pg_policies through `head`/`tail`/`LIMIT`.
If you are about to conclude "there is no other constraint" — the row that would
refute you is the one being cut off. This exact pattern produced a false-positive
cross-tenant bug report in this repo.

Do instead:
  - Drop the truncation and read every row.
  - Add `SELECT count(*)` alongside it so a missing row is visibly impossible.

If the truncation is genuinely safe (you are confirming something EXISTS, and the
first match settles it), say so explicitly:
  # TRUNCATION-OK: confirming the index exists, not proving absence
MSG
exit 2
