# WS-A (KEYSTONE) — Slack message ingestion as a person-attributed streaming feed

> Status: plan, ready for an implementer. Depends on WS-D landing `feeds.kind`.
> Folds in the managed-Slack read-orphan fix. See [README](./README.md) for
> cross-cutting decisions.

## Goal
Make inbound Slack channel messages first-class data: each channel becomes a
`streaming` feed, and senders get attributed to person entities — so "who said
what across sources" becomes queryable. Keystone that unlocks data + identity +
the feed model together.

## Verification of grounded findings (confirmed vs corrected)

| Claim | Status | Evidence |
|---|---|---|
| `channel_messages` is flat, no `entity_id`/`feed_id`, dedup `UNIQUE(connection_id, channel_id, platform_message_id)` | CONFIRMED | `db/migrations/20260618130000_channel_messages.sql` |
| 4 writers, all pass runtime text connection id | CONFIRMED | `message-handler-bridge.ts:406`, `:639`; `chat-response-bridge.ts:411`; `routes/internal/conversations.ts:206`; all funnel through `captureChannelMessage` → `persistChannelMessage` (`gateway/connections/channel-transcript.ts:37`) |
| Slug-join reconciliation rule | CONFIRMED | matches the keys minted by `20260629000030_connections_unify_backfill.sql` |
| `feeds` natural key `(connection_id, feed_key)`; channel feed = `(connection_id, feed_key=channel_id)` | CONFIRMED logical key, **NOT DB-enforced** | `feeds` pkey is `id` only; no unique index on `(connection_id, feed_key)` exists — must add a partial unique index for idempotent upsert |
| Entity-link engine runs on `events`, read-time join on `events.metadata->>ns` | CONFIRMED | `utils/entity-link-upsert.ts`, `utils/content-search/entity-link.ts:57-71` |
| `slack_user_id` is a standard read-time namespace | CONFIRMED | `content-search/entity-link.ts:27` |
| Recall matches `cm.connection_id = c.id` from `resolveBoundChannelRows`, which never yields `slackinst-` ids | CONFIRMED → managed read-orphan is real | `tools/search.ts:395`, `:408-413`; `bound-channels.ts:72` |
| `#1630` `createWhen` gate + alias seeding | CONFIRMED | `passesCreateWhen` (`entity-link-upsert.ts:176`); gate on create branch (`:715`); `ensureAliases` (`:203`, `:391`) |

**Corrections to absorb:**
1. **`feeds.kind` does NOT exist on main** (only on #1612 branch). The
   `kind='streaming'` model is owned by **WS-D**. WS-A depends on WS-D landing
   `kind` first, or ships a guarded precursor migration. See §Dependencies.
2. **`slack_user_id` is team-scoped**: `normalizeSlackUserId(teamId, userId)` →
   `T…:U…` (`connector-sdk/src/identity-normalize.ts:85`). `channel_messages`
   stores bare `U…` and has no `team_id`. Attribution needs the team id at
   resolve-time. Biggest new constraint.
3. **The scheduler already excludes streaming feeds for free**: a streaming feed
   with `next_run_at = NULL` is never picked by `check-due-feeds.ts:48`. No
   scheduler change needed.

## Core design fork — RESOLVED: store-only attribution, no events emitted

**Add `author_entity_id` to `channel_messages` and resolve senders via the
entity-link engine's primitives, WITHOUT emitting any `events` row.**

- Attribution is an identity join (`slack_user_id` → `entity_identities` →
  `entities`); it does not require embedding.
- Emitting a person-attributed event per chat message pushes high-volume
  operational chat into the curated `events` store — the embed-congestion path the
  team has hit twice. Rejected.
- `kind ⊥ store` holds: the feed gets `kind='streaming'`; its store pointer
  (`config->>'store' = 'channel_messages'`) is adapter metadata, independent of
  kind. Attribution lives on the store row.
- Read path stays on `channel_messages` (`tools/search.ts:361`
  `fetchConversationSnippets`). Putting attribution on that table means the
  existing recall path light-touches into person attribution.
- Store `author_entity_id` (denormalized FK) + `team_id` so the row is
  self-describing and the FK is recomputable on entity merges. `channel_messages`
  is prunable operational data (not append-only), so a recomputable FK is fine
  here where it would not be for `events`.
- Keep `channel_messages` OUT of the embed pipeline: WS-A adds a separate
  `resolveChannelMessageSender` entry point that calls only the lower-level
  identity primitives (`lookupMatches`, `createEntityWithIdentities`,
  `insertIdentities`, `ensureAliases`, `passesCreateWhen`). No `events` INSERT,
  no embedding enqueue, ever.

## Phase plan (expand → backfill → contract; each phase shippable)

### Phase 0 — Expand schema (additive, no behavior change)

`db/migrations/<ts>_channel_messages_attribution.sql`:
```sql
-- migrate:up
ALTER TABLE public.channel_messages
    ADD COLUMN IF NOT EXISTS author_entity_id bigint,
    ADD COLUMN IF NOT EXISTS team_id text;          -- workspace id (T…); reconstructs slack_user_id key

ALTER TABLE public.channel_messages DROP CONSTRAINT IF EXISTS channel_messages_author_entity_fkey;
ALTER TABLE public.channel_messages
    ADD CONSTRAINT channel_messages_author_entity_fkey
    FOREIGN KEY (author_entity_id) REFERENCES public.entities(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.channel_messages VALIDATE CONSTRAINT channel_messages_author_entity_fkey;

CREATE INDEX IF NOT EXISTS idx_channel_messages_author_entity
    ON public.channel_messages (author_entity_id) WHERE author_entity_id IS NOT NULL;
-- migrate:down
ALTER TABLE public.channel_messages DROP CONSTRAINT IF EXISTS channel_messages_author_entity_fkey;
DROP INDEX IF EXISTS idx_channel_messages_author_entity;
ALTER TABLE public.channel_messages DROP COLUMN IF EXISTS team_id, DROP COLUMN IF EXISTS author_entity_id;
```

`db/migrations/<ts>_feeds_streaming_uniq.sql` (idempotent lazy-upsert support):
```sql
-- migrate:up
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS feeds_streaming_channel_uniq
    ON public.feeds (connection_id, feed_key)
    WHERE kind = 'streaming' AND deleted_at IS NULL;
-- migrate:down
DROP INDEX CONCURRENTLY IF EXISTS feeds_streaming_channel_uniq;
```
> Blocked on WS-D `feeds.kind`. If WS-D hasn't landed it, ship a guarded precursor
> (`ALTER TABLE feeds ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'collected'`
> + check constraint allowing `'streaming'`). Exactly one workstream owns the column.

### Phase 1 — Sender → person resolution (the keystone)

New `resolveChannelMessageSender` in `packages/server/src/utils/entity-link-upsert.ts`,
reusing existing private helpers. Produces NO event item and stamps no
`events.metadata`; returns the entity id and (on create) seeds `entity_identities`
+ `metadata.aliases`.

```ts
const SLACK_PERSON_ENTITY_LINK = {
  entityType: 'person',
  autoCreate: true,
  titlePath: 'author_name',
  createWhen: { path: 'is_bot', equals: false },   // #1630 gate: never mint a person for the bot
  identities: [
    { namespace: IDENTITY.SLACK_USER_ID, /* value = normalizeSlackUserId(teamId, slackUserId) */ primary: true },
    { namespace: IDENTITY.EMAIL /* WS-C, secondary cross-source collapse */ },
  ],
};
```
Rules:
- createWhen skips auto-create when `is_bot=true`, `teamId` is null, or no identity
  normalizes. Matching an existing person is still allowed.
- Build `normalizeSlackUserId(teamId, slackUserId)`; a bare `U…` without team is
  dropped, never stored.
- Because `slack_user_id` is the same namespace the ACL graph uses
  (`authz/slack-channel-graph.ts:86`, `channel-visibility.ts:109`), a sender
  resolves onto the SAME entity a signed-in user owns — attribution and ACL
  converge.

Thread `teamId` into capture (`channel-transcript.ts:19,37,56-67`): add `teamId`
param; after the INSERT, resolve the sender and set `author_entity_id` + `team_id`
(or resolve-first then insert both). Keep best-effort/fire-and-forget — resolution
failure must never block a turn/webhook ack. Bot rows (`is_bot=true`) get NULL
`author_entity_id` (correct — the bot is not a person).

Wire `teamId` at the 4 call sites (all have it in scope): `message-handler-bridge.ts:406`,
`:639`; `chat-response-bridge.ts:411` (derive from platform metadata or leave NULL
for bot rows); `routes/internal/conversations.ts:206` (bot row, optional).

Backfill `db/migrations/<ts>_backfill_channel_message_attribution.sql` (trivial
volume, ~3 rows): derive `team_id` via slug-join to `connections.external_tenant_id`,
then match-only UPDATE `author_entity_id` by joining `entity_identities` on
`namespace='slack_user_id' AND identifier = upper(team_id||':'||author_id)`. No
auto-create in the backfill; newly-seen senders attribute lazily on next message.

### Phase 2 — Channel → feed materialization (lazy, no mass backfill)

New `ensureStreamingChannelFeed` (in `channel-transcript.ts` or a new
`gateway/channels/streaming-feed.ts`), called once per message (idempotent):
1. Resolve `connections.id` from runtime text `connection_id` via the validated
   slug-join (one indexed lookup on `connections_org_slug_unique`).
2. `INSERT INTO feeds (...,feed_key=channel_id, kind='streaming',
   config=jsonb_build_object('store','channel_messages'), virtual=false)
   ON CONFLICT (connection_id, feed_key) WHERE kind='streaming' AND deleted_at IS NULL
   DO NOTHING`. Leave `schedule`/`next_run_at`/`checkpoint` NULL so the scheduler
   never queues it.
3. Lazy: only the first message per `(connection, channel)` writes.

The message-capture choke point IS the membership signal (the bot only captures
from channels it is a member of), so "first message captured" ≈ "bot is in this
channel" — exactly when streaming-feed state is first needed. No separate
`member_joined_channel` handler required.

### Phase 3 — Recall re-key + managed-Slack read-orphan fix (E2E hard gate)

Re-key `fetchConversationSnippets` (`tools/search.ts:361`) to
`(org, connection_id, feed_key=channel_id)` — a **naming/conceptual** lift only.
The physical join columns are unchanged: `connection_id` (runtime text) stays the
join key against `cm.connection_id` AND the key into `authz_source_acl_state`;
`feed_key` is the renamed `channel_id`.

> **HARD ACL WARNING:** do NOT collapse `(org, connection_id, channel_id)` into an
> opaque feed identity or `feeds.id`. `channel-visibility.ts:179-221` gates on
> `connection_id` (`getConnectionEnforcement`) and `(team_id, channel_id)`. Folding
> these causes a silent ACL bypass (a feed.id that doesn't carry connection_id
> can't be enforced) or fail-closed. Keep `organization_id` + `connection_id`
> first-class; the ACL inputs must be byte-identical before/after. Test asserts it.

Managed-Slack read-orphan fix — new UNION branch (C) in `resolveBoundChannelRows`
(`bound-channels.ts:60`), org-scoped, joining `app_installations` (provider='slack',
active) to its bindings, emitting the `slackinst-<external_id>` runtime id as `id`
so `cm.connection_id = c.id` matches:
```sql
UNION
SELECT ('slackinst-' || COALESCE(ai.metadata->>'external_id','')) AS id, 'slack',
       b.channel_id, b.team_id, b.created_at
FROM app_installations ai
JOIN agent_channel_bindings b
  ON b.organization_id = ai.organization_id AND b.platform = 'slack' AND b.team_id = ai.external_tenant_id
WHERE ai.organization_id = ${organizationId} AND ai.provider='slack' AND ai.status='active'
```
> The `slackinst-` id must match what the writers persist as
> `channel_messages.connection_id` AND the id under which `authz_source_acl_state`
> is stamped. Verify against a real managed install. Land once in `bound-channels.ts`
> (its header declares it the single source of truth) — consumed by recall,
> `read_conversation`, notifications, and ACL sync.

### Phase 4 — Contract (out of WS-A core)
Once `connections` is the sole runtime source, collapse the slug-join into a
direct `connections.id` FK on `channel_messages` and drop branch-C's text-id
gymnastics. Not required for WS-A value.

## Multi-replica correctness
- `resolveChannelMessageSender`: all state in PG; `entity_identities`
  `UNIQUE(org, namespace, identifier)` + `ON CONFLICT DO NOTHING`; existing
  lost-create-race handling (`entity-link-upsert.ts:736-764`). No new in-memory
  cross-pod state.
- `ensureStreamingChannelFeed`: idempotent upsert on `feeds_streaming_channel_uniq`.
- Exclusive transports (Telegram polling): untouched; WS-A adds no transport.
- Streaming feeds carry NULL `checkpoint`/`next_run_at`; the runtime that writes
  them is the existing message-handler path (webhook idempotency + `channel_messages`
  dedup constraint).

## Tests (red→green integration; seed connections + channel_messages + feeds)
1. Attribution, BYO — known `slack_user_id=T1:U1` → `author_entity_id` resolves.
2. Auto-create + createWhen — unknown non-bot sender mints a person; `is_bot=true`
   mints nothing (NULL).
3. No `team_id` → no orphan, no malformed `slack_user_id`.
4. Cross-source collapse — pre-seeded `$member` with `slack_user_id=T1:U1` →
   attribution lands on the existing member, no duplicate.
5. Feed materialization — first capture creates one streaming feed; second is
   idempotent; `config->>'store'='channel_messages'`, `next_run_at` NULL.
6. Feed-keyed recall — `fetchConversationSnippets` returns the message + attributed
   person, joining via `(org, connection_id, feed_key=channel_id)`.
7. Managed-install recall (orphan fix) — `slackinst-` row becomes recallable.
8. ACL isolation — enforced connection + non-member → nothing; member → rows.
   Assert the re-key did not change ACL inputs. **Must not ship without this test.**

E2E hard gate for the bug-fix portion (Phase 3): managed Slack install → user
posts → recall attributes the right person and respects ACL.

## Files to touch
New: the 3–4 migrations above; `resolveChannelMessageSender` +
`SLACK_PERSON_ENTITY_LINK` in `utils/entity-link-upsert.ts`.
Modify: `gateway/connections/channel-transcript.ts:19,37,56-67,71`;
`message-handler-bridge.ts:406,639`; `chat-response-bridge.ts:411`;
`routes/internal/conversations.ts:206`; `gateway/channels/bound-channels.ts:60-115`
(UNION branch C); `tools/search.ts:361-431` (recall re-key, ACL inputs unchanged).

## Dependencies
- **WS-C (identity)** — soft/additive: provides sender email; the rule's `email`
  secondary degrades gracefully (slack_user_id-only) until WS-C lands.
- **WS-D (feed model)** — hard, on `feeds.kind`: sequence WS-D's `kind` column
  before WS-A Phase 0, or WS-A ships the guarded precursor. WS-A hands WS-D the
  materialization choke point + the `kind ⊥ store` convention.
- **Managed-orphan fix** — shared infra in `bound-channels.ts`; land once.

## Risks (ranked)
1. **(HIGH) ACL silent-bypass on recall re-key.** Keep org+connection_id
   first-class; test #8 asserts byte-identical ACL inputs. Must not ship without it.
2. **(HIGH) Managed-install runtime-id format mismatch.** Branch C must emit the
   exact `slackinst-…` string the writers persist and that keys `authz_source_acl_state`.
   Verify against a real managed install before E2E.
3. **(MED) `feeds.kind` ownership race with WS-D.** Explicit sequencing; guarded
   `IF NOT EXISTS` precursor.
4. **(MED) `team_id` at all 4 writers.** Inbound + backfill have it; bot rows don't
   need attribution.
5. **(MED) Denormalized `author_entity_id` staleness on entity merge.**
   Recomputable from retained `team_id`+`author_id`; add a follow-up re-resolve tick.
6. **(LOW) Auto-create volume / hot-path latency.** createWhen blocks bots;
   team-scoped key prevents cross-org bleed; keep resolution fire-and-forget.
