#!/usr/bin/env bash
#
# Out-of-band batched backfill of the `conversations` entity (the sidebar's single
# listing source). The conversations table is materialized going forward by the
# live dual-write (message-consumer → upsertConversation); this script fills in
# PRE-EXISTING conversations so the sidebar isn't thin right after the cutover.
#
# Deliberately NOT a migration. Per docs/MIGRATIONS.md, a data-migration scan of
# runs + agent_transcript_snapshot inside the blocking Helm pre-upgrade hook would
# risk the 60s statement_timeout deploy-wedge (the 2026-06-24 incident). And it's
# COSMETIC: the table's only reader is the sidebar, so a missing row simply isn't
# listed until that conversation's next turn re-materializes it. So this runs
# post-deploy, in ~10k-row batches, each its own transaction with a sleep between,
# so VACUUM keeps up and no single statement risks the timeout.
#
# Source: runs (run_type='chat_message') — the only durable source that carries an
# authoritative platform (explicit, lowercased), user_id, and message text (→
# title), mirroring the live classifyConversation exactly. Pruned after 30 days;
# conversations older than that re-materialize on their next turn (see the note
# after the loop for why agent_transcript_snapshot is NOT a second source).
#
# Idempotent + resumable: ON CONFLICT DO UPDATE (GREATEST/COALESCE, so a
# conversation spanning batches advances correctly), paging ascending over runs.id.
# Safe to run anytime, repeatedly, concurrently with live traffic.
#
# Usage: DATABASE_URL=postgres://... ./scripts/backfill-conversations.sh
#   BATCH=10000  source rows per batch (default 10000)
#   SLEEP=0.2    seconds between batches (default 0.2)

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
BATCH=${BATCH:-10000}
SLEEP=${SLEEP:-0.2}

echo "Backfilling conversations (batch=${BATCH}, sleep=${SLEEP}s)…"

# ── Pass 1: runs (authoritative platform + title) ──────────────────────────────
# Page ascending over runs.id. Each batch upserts the DISTINCT conversations found
# in that id-window (ON CONFLICT DO UPDATE, below).
echo "Pass 1: runs (chat_message)…"
last_id=0
total1=0
while :; do
  read -r maxid n < <(psql "$DATABASE_URL" -tA -F' ' -c "
    WITH win AS (
      SELECT id, organization_id, action_input, created_at
      FROM public.runs
      WHERE run_type = 'chat_message' AND id > ${last_id}
      ORDER BY id
      LIMIT ${BATCH}
    ), src AS (
      SELECT
        organization_id AS org,
        action_input->>'agentId' AS agent,
        lower(action_input->>'platform') AS raw_platform,
        action_input->>'conversationId' AS conv,
        action_input->>'userId' AS uid,
        action_input->>'messageText' AS msg,
        created_at AS at
      FROM win
      WHERE organization_id IS NOT NULL
        AND jsonb_typeof(action_input) = 'object'
        AND action_input->>'agentId' IS NOT NULL
        AND action_input->>'conversationId' IS NOT NULL
        AND action_input->>'conversationId' !~ '_automation_\\d+_run_\\d+\$'
    ), classified AS (
      SELECT
        org, agent, conv, uid, msg, at,
        CASE WHEN raw_platform = 'api' THEN 'owned' ELSE 'platform' END AS kind,
        CASE WHEN raw_platform = 'api' THEN 'web' ELSE raw_platform END AS platform
      FROM src
    ), ranked AS (
      SELECT DISTINCT ON (org, agent, platform, conv)
        org, agent, platform, conv, kind, uid, msg, at,
        max(at) OVER (PARTITION BY org, agent, platform, conv) AS last_at
      FROM classified
      ORDER BY org, agent, platform, conv, at ASC
    ), ins AS (
      INSERT INTO public.conversations
        (organization_id, agent_id, platform, conversation_id,
         kind, user_id, title, last_activity_at, created_at)
      SELECT org, agent, platform, conv, kind, uid, left(msg, 200), last_at, at
      FROM ranked
      -- DO UPDATE (not DO NOTHING) so a conversation whose runs span two batches
      -- advances to its newest activity and keeps the earliest known title/user —
      -- same GREATEST/COALESCE semantics as the live upsertConversation, so a
      -- concurrent live turn during the backfill also converges correctly.
      ON CONFLICT (organization_id, agent_id, platform, conversation_id) DO UPDATE SET
        last_activity_at = GREATEST(public.conversations.last_activity_at, EXCLUDED.last_activity_at),
        title = COALESCE(public.conversations.title, EXCLUDED.title),
        user_id = COALESCE(public.conversations.user_id, EXCLUDED.user_id),
        updated_at = now()
      RETURNING 1
    )
    SELECT
      COALESCE((SELECT max(id) FROM win), ${last_id}) AS maxid,
      (SELECT count(*) FROM ins) AS inserted;
  ")
  total1=$((total1 + n))
  echo "  batch up to id ${maxid}: upserted ${n} (total ${total1})"
  # Empty window → win has no rows → max(id) is NULL → maxid == last_id → done.
  [ "${maxid}" -le "${last_id}" ] && break
  last_id=${maxid}
  sleep "${SLEEP}"
done
echo "Pass 1 done: inserted ${total1} rows."

# NOTE: there is deliberately NO snapshot-tail pass. agent_transcript_snapshot has
# no user_id column, and an owned/web conversation's user_id CANNOT be recovered
# from the packed id (`{agentId}_{userId}_{org}_{thread}` — every segment may
# itself contain underscores, so the split is ambiguous; this is the same reason
# the reverse-parse heuristic was removed from the live path). A backfilled owned
# row with a null user_id never appears in the default user-scoped sidebar
# (listConversations filters `user_id = <requester>`), so it would deliver nothing.
# Owned conversations older than the 30-day runs-retention window re-materialize
# correctly on their next turn (the user reopening the thread supplies the userId
# and dual-writes the row). Runs (pass 1) covers everything within retention with
# an authoritative user_id.

echo "Done. Backfilled ${total1} conversations total."
