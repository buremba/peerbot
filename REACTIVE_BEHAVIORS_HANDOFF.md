# Reactive Behaviors consolidation handoff

## Status

The reactive Behavior consolidation is implemented end to end in the worktree below. The old watcher-management tool and chat-channel-binding state path are removed; connector events, schedules, and explicit/manual starts now converge on one persisted Behavior definition and one management surface.

- Root worktree: `/Users/burakemre/Code/lobu-ai/lobu/.claude/worktrees/reactive-subscriptions-spike`
- Root branch: `feat/reactive-subscriptions-spike`
- Owletto submodule: `packages/owletto`
- Owletto branch: `feat/reactive-subscriptions-spike`
- Test UI: `http://127.0.0.1:8803/local-install/agents/owletto-default/behaviors`
- Publication status: local only; neither repository has been pushed and no PR has been opened.

This file is intentionally detailed so a compacted session can continue without reconstructing the design from the diff.

## Final product model

A Behavior contains the reusable instructions, sources, extraction/reaction settings, and execution configuration. Its `triggers` array decides when it starts:

- `event`: a connector-normalized event from one connection, optionally filtered by normalized fields.
- `schedule`: cron plus timezone, projected onto the existing indexed schedule columns.
- no triggers: manual/API/CLI/MCP start only.

This is not a second event system. Provider data still lands in its canonical durable store first:

- connector content in append-only `events`;
- chat messages in `channel_messages`;
- Behavior delivery/dedupe state in existing `runs` rows;
- windowed Behavior analysis/history in existing watcher-window storage.

There is no webhook payload table, subscription ledger, or parallel queue table. The existing database/runtime names `watchers`, `watcher_versions`, `watcher_windows`, `watcher_id`, and the client `watchers` namespace remain compatibility/storage vocabulary; they do not represent a second product code path.

## Public trigger contract

The canonical runtime schema lives in `packages/core/src/contracts/tools/manage-behaviors.ts` and is exposed to declarative config through `@lobu/connector-sdk` without maintaining a duplicate type definition.

### Event trigger

```ts
{
  kind: "event",
  connector_key: "github",
  connection_id: 12,                 // positive integer, never a string
  event_types: ["pull_request.created"],
  match: { repository: "lobu-ai/lobu" },
  execution: "turn",                 // or "window"
  active_run: "queue",               // queue | coalesce | steer
  output: "silent",                  // silent | reply_to_source
  skip_if_unchanged: false
}
```

### Schedule trigger

```ts
{
  kind: "schedule",
  cron: "0 9 * * 1-5",
  timezone: "Europe/London",
  execution: "window",
  active_run: "coalesce",
  skip_if_unchanged: true
}
```

TypeBox rejects string `connection_id` values. Normal API/tool writes also verify that the integer connection belongs to the caller's organization, uses the declared connector, and that every event/output/steering option is supported by the connector's published event catalog.

The declarative config surface is now `defineBehavior` plus `defineConfig({ behaviors })`. Connection handles/slugs are accepted in source config and resolved to integer IDs during apply. `Platform.channels`, `defineWatcher`, and `defineConfig({ watchers })` were removed. Legacy `Behavior.schedule` remains deprecated for source compatibility, while all shipped examples and the scaffolded project guide now demonstrate canonical schedule triggers.

## Schema and migrations

No new table was added.

### `20260717120000_behavior_triggers.sql`

- Adds `watchers.triggers jsonb NOT NULL DEFAULT '[]'` and an array check.
- Backfills existing scheduled rows into schedule triggers.
- Keeps `schedule`, `timezone`, and `next_run_at` as the indexed projection used by the mature due-schedule query.
- Adds the partial GIN trigger index.
- Adds `connector_definitions.behavior_events` with an array check so bundled and custom connectors publish the same catalog metadata.
- Replaces the old one-active-watcher-run index with an executing-only unique index. Multiple event runs may wait, but only one run per Behavior can be `claimed`/`running`.
- Includes a down migration restoring the old active-run index and removing the two new columns/indexes.

### `20260717123000_behavior_channel_subscriptions.sql`

- Repairs historical Slack Grid team IDs from the durable channel transcript before conversion; unresolved non-workspace IDs become null and self-heal from the next message.
- Refuses migration if a legacy binding has no concrete connection ID.
- Backfills every legacy `agent_channel_bindings` row into an ordinary active Behavior/version with:
  - `message.created` event trigger;
  - concrete integer connection ID;
  - native channel/team filter;
  - turn execution;
  - `steer` busy policy;
  - `reply_to_source` output;
  - old model override moved to `execution_config`;
  - `system:chat-link` tag for the internal claim/link adapter.
- Avoids duplicates when a matching Behavior was already created during a rolling deployment.
- Drops `agent_channel_bindings`.
- Creates the read-only `behavior_channel_subscriptions` view over active Behavior triggers for relational authz/routing/feed queries. The view owns no state.
- Includes a down migration that reconstructs the old binding table from the view before dropping the view.

The former manual `PR1-data-reconcile.sql` is deleted because its repair is now part of the automatic, tested migration.

## Connector-owned event catalogs and normalization

Connector definitions can publish `behaviorEvents`, each with:

- stable connector-owned event key and human label;
- optional resource type and filter JSON Schema;
- defaults for execution, busy policy, and output;
- capabilities for steering and replying to the source.

Catalog metadata flows through connector compilation, installation, database definitions, catalog manifests, catalog merging, API responses, and the UI. Server-side Behavior writes use the same catalog for validation, so CLI/MCP/API callers cannot bypass UI restrictions.

GitHub and Slack are the first complete connector implementations:

- GitHub publishes PR/comment/commit event definitions and normalizes inserted/superseded canonical events in `github-behavior-events.ts`.
- Slack publishes `message.created`, including steering and reply-to-source capability, in `slack-behavior-events.ts`.
- Provider-specific parsing stays in connector code. Core only sees a bounded `ConnectorTriggerSignal` containing stable event/resource keys, normalized attributes, input text, and a delivery ID.
- No raw webhook body or credential is placed in a Behavior run.

The existing GitHub App installation/webhook lifecycle was reused. This work does not create another GitHub subscription mechanism; it adds normalized Behavior activation after the already-existing canonical ingestion path.

## Durable event activation

The shared implementation is under `packages/server/src/behaviors` and `packages/server/src/runs/queue-service.ts`.

1. A connector or chat adapter authenticates/interprets the provider delivery.
2. Canonical data is persisted first.
3. A bounded connector signal is materialized with a durable delivery ID.
4. Active Behaviors are matched by connector, optional integer connection ID, event type, and exact normalized match fields.
5. One run is created per matching Behavior.
6. New pending runs are dispatched immediately when possible; the existing automation tick remains the crash/restart backstop.

GitHub ingestion uses `insertEvent(..., afterPersist)` inside one database transaction. A failed activation rolls back the new event state, and an unchanged source event emits no signal. `events` remains append-only: updates use the existing supersession path.

### Dedupe and busy policies

`createBehaviorEventRun` takes a per-Behavior Postgres advisory transaction lock. This makes decisions correct across replicas.

- Duplicate: any historical run already containing the delivery ID is reused.
- Queue: create a distinct pending run for each unique event.
- Coalesce: append the signal/delivery ID to the oldest compatible pending event run.
- Steer: trusted live chat messages opt into the existing worker steering path; other event contexts safely queue.

Run idempotency keys use `behavior:<behaviorId>:<deliveryId>`. Standard scheduled/manual window creation also has per-window idempotency now that pending runs are allowed to coexist.

Event-turn payloads pin the current Behavior version, carry only bounded signal data, bypass window-memory preflight, and complete on the normal terminal response. Window execution continues through the existing window/extraction/reaction lifecycle.

## Schedule and skip-if-unchanged semantics

Schedules remain cron-driven by the existing watcher automation service; the trigger is canonical configuration and the old indexed columns are its projection.

For a due schedule with `skip_if_unchanged: true`, `fingerprintWatcherSources` executes the same normalized sources as the normal knowledge read before any agent/LLM run:

- all sources empty: advance the schedule, create no run;
- same deterministic source fingerprint as the last completed run: advance, create no run;
- changed fingerprint: persist it in the run payload and continue.

Source SQL failures are not treated as empty. `executeDataSources({ throwOnError: true })` makes this gate fail closed so a bad query cannot silently suppress work.

This gives cron the intended batch-engine behavior: it can poll frequently without paying for an agent turn when nothing changed.

## Slack/chat consolidation

Slack messages and generic connector events use the same Behavior trigger vocabulary. Chat SDK remains a provider transport/renderer, not a separate subscription state machine.

- `/lobu link`, hosted preview claims, Slack claim onboarding, team self-healing, channel authorization, connection facets, notification/scheduled delivery, and streaming-feed projection now read/write Behavior subscriptions.
- `BehaviorSubscriptionService` is a small internal adapter that creates/updates/archives tagged Behaviors and reads the `behavior_channel_subscriptions` view.
- Normal `manage_behaviors` writes require same-org connection ownership.
- The already-authorized preview claim path can create a cross-org tagged Behavior pointing at the globally identified preview connection; ordinary callers cannot use that exception.
- A chat delivery matches every Behavior. Silent/window Behaviors become background runs; every reply-producing Behavior receives its own direct turn. The provider message/history/attachment work is shared rather than repeated.
- Behavior instructions are ephemeral trusted turn context. The user's source message remains untrusted user input and is not rewritten into system instructions.
- Only a Behavior whose busy policy is exactly `steer` can steer a live worker. Queue/coalesce remain separate turns.

Deleted chat-specific state/code includes the binding service/scope resolver, Slack binding scope, manage-connections binding actions and schemas, old channel-binding tests, the old confirm-bind card, and CLI channel reconciliation.

## Connector action `subscribable` results

Connector actions may return a bounded `subscribable` hint:

```ts
{
  connector_key: "github",
  resource_type: "pull_request",
  resource_ref: "github:pull_request:lobu-ai/lobu#123",
  label: "GitHub PR lobu-ai/lobu#123",
  suggested_event_keys: ["pull_request.updated"]
}
```

The hint does not create a subscription and does not duplicate the event catalog. It only identifies the resource and suggested connector-owned event keys.

- Connector SDK validates the shape.
- GitHub PR actions emit it.
- Worker tool-use summarization preserves it for direct and MCP-wrapped results.
- The chat UI renders an “Add behavior” card even when generic tool-call details are hidden.
- The card deep-links to the normal Behavior editor with connector/resource/event filters prefilled.

## Management/API/CLI/MCP consistency

- The sole write/management tool is `manage_behaviors`.
- Core contracts, server registry, authorization/write gate, approval runs, MCP exposure, REST routes, CLI apply client, generated TypeScript client, examples, worker tool cards, and Owletto all use it.
- `manage_watchers` and its contract/export/handler tree are deleted.
- Legacy channel-binding actions were removed from `manage_connections` and the generated client was regenerated.
- Behavior create/update/version/list/trigger/complete-window/feedback paths all accept/return triggers as appropriate.
- Update remains PATCH semantics; version-owned fields still use the version actions.
- `list/get` response fields such as `watcher_id` remain wire-compatible to avoid a second, unrelated ID migration.

## UI behavior

The former watcher and schedule screens are merged into the canonical Behaviors area.

### List

- Reads one persisted Behavior list; it no longer merges watchers, channel bindings, and scheduled jobs client-side.
- Derives Event/Schedule/Manual and Reply/Save-in-Lobu labels from triggers.
- Filters by trigger kind, output, and active/failing state.
- Definition and activity views remain available through the existing detail route.
- Delete archives the Behavior through `manage_behaviors`.

### Add/edit

- First choose Connection event, Schedule, or Manual.
- Connection event then asks for an active connection and one of that connector's published events.
- Connector filter schema renders provider-owned fields such as GitHub Repository.
- Resource/action and Slack links prefill the same editor; there is no separate bind screen.
- Progressive Trigger options contain only meaningful choices:
  - run each event or batch into a window;
  - queue, combine waiting events, or steer when the connector event supports it;
  - reply to source only when supported, otherwise save in Lobu;
  - skip unchanged for window execution.
- Schedule defaults to window/coalesce/skip unchanged.
- Manual stores `triggers: []`.
- Integer connection IDs round-trip through create and edit.
- Existing additional triggers are preserved when editing the primary trigger; the current product editor intentionally authors one primary trigger while API/CLI/MCP can author the full array.

The old separate schedule form/route, bind card, `agent-watchers-create`, and binding hooks were deleted. Scheduled jobs still exist for one-off/delayed agent jobs but are no longer presented as Behaviors.

## Seeded local verification state

The running local stack currently has:

- active GitHub connection ID `1`;
- active Slack connection ID `2`;
- GitHub PR Behavior ID `1`: `pull_request.created`, repository `lobu-ai/lobu`, queue, silent;
- weekday schedule Behavior ID `2`: 09:00, coalesce, skip unchanged;
- Slack Behavior ID `3`: channel `C-ENGINEERING`, `message.created`, mention filter, steer, reply to source.

The canonical page was browser-verified at the URL at the top of this file:

- list showed Event/Schedule/Manual examples and filters;
- editor listed GitHub and Slack connections;
- GitHub catalog showed PR created/updated, comment created/updated, and commits updated;
- PR selection showed the Repository filter;
- GitHub correctly omitted unsupported steer/reply choices;
- browser error list was empty;
- only known development console noise remained (Vite reconnect history and the TanStack devtools warning after hot restarts).

## Verification evidence

Green before the final review-fix pass:

- `make test-unit` — full repository no-Postgres unit suite.
- `make pre-pr` — all builds/typechecks, generated server bundle/catalog checks, Owletto production build, CLI build, knip, and root lint.
- Owletto full suite — 82 files, 701 tests.
- Relevant serialized Postgres suite — 133 tests.
- Gateway Bun groups — 51 tests.
- Server trigger/migration/catalog/wire groups, including:
  - event trigger round-trip, matching, queue, dedupe, and coalesce;
  - schedule empty/unchanged gating;
  - chat fan-out, steering policy, preview routing, authorization, and feed projection;
  - connector catalog merge/installation;
  - string connection-ID rejection and hard internal integer guard;
  - action-result subscribable propagation.
- Fresh ephemeral PostgreSQL 18 migration chain after the final SQL cleanup:
  - migration invariants: 14 tests;
  - legacy channel subscription backfill/Slack team repair/drop/view/down migration: 2 tests.
- Targeted declarative contract rerun after the public-doc cleanup: 56 tests.
- Browser verification through the agent-browser workflow with no page errors,
  including a real Manual Behavior create/list/archive round-trip through UI,
  API, and PostgreSQL.
- `git diff --check` in root and Owletto.

Additional final-audit regressions are green after the settled commits:

- migration rollback projects the newest Behavior when several Behaviors target
  the same channel;
- Slack team-ID repair is organization-scoped;
- configured Behavior creators retain priority over arbitrary organization
  members;
- Slack self-healing updates only the exact numeric connection and does so in a
  single atomic PostgreSQL update;
- schedule trigger options remain window-only in the UI;
- connector action prefill survives resolution of its matching connection.

## Intentional retained internals and gotchas

- `watchers`, watcher versions/windows, and `watcher_id` remain the established storage/window wire model. Renaming those identifiers would be a separate compatibility migration and would add churn without removing a code path.
- The `behavior_channel_subscriptions` object is a view, not another source of truth.
- `scheduled_jobs` remains for one-off/delayed jobs; cron Behaviors use the Behavior scheduler.
- Event matching is exact against connector-normalized values. Provider payload keys must never leak into core trigger logic.
- Connector event writes must preserve integer connection IDs; string IDs should fail immediately.
- Never treat source-query failure as empty/unchanged.
- Never put raw webhooks or credentials in a run.
- Never replace Postgres locks/durable delivery IDs with an in-memory map; multi-replica correctness is required.
- `events` is append-only.
- Connector event capabilities are authoritative for UI and server writes. A custom connector gets the same features by publishing its catalog and normalized signals; unsupported options are rejected rather than guessed.

## Finalization record

- Owletto commits:
  - `c32c185c feat: consolidate reactive behavior UI`
  - `77fc2d90 fix: align behavior trigger options`
  - `c805ca7b fix: preserve behavior action prefill`
- Root commits:
  - `f1300244 feat: consolidate reactive behavior triggers`
  - `b59dbb94 fix: harden behavior subscription migration`
- `make review-fix BASE=origin/main`: attempted on the settled implementation
  before the manual audit; the external Codex reviewer exited `2` because its
  quota is exhausted until July 23, 2026 at 05:16. It made no changes and
  posted no review.
- Manual review after that external failure found and fixed the six regression
  classes listed above. Those fixes are committed in root `b59dbb94` and
  Owletto `77fc2d90`/`c805ca7b`.
- Final `make pre-pr`: green.
- Final `make test-unit`: green across the complete no-Postgres repository
  suite.
- Final Owletto suite: 82 files, 701 tests, all green.
- Final Postgres reruns after the audit fixes:
  - migration chain: 16 tests, all green;
  - Behavior subscription organization-scope group: 6 tests, all green.
- Earlier broad relevant Postgres Behavior/runtime group: 133 tests, all green;
  every later code change is covered by the focused final reruns above.
- Browser E2E: list/editor/catalog/capability checks plus a real
  create/list/archive round-trip are green; browser errors are empty.
- `make review BASE=origin/main`: run after this handoff commit; record its
  exact outcome below if the external quota remains unavailable.
- Final root and Owletto worktrees: clean before this handoff update; recheck
  after its commit and reviewer attempt.
- Diff statistics against the respective bases:
  - root, including the Owletto submodule pointer and this handoff: 225 files,
    6,903 insertions, 4,073 deletions, net +2,830;
  - Owletto: 36 files, 1,552 insertions, 2,135 deletions, net -583.

The consolidated product UI is net negative. The repository-wide change is
not: durable migrations, compatibility adapters, normalized connector
contracts, generated client output, and regression coverage outweigh the
deleted chat/watcher UI and binding implementation. No parallel trigger or
subscription storage system was added to chase a line-count target.

External release steps, only if explicitly requested later:

1. Push the Owletto branch first.
2. Push the root branch containing the updated submodule pointer.
3. Open the PR(s), ensuring the Owletto commit is reachable remotely.
4. Apply the migrations through the normal deployment workflow before mixed-version traffic depends on the view.
