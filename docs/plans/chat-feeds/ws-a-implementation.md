# WS-A (keystone) — implementation plan, verified against current `main` (73e8f387f)

> **Status (2026-07-15):** **Shipped** — `channel_messages` ingestion + FeedReader recall registry and Slack sender attribution landed.

> **Architecture update (2026-07-17):** channel routing now projects from
> canonical Event Behaviors through `behavior_channel_subscriptions`; the
> `agent_channel_bindings` references below describe the historical schema this
> shipped against, not a current write path.

> Branch: `feat/ws-a-slack-ingestion`. Goal: inbound Slack messages become
> (1) sender-attributed to a person/$member entity and (2) recallable for managed
> installs. Store-only attribution; NO events emitted; NEVER embed.
> Scope EXCLUDES `feeds.kind`, channel-as-feed materialization, and the recall
> re-key — those belong to `feat/feed-consolidation` (WS-D).

## What changed under us since the plan was written (READ FIRST)

1. **#1623 (connections single-table cutover) already fixed the read-orphan.**
   `resolveBoundChannelRows` (`gateway/channels/bound-channels.ts:46-145`) now reads
   the unified `connections` table. Branch (A) resolves MANAGED Slack installs via
   the `b.connection_id = ac.id` link and emits `ac.slug` verbatim — for managed
   that slug is `slackinst-<uuid>`, which equals `channel_messages.connection_id`
   (writer: `message-handler-bridge.ts:408` `connectionId: connection.id`). The
   slug pass-through is confirmed in the test fixture
   (`__tests__/setup/test-fixtures.ts:223` — `slackinst-` ids stay verbatim, others
   get `agentconn-`). **So Item 2's UNION-branch-C is NO LONGER NEEDED.** The plan's
   premise ("`resolveBoundChannelRows` never yields `slackinst-` ids") is stale.
   → Item 2 becomes: **prove it with a red/green test, don't re-implement.** Caveat
   to verify (see Item 2): branch (A) only resolves a managed install when its
   binding is LINKED (`agent_channel_bindings.connection_id` populated); managed
   `agent_id` is NULL so the tuple fallback can't match. If unlinked managed
   bindings exist, they stay orphaned — that's a binding-link gap, not a recall gap.

2. **Session B part 2 (#1645) merged** — recall is now a `FeedReader` registry
   (`lib/feed-reader.ts`, `RECALL_SOURCES` in `tools/search.ts:501`). The ACL gate
   (`AuthzScope`) is a required typed arg. `fetchConversationSnippets`
   (`search.ts:361`) still owns the `channel_messages` SELECT and keeps
   `gate.organizationId` + per-`connection_id` `pairFilter` first-class. Item 3 is a
   clean, minimal add against this shape — no rebase conflict.

3. **#1646 (stamp `slack_user_id` on Slack sign-in) merged** — a signed-in human's
   `$member` entity now carries the team-scoped `slack_user_id` (`T:U`). This makes
   the cross-source collapse LIVE and forces a resolver design decision (Item 1).

## Item 1 — sender attribution (the real keystone work) — TODO

### 1a. Migration `db/migrations/<ts>_channel_messages_attribution.sql`
`channel_messages` has neither column today (confirmed). `entities_pkey PRIMARY KEY
(id)` exists (`baseline.sql:2797`), so the FK is valid. Squawk-safe (additive
nullable + NOT VALID/VALIDATE):
```sql
-- migrate:up
ALTER TABLE public.channel_messages
  ADD COLUMN IF NOT EXISTS author_entity_id bigint,
  ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE public.channel_messages DROP CONSTRAINT IF EXISTS channel_messages_author_entity_fkey;
ALTER TABLE public.channel_messages
  ADD CONSTRAINT channel_messages_author_entity_fkey
  FOREIGN KEY (author_entity_id) REFERENCES public.entities(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.channel_messages VALIDATE CONSTRAINT channel_messages_author_entity_fkey;
-- migrate:down
ALTER TABLE public.channel_messages DROP CONSTRAINT IF EXISTS channel_messages_author_entity_fkey;
ALTER TABLE public.channel_messages DROP COLUMN IF EXISTS team_id, DROP COLUMN IF EXISTS author_entity_id;
```
The partial index on `author_entity_id` must be a SEPARATE migration with
`CREATE INDEX CONCURRENTLY` (squawk: index alone in its own file):
```sql
-- migrate:up
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_channel_messages_author_entity
  ON public.channel_messages (author_entity_id) WHERE author_entity_id IS NOT NULL;
-- migrate:down
DROP INDEX CONCURRENTLY IF EXISTS idx_channel_messages_author_entity;
```
Run the changed migrations through squawk locally (CI `migrations` job gates on it
and `make review`/pi do NOT — see `reference_squawk_migration_gate`).

### 1b. `resolveChannelMessageSender` in `utils/entity-link-upsert.ts`
Add an EXPORTED function in this file (the 5 helpers are module-private:
`lookupMatches:260`, `createEntityWithIdentities:303`, `insertIdentities:404`,
`ensureAliases:203`, `passesCreateWhen:176`). It produces NO event item, stamps no
`events.metadata`, never calls `applyEntityLinks`/embedding — mirror the
hit/miss core of `resolveLinksByKind` (~625-792) using only the primitives.

Identity: `IDENTITY.SLACK_USER_ID` (`@lobu/connector-sdk`, value `'slack_user_id'`),
value = `normalizeSlackUserId(teamId, authorId)` → `T…:U…` uppercased
(`connector-sdk/src/identity-normalize.ts:85`). Optional `IDENTITY.EMAIL` secondary
(degrades to slack_user_id-only when absent). Drop a bare `U…` with no team —
never store a malformed key.

**KEY DECISION — entityType / `$member` collapse (driven by #1646).**
`lookupMatches` is scoped to ONE entityType (`search.ts`-style `AND et.slug =
${entityType}`, line 290). A signed-in human is a `$member` carrying
`slack_user_id=T:U` (from #1646). To satisfy cross-source collapse (test #4) and
make attribution + ACL converge on ONE entity, resolve in this order:
1. `lookupMatches(entityType: '$member', identities: [slack_user_id])` → if hit,
   return that entity id (the signed-in human). No create.
2. else `lookupMatches(entityType: 'person', …)` → if hit, return it.
3. else, gated by `passesCreateWhen({path:'is_bot', equals:false})` AND `teamId`
   present AND identity normalizes: `createEntityWithIdentities(entityType:
   'person', …)` + `insertIdentities` + `ensureAliases`. Return the new id.
Never auto-create a `$member` here (membership provisioning owns that). Bots and
team-less rows resolve to NULL.

Signature sketch: `resolveChannelMessageSender(sql, { orgId, teamId, authorId,
authorName, isBot, email? }): Promise<number | null>`.

### 1c. Thread `teamId` through capture — `gateway/connections/channel-transcript.ts`
- Add `teamId?: string | null` to `PersistChannelMessageParams` (interface ~19-35).
- In `persistChannelMessage` (~37-68): before/after the INSERT, when
  `!isBot && teamId && authorId`, call `resolveChannelMessageSender` (best-effort,
  wrapped so a failure never blocks the turn/ack), then write `team_id` +
  `author_entity_id` into the INSERT column list/VALUES (~57-65). Keep the
  `ON CONFLICT … DO NOTHING` dedup. `captureChannelMessage` wrapper (~71-78)
  unchanged (already fire-and-forget).

### 1d. Wire `teamId` at the writers
- `message-handler-bridge.ts:408` and `:641` — inbound, non-bot; `teamId` is in
  scope (used at `:383`,`:391`). **These two drive attribution.**
- `chat-response-bridge.ts:411` — bot's own reply (`isBot:true`); pass `teamId`
  via `readPlatformMetadata(...).teamId` for the new column, attribution N/A.
- `gateway/routes/internal/conversations.ts:206` — bot post (`isBot:true`); `teamId`
  not in scope → pass null. (NOTE: actual path is `gateway/routes/internal/…`, the
  original plan's `routes/internal/…` is wrong.)

## Item 2 — managed read-orphan: PROVE, don't re-implement — TODO (E2E hard gate)
Branch (A) already resolves managed installs (see "What changed" #1). Deliverable:
a red→green integration test (mirror `tools/__tests__/search-channel-recall.test.ts`
+ the managed-slug fixture `insertChatConnectionRow({ id: 'slackinst-…',
credentialMode:'managed' })`) that seeds a managed connection + a LINKED
`agent_channel_bindings` row (`connection_id` set) + a `channel_messages` row with
`connection_id='slackinst-…'`, then asserts `search_memory` recall returns it and
attributes the right person, respecting ACL. If it passes on current main with no
prod change, document "already fixed by #1623, regression test added." If it FAILS
(e.g. the binding-link path has a gap for managed installs), THAT is the real fix —
investigate the binding `connection_id` linkage, not a UNION-branch-C re-add.

## Item 3 — surface `author_entity_id` in recall — TODO (minimal)
`tools/search.ts`, all additive, ACL inputs untouched:
- `ConversationSnippet` interface (~227): add `author_entity_id: number | null`.
- `fetchConversationSnippets` SELECT (~397 `SELECT cm.platform, …`): add
  `cm.author_entity_id`; add it to the row-cast type and the `.map(...)` result.
- Do NOT touch the WHERE fence (`gate.organizationId` + `pairFilter` on
  `connection_id`) or the `resolveBoundChannelRows`/`filterChannelsForRequester`
  ACL path. A test asserts ACL inputs are byte-identical before/after.

## Tests (red→green; from `packages/server`, Node ≥22 or ≥26, reachable DATABASE_URL)
Mirror `__tests__/integration/conversations/transcript.test.ts` (transcript
persistence) and `__tests__/integration/authz/slack-channel-visibility.test.ts`
(seed entity_identities/bindings/channel_messages + authz_source_acl_state aging).
1. Known `slack_user_id=T1:U1` → `author_entity_id` resolves.
2. Unknown non-bot → new `person` minted; `is_bot=true` → NULL.
3. No `team_id` → no write, no malformed key.
4. **Cross-source collapse** — pre-seeded `$member` with `slack_user_id=T1:U1` →
   attribution lands on that `$member`, no duplicate person. (Validates the Item-1b
   `$member`-first lookup against the #1646 model.)
5. **Managed-install recall (Item 2 E2E gate)** — `slackinst-` connection + linked
   binding + `channel_messages` row → recall returns it, attributed, ACL-respected.
6. **ACL isolation / inputs unchanged** — enforced connection + non-member → nothing;
   member → rows; assert Item 3 didn't change ACL inputs.
Run: `cd packages/server && npx vitest run <file>`; full gate `make review`.

## Multi-replica / constraints
- All state PG-mediated: `entity_identities UNIQUE(org,namespace,identifier)` +
  `ON CONFLICT DO NOTHING` + existing lost-create-race handling
  (`entity-link-upsert.ts` ~736-764). No in-memory cross-pod state added.
- Attribution is best-effort/fire-and-forget; resolution failure never blocks a
  turn or webhook ack.
- `channel_messages` stays OUT of the embed pipeline (store-only). `events` untouched.
- No transport changes; Telegram polling single-claimant lease untouched.

## Files
New: 2 migrations (attribution columns; CONCURRENTLY index);
`resolveChannelMessageSender` in `utils/entity-link-upsert.ts`; tests above.
Modify: `gateway/connections/channel-transcript.ts`; `message-handler-bridge.ts`
(:408,:641); `chat-response-bridge.ts` (:411); `gateway/routes/internal/conversations.ts`
(:206); `tools/search.ts` (Item 3 only). **No change to `bound-channels.ts`** unless
test #5 exposes a real binding-link gap.

## Prod reality check (verified 2026-06-30 via Lobu MCP query_sql across all member orgs)
- **Zero managed (`slackinst-`) installs in prod. Zero `app_installations` rows. Zero
  `channel_messages` anywhere.** The only Slack connection in any reachable org is ONE
  BYO connection in `lobu-crm` (`agentconn-cfa916c95eb64939`), and it has no bindings
  and no messages. So the managed read-orphan is **theoretical for today's data** —
  the #1623 branch-(A) plumbing is ahead of demand.
- Consequence for test #5: there is NO real managed dataset to measure linkage on, so
  the E2E reproducer must **synthesize** the managed scenario (fixtures already support
  it: `insertChatConnectionRow({ id: 'slackinst-…', credentialMode:'managed' })` +
  a binding row with `connection_id` set to that connection's id + a `channel_messages`
  row with `connection_id='slackinst-…'`).
- The verification question therefore shifts from "is the unify BACKFILL reliable" (no
  rows to back-fill) to "does the managed-install CREATE path link the binding's
  `connection_id`". The implementer should read the Slack OAuth install handler
  (`gateway/routes/public/slack.ts` + `lobu/stores/slack-installations.ts`) and confirm
  a managed install writes `agent_channel_bindings.connection_id` at bind time (managed
  `agent_id` is NULL, so the tuple fallback in branch (A) can NEVER match — recall for
  managed installs depends entirely on the binding being linked). If the install path
  does NOT set `connection_id`, THAT is the real orphan and the actual fix; surface it
  in the PR. If it does, test #5 is a green regression test and Item 2 is closed.
