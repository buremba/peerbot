# Chat-feeds consolidation program

Make chat (Slack first) a first-class **data source**: channels become streaming
feeds, senders get attributed to person entities, the bot can be driven into
channels by an agent, and identities bridge across sources (a GitHub committer
and a Slack sender can be the same person). The feed model is the *home* for all
of this; the capabilities below are what actually unlock it.

This directory holds the build plan, split into four workstreams (A–D), each with
its own doc. Read this README first — it carries the cross-cutting decisions and
the corrections that each workstream depends on.

## Why now / the prod reality

This program targets a subsystem that is **near-empty in production today**:

- `channel_messages` has **3 rows** in prod (read-only count, 2026-06-30).
- **0** managed-Slack (`slackinst-`) transcripts exist (so the managed read-orphan
  bug — real in code — has **zero** current blast radius).
- Listening to all public channels: **absent** (no `conversations.join`/`list`).
- Slack messages as person events: **absent** (Slack connector is OIDC-login-only,
  no message ingestion, no `slack_user_id` entity links).
- Cross-source identity (GitHub committer ↔ Slack sender): **does not work** —
  no shared identifier bridges the two, and Slack senders aren't entities at all.

So the consolidation is **plumbing ahead of demand**. The high-value work is the
three unbuilt capabilities (ingestion, channel ops, identity bridge); the feed
model is where they should live. Prioritize accordingly (see §Sequencing).

## Validated facts (de-risking already done)

- **Channel→connection reconciliation works on real data.** Mapping
  `channel_messages.connection_id` (text) → `connections.id` (bigint) via
  `connections.slug = CASE WHEN connection_id LIKE 'slackinst-%' THEN connection_id
  ELSE 'agentconn-'||connection_id END` (org-scoped) returned **0 orphans** on prod.
  A `text→bigint` column migration is **not** needed — the deterministic slug-join
  works on the existing text column.
- **A channel is already feed-shaped.** `events`↔`feeds` join on
  `(connection_id, feed_key)`; for a channel, `feed_key = channel_id`. The natural
  key exists; no per-row `feed_id` denormalization is required for reads.
- **The two scariest ACL edge cases hold** (proven on a scratch DB): cross-org
  isolation via a shared preview connection, and duplicate channel bindings across
  two connections — both stay correct **as long as `organization_id` +
  `connection_id` remain first-class in the key** (never fold them into a single
  "feed identity").

## The four workstreams

| WS | Title | Unlocks | Doc |
|----|-------|---------|-----|
| **A** | Slack message ingestion as a person-attributed streaming feed | data + attribution + the feed model, together. **Keystone.** | [ws-a-slack-ingestion.md](./ws-a-slack-ingestion.md) |
| **B** | Slack channel operations (list/join) as connection actions + auto-join driver | builder-agent "add bot to all public channels" | [ws-b-channel-operations.md](./ws-b-channel-operations.md) |
| **C** | Cross-source identity bridges | GitHub committer ↔ Slack sender = same person | [ws-c-identity-bridges.md](./ws-c-identity-bridges.md) |
| **D** | Feed model foundation + read registry + Channels UI/API fold | the architectural home; the one standalone correctness win (ACL-gated reader registry) | [ws-d-feed-model-fold.md](./ws-d-feed-model-fold.md) |

## Cross-cutting corrections (each WS depends on these)

The planning surfaced facts that contradict the naive framing — implementers must
honor them:

1. **`feeds.kind` does not exist on `main`.** It lives only on the abandoned PR
   #1612 branch (`feat/feed-consolidation`). WS-D owns landing `kind`; WS-A's
   streaming-feed work depends on it. Exactly one workstream introduces the column —
   sequence WS-D's `kind` migration before WS-A's streaming materialization (or
   WS-A ships a guarded `IF NOT EXISTS` precursor). Close #1612 by folding its
   `kind` migration into WS-D.

2. **`slack_user_id` is team-scoped.** It is stored as
   `normalizeSlackUserId(teamId, userId)` = `T…:U…` upper-cased — not the bare
   `U…`. `channel_messages` has **no `team_id`**, and the sign-in OIDC `sub` is the
   bare `U…`. So both WS-A (attribution) and WS-C (the cheap sign-in win) must
   reconstruct the `T:U` key from a `team_id` they currently don't have at hand.
   WS-A adds `channel_messages.team_id`; WS-C reads the Slack `team_id` claim from
   userinfo.

3. **Slack has no `connections` row.** Install writes only an `app_installations`
   row (`slackinst-<uuid>`); per-agent `/lobu link` writes `agent_connections`.
   The operations framework (`manage_operations`) is `connections`-native, so WS-B
   must first create one `connections` row per (org, workspace) before any Slack
   action is callable. And neither credential resolver reaches the bot token today
   — WS-B resolves it natively via the proven `slack-acl-sync` token path.

4. **Email alone cannot merge two already-primaried entities.** A GitHub `person`
   is primaried on `github_user_id`; a Slack `person` on `slack_user_id`. The
   resolution engine, when a primary is present, ignores secondary identities
   (email) for resolution and only *accretes* them — and refuses ambiguous merges.
   So the third-party GitHub↔Slack bridge does **not** form by lazy accretion; it
   needs an explicit, confidence-gated **reconciliation/merge job** (WS-C #5). The
   authenticated-user bridge (one `$member` hub) does work via accretion.

5. **Keep `events` and `channel_messages` as two stores.** `channel_messages` is
   the cheap, prunable, un-embedded transcript lane that exists specifically to
   keep high-volume chat out of the embed pipeline (the congestion-collapse path).
   `kind ⊥ store`: a feed's store pointer is adapter metadata, independent of its
   kind. Attribution lives on `channel_messages` rows (store-only), **not** by
   emitting embedded events.

6. **The channels surface is smaller than billed.** The REST island is **6 routes**
   in one file (`channels.ts`), not ~16; the redundant chat-connection CRUD is
   already MCP-tool-based (it does not exist as REST). So WS-D's fold is a 6-route
   re-home + the owletto channel component tree, not a sweeping API deletion.

## Dependency graph & sequencing

```
Ship first (independent, low-risk, standalone value):
  WS-D Part 2   Reader registry + ACL gate as a REQUIRED typed arg   (the one correctness win)
  WS-D Part 1a  Land feeds.kind migration + close #1612
  WS-C #1       Persist slack_user_id on $member at sign-in          (cheap win, immediate ACL benefit)
  WS-C #3 G1/G2 Identity-email guardrails                            (must precede any email identity write)

Keystone:
  WS-A          Slack ingestion as person-attributed streaming feed  (needs feeds.kind from WS-D 1a)
                └─ folds in the managed-Slack read-orphan fix

Parallel / after:
  WS-B          Channel operations + auto-join driver                (independent; integrates with WS-A binding/capture)
  WS-C #2/#3/#5 Slack email capture, GitHub email identity, merge job (rides on WS-A; merge job delivers the 3rd-party bridge)
  WS-D Part 3   Channels UI/API fold                                 (needs WS-A streaming-feed model)

Explicitly deferred (no caller demand at 3 prod rows):
  WS-D Phase B  virtual→kind reader flip + drop the virtual column
  WS-D          full FeedReader<S,L> matrix / ResultFor<L> unification
```

**Recommended first PRs** (each independently valuable, none requires the others):
WS-D Part 2 (ACL-gated reader registry), WS-C #1 (sign-in slack_user_id), and
WS-D Part 1a (land `kind` + close #1612). The keystone (WS-A) follows once `kind`
is in.

## Invariants no workstream may break

- **Multi-replica:** all streaming runtime/checkpoint state is Postgres-mediated;
  no in-memory cross-pod state; exclusive transports (Telegram polling) stay
  single-claimant via the `connection_claims` lease. New scheduled work (auto-join,
  reconcile) is single-claimant or idempotent.
- **ACL:** `organization_id` + `connection_id` stay first-class in every recall
  key; never collapse them into a single feed identity (silent bypass / fail-closed).
- **Append-only `events`:** never route `channel_messages` into the embed pipeline.
- **Migrations:** squawk-safe (additive nullable/constant-default; `NOT VALID` +
  `VALIDATE`; `CONCURRENTLY` indexes in their own migration).
- **Bug-fix portions** (managed-orphan fix, channel fold) carry a red→green E2E
  reproducer per the repo's E2E hard gate.
