# WS-D — Feed model foundation + read registry + Channels UI/API fold

> Status: plan, ready for an implementer. Parts 1a + 2 ship standalone and first;
> Part 3 needs WS-A. See [README](./README.md) for cross-cutting decisions.

## Goal
Make `feeds` the home for all data sources (collected/virtual/streaming),
generalize the read path behind one registry with the ACL gate as a **required**
input, fold the bespoke Slack "channels" UI/API into the unified feeds/connections
surface, and resolve PR #1612. Lowest urgency (3 prod rows) — the architectural
home, not the unlock.

## Grounding corrections (verified against `main`)

1. **The "RecallSource registry" already has the ACL gate — but as convention, not
   contract.** `tools/search.ts:460-501` defines `RecallSource`/`RECALL_SOURCES`/
   `gatherRecall`; the gate is enforced inside each source
   (`fetchConversationSnippets` → `filterChannelsForRequester` `:374`;
   `knowledgeSource` passes `visibility_scope` `:302`). A new source can compile
   without the gate. **Making it a required typed argument is the standalone win.**
2. **The channel REST island is 6 routes in one file, not ~16.**
   `gateway/routes/public/channels.ts` (493 LOC), mounted at
   `/api/v1/agents/:agentId/channels` (`gateway/cli/gateway.ts:668`). Jobs (B)
   routing/bindings + (C) audience/ACL only.
3. **Job (A) "redundant chat-connection CRUD REST" does not exist on `main`.**
   `agent-routes.ts` has no channel/platform CRUD handlers; chat-connection CRUD is
   already MCP-tool-based (`manage_connections` via `restToolProxy`,
   `index.ts:1180-1198`); lifecycle is row-driven (`chat-instance-manager.ts`).
   `/api/agents/platforms` (`index.ts:1319`) is a read-only schema endpoint. **So
   the (A) work is mostly already done** — the fold is jobs (B)+(C) + the owletto tree.

## Part 0 — Fate of PR #1612: **fold its `kind` migration into WS-D and close #1612**
- `db/migrations/20260630000000_feeds_kind.sql` is well-formed and squawk-safe
  (additive `text NOT NULL DEFAULT 'collected'`, backfill, `CHECK NOT VALID` +
  `VALIDATE`). Take it verbatim.
- The branch already materializes a real consumer (`lib/streaming-feeds.ts`
  `ensureWebhookStreamingFeed`, `kind='streaming', virtual=false`, lifecycle NULL)
  — so the migration is not inert there; its consumer is *webhooks*, not WS-A
  channels.
- The check-drift CI failure is an owletto-pointer drift, not a schema problem.

Action: cherry-pick the substantive commits (`c65dc2a4e` kind enum,
`fbeba9ba6` webhook→streaming, `21d2db712` attribution, `d91b8feac` docs) onto a
fresh WS-D branch off `main`, drop the owletto-pointer commit, re-bump owletto
separately. Close #1612 pointing at the WS-D PR. **Coordinate with WS-A** on whether
webhook-as-streaming-feed lands here or in WS-A (it's the second `kind='streaming'`
consumer either way).

## Part 1 — `feeds.kind` with a consumer + two-phase `virtual`→`kind` invariant
### 1a. Land the migration (verbatim from #1612). Trivial at 3-row scale.
### 1b. Two-phase invariant (the correctness contract)
The scheduler gate is one line: `scheduled/check-due-feeds.ts:47`
(`AND f.virtual IS NOT TRUE`). Until it moves to `kind`, every non-collected feed
writer MUST keep `virtual = (kind = 'virtual')` AND leave
`schedule`/`next_run_at`/`checkpoint` NULL.
- **Phase A (this WS):** add `kind`; writers set both columns.
- **Phase B (later, NOT this WS):** flip readers — `check-due-feeds.ts:47` →
  `AND f.kind = 'collected'`; `connector-pushdown.ts:203` → `if (feed.kind !== 'virtual')`;
  then drop the `virtual` column. Keep out of WS-D to avoid a scheduler/writer
  disagreement window.
### 1c. `manage_feeds` kind-aware create
`manage_feeds.ts:350-361` inserts without `kind` (relies on default — correct for
collected). Add an internal kind-aware insert helper so streaming/virtual creators
don't re-implement the "virtual + lifecycle-NULL" rule. Defer a public `kind` arg
until a UI/tool caller exists.

## Part 2 — Reader registry: `RecallSource[]` → readers with the ACL gate as a required arg
**The standalone-valuable slice. Do it first, independent of WS-A.**

Current: `RecallSource { kind; recall(ctx) }` — gate enforced inside `recall`,
invisible to the type. Live-pushdown lenses (`connector-pushdown.ts` `runConnectorQuery`,
`readVirtualFeed`) already take a gate; metric lens in `query_metric.ts` + `run-metric.ts`.

Target (minimal — NOT the full `FeedReader<S,L>` matrix):
```ts
interface FeedReader<Ctx, Out> {
  readonly kind: string;
  read(gate: AuthzScope, ctx: Ctx): Promise<Out>;   // gate required + distinct, not buried in Ctx
}
```
1. Reuse the existing `AuthzScope` (`authz/scope.ts`) that `readVirtualFeed` takes.
2. Refold the two `search.ts` sources onto this signature; lift
   `organizationId`/`userId`/`channelAgentId` out of `RecallContext` into `gate`.
   `gatherRecall` stays (it already isolates failures); thread `gate` through.
3. Register `readVirtualFeed` + `runConnectorQuery` under the same interface
   (adapters, ~30 LOC each, no behavior change).
4. **Correctness win:** a compile-time guarantee that no reader registers without
   consuming the gate. Unit test asserts every registry entry calls its visibility
   compiler (registry is already injectable: `gatherRecall(ctx, sources)`).

Do NOT unify result shapes (`ResultFor<L>`) — different lenses return different
shapes, no caller demands it. Stop at the gate contract.

## Part 3 — Channels UI/API fold (mostly deletion + re-home; needs WS-A)
### 3a. API — `channels.ts` (6 routes)
| Route | Job | Disposition |
|---|---|---|
| `GET /` list bindings | B | re-home → `manage_connections` action `list_channel_bindings`; delete REST |
| `POST /` create binding | B | re-home → `bind_channel`; delete REST |
| `DELETE /:platform/:channelId` | B | re-home → `unbind_channel`; delete REST |
| `GET /audience` | C | re-home → `get_channel_audience` (wraps `getChannelAudiences`); delete REST |
| `GET /installations` | A | delete — redundant with `manage_connections` list; migrate the one caller |
| `POST /installations/:externalId/connect-dm` | A+B | re-home → `connect_channel_dm` (preserve token resolution + `canonicalSlackChannelId`, `channels.ts:389-489`); delete REST |

Then delete `createChannelBindingRoutes` + its mount (`gateway.ts:660-672`).
`ChannelBindingService` (`binding-service.ts`) **stays** — it's the store consumed
by the tool actions and `resolveBoundChannelRows` (which `search.ts:369` depends on).
Only the HTTP shell dies. Bindings are real and NOT modeled as feeds.

### 3b. UI — retire the bespoke channel tree (owletto)
Delete in `components/agents/`: `agent-channels-route/index/detail/create.tsx`,
`agent-channel-platform-detail.tsx`, `agent-channel-bindings.tsx`,
`channel-catalog-picker.tsx`, `channel-audience-row.tsx`, `channel-badges.tsx`,
`channel-mcp-actions.tsx`; routes `.../channels/create.tsx`, `.../$channelKey.tsx`;
the Channels tab wiring; hooks `useAgentPlatforms`/`useAgentChannelBindings`.
Render channels through the existing connector/connection family + the `/connectors`
surface (a bound channel = a row/facet under its connection).

> **Flag — unverified:** the brief's "shared `connections-tab/*` (~8400 LOC, reused
> 3×)" does NOT exist as a `connections-tab` dir on `main`; the analogous family is
> `components/connectors/` (smaller). The owletto submodule may differ. **Map the
> actual current Feeds/Connections render path in the owletto submodule before
> deleting any UI.** Design-validated, path-unconfirmed.

### 3c. Needs WS-A
3a/3b assume channels render as `kind='streaming'` feed rows — depends on WS-A.
Sequence Part 3 after WS-A; bundle 3a+3b to avoid a dead intermediate state.

## Part 4 — Two stores stay two stores
No work, but encode the guardrail: `events` and `channel_messages` stay separate
(embed-congestion + "Capture ≠ knowledge"). A feed's `store` is adapter metadata,
orthogonal to `kind`. Add a one-line assertion/comment at the streaming-feed
creation site that streaming feeds targeting `channel_messages` must never enter the
embed pipeline. Preserve the `search.ts` `ConversationSnippet` split when refolding
under the registry. Do NOT add a `store` column or merge tables.

## Sequencing
```
Ship first (independent):  Part 2 (reader registry + ACL-required-arg)  ∥  Part 1a (land kind, close #1612)
Alongside / after WS-A:    Part 1b/1c (kind-aware create)  →  Part 3a (API re-home)  →  Part 3b (retire UI tree)
Deferred (NOT this WS):    Phase B (virtual→kind flip + drop column);  full FeedReader<S,L> matrix / ResultFor<L>
```

## Migrations
`20260630000000_feeds_kind.sql` verbatim from #1612 (additive, lock-safe). No other
DDL in WS-D. The `virtual` drop is Phase B (a separate later contract migration).

## Tests
- **Part 2 (the one that matters):** unit test that the registry can't construct a
  reader bypassing the gate; regression that `gatherRecall` with a non-member
  `userId` returns no `conversation_messages`.
- **Part 1:** migration up/down idempotency; `streaming-feeds.ts` invariant test
  (created feed has `next_run_at IS NULL` so the scheduler skips it).
- **Part 3a:** parity tests that each new tool action matches the deleted REST
  route, esp. `connect_channel_dm` (canonical Slack id + token resolution).
- E2E gate per AGENTS.md before merge for the channel fold (behavior-changing UI/API).

## Risks
1. **(High severity) Silent ACL bypass during the read refold (Part 2)** — gate as a
   required typed param + registry test.
2. **Two-phase invariant violation** — a writer sets `kind` without keeping
   `virtual`/lifecycle consistent → scheduler queues a streaming feed. Single
   kind-aware insert helper (1c); never hand-roll the insert.
3. **owletto UI path unverified (Part 3b)** — map the real render path before
   deleting; submodule-pointer discipline (push owletto branch before bumping).
4. **#1612 / WS-A ownership overlap** on the first streaming consumer — coordinate
   before cherry-picking `fbeba9ba6`/`21d2db712`.

## Honest prioritization (3 prod rows)
- **Now, standalone:** Part 2 (reader registry + ACL-required-arg) and Part 1a
  (land `kind`, close #1612) — the home + the one correctness win; low-risk folds.
- **With WS-A:** Part 1b/1c, Part 3 — no value before WS-A exists.
- **Defer indefinitely:** full `FeedReader<S,L>` matrix / `ResultFor<L>` — no caller
  demand; speculative generality the design doc itself warns against.

## Files to touch
`tools/search.ts` (registry → required gate; Part 2); `lib/connector-pushdown.ts`
(fold live readers; Phase-B flip site `:203`); `db/migrations/20260630000000_feeds_kind.sql`
(from #1612; Part 1a); `gateway/routes/public/channels.ts` + its mount
(`gateway/cli/gateway.ts:660-672`) (Part 3a); `scheduled/check-due-feeds.ts:47`
(two-phase gate; Part 1b). Supporting: `lib/streaming-feeds.ts`,
`tools/admin/manage_feeds.ts` (kind-aware create), `authz/scope.ts` +
`connection-visibility.ts` + `channel-visibility.ts` (the gate), and the owletto
`components/agents/*channel*` tree + `components/connectors/` family (Part 3b —
path to confirm in submodule).
