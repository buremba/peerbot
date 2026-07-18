# Reactive Behaviors consolidation handoff

## Objective and status

Worktree: `/Users/burakemre/Code/lobu-ai/lobu/.claude/worktrees/reactive-subscriptions-spike`

Branch: `feat/reactive-subscriptions-spike`

The branch is rebased on `origin/main`. The implementation consolidates scheduled watches, connector events, and chat-message activation into one Behavior trigger model. It does not add a second subscription system.

The final cleanup is intentionally a breaking migration: old Watcher-named public tools, REST routes, SDK namespaces, catalog kinds, declarative config, UI routes, and worker routes are removed rather than adapted. Existing database storage names are retained as storage vocabulary only.

## Final architecture

A Behavior is the single user-facing automation resource. It owns an ordered `triggers` array:

- `event` triggers activate from normalized connector signals such as GitHub PR creation or Slack `message.created`.
- `schedule` triggers activate from cron and use the existing scheduler projection.
- `triggers: []` is manual/API/CLI/MCP-only.

Event trigger policy is part of the trigger:

- `execution: "turn" | "window"`
- `active_run: "queue" | "coalesce" | "steer"` where connector capabilities permit it
- `output: "silent" | "reply_to_source"` where connector capabilities permit it
- `skip_if_unchanged` for window/batch execution
- connector-specific exact-match fields in `match`

Connectors expose supported Behavior events declaratively. Connector ingestion emits normalized Behavior signals after durable event persistence. Core activation consumes those normalized signals; provider-specific webhook parsing remains in connector code.

Cross-replica correctness is Postgres-mediated. Trigger matching, run creation, active-run coalescing/queueing, and durable source state do not rely on a process-local map.

## Canonical public surface

### MCP/admin tools

- `manage_behaviors` owns create, list, update, versions, trigger, delete, reaction scripts, feedback, and window completion.
- `get_behavior` owns the detailed Behavior/window read.
- `manage_catalog` uses the `behaviors` kind.
- `list_watchers`, `get_watcher`, and `manage_watchers` are absent from the registry and explicitly covered by absence tests.

### Sandboxed SDK

- Canonical namespace: `client.behaviors`.
- `client.watchers` is deleted.
- Method metadata and `search_sdk` advertise only Behavior methods.
- Reactions receive `ctx.behavior`; `ctx.watcher` is deleted.
- Persisted window/provenance fields such as `watcher_id` remain because they identify rows in retained watcher storage; they are not a compatibility namespace or duplicate execution path.

### REST and generated client

- `/api/:orgSlug/behaviors`
- `/api/:orgSlug/public/behaviors`
- `/api/:orgSlug/behaviors/windows/:windowId`
- `/api/v1/agents/:agentId/history/behaviors/:behaviorId/thread`
- `/api/:orgSlug/manage_behaviors`
- `/api/:orgSlug/get_behavior`

Legacy `/watchers` REST paths are removed. The complete OpenAPI document was regenerated into `packages/client/src/generated`; unrelated routes remain present.

### Worker/device API

- `POST /api/workers/me/behaviors/:behavior_id/trigger`
- `POST /api/workers/me/runs/:runId/complete-behavior`

The former `/api/workers/me/watchers/...` and `complete-watcher` paths are removed. Owletto macOS callers and integration tests use the canonical routes.

### Declarative CLI/config

- `defineBehavior(...)`
- top-level `behaviors: [...]`
- schedules are declared only as `triggers: [{ kind: "schedule", cron, timezone }]`
- top-level Behavior `schedule` and `timezone` inputs are rejected

The CLI apply/export/bootstrap paths all use the new public names and trigger schema. Internal desired-state variables may still say watcher where they directly model retained `watchers` rows.

### Catalog

- Catalog kind: `behaviors`
- Manifest: `behaviors.json`
- Generator: `generateBehaviorsManifest`
- Templates: `BEHAVIOR_CATALOG_TEMPLATES`
- Stale `dist/catalogs/watchers.json` is removed before generation

Templates store canonical triggers and no longer emit a top-level schedule.

### UI

Canonical routes:

- `/$owner/agents/$agentId/behaviors`
- `/$owner/agents/$agentId/behaviors/new`
- `/$owner/agents/$agentId/behaviors/$watcherId`

The Behavior editor first chooses Manual, Schedule, or a connection event. Event choices come from connector capability descriptors. Steering and reply-to-source controls appear only when the selected connector event supports them. Additional triggers are preserved when the current single-trigger editor saves.

Deleted UI paths/code:

- `/$owner/agents/$agentId/watchers`
- `/$owner/agents/$agentId/watchers/$watcherId`
- the intermediate `behaviors/watcher/$watcherId` route
- `src/lib/api/watchers.ts`
- watcher index/route compatibility resolvers

Server-produced Behavior links now target the canonical agent-owned detail route. Embedded `/lobu` is stripped when composing web UI links.

## Database and migration boundary

No new subscription table was added.

- Existing `watchers.triggers` is the source of truth.
- Existing `watchers.schedule`, `timezone`, and `next_run_at` remain indexed scheduler projections derived from the schedule trigger. They are not a second public trigger model.
- `agent_channel_bindings` is migrated to tagged message-event Behaviors and dropped by `20260717123000_behavior_channel_subscriptions.sql`.
- No `behavior_channel_subscriptions` table/view remains.
- No raw webhook payload table, wake-up ledger, compatibility view, or adapter table was introduced.
- Existing GitHub App installation and connector webhook ingestion are reused; activation is attached after durable connector-event persistence.
- `watchers`, `watcher_versions`, `watcher_id`, and related columns remain the storage contract. Renaming those tables/columns would be a separate destructive data migration with no execution-path simplification, so it is deliberately not mixed into this change.
- The old `watcher_windows` write model was already retired in favor of canvas-on-events; historical baseline/down migrations still mention it, while active runtime code uses the canvas projection.
- `events` remains append-only.

## Compatibility and deletion inventory

There are no runtime compatibility adapters for the old public API. In runtime and example code, the only exact old API-name occurrences allowed after the audit are:

- negative tests asserting `list_watchers` and `get_watcher` are absent
- the catalog build cleanup that deletes a stale generated `watchers.json`

Old storage vocabulary remains only where code talks directly to existing rows, columns, run types, and provenance.

## Example migration

All example configs use `defineBehavior` and `behaviors`. Reaction examples use `ctx.behavior`. Example docs, skills, and eval scenarios refer to Behaviors and the new tools.

The remaining `watcher_id`, `watcher_source`, and direct `watchers` SQL references in examples are persisted provenance/storage fields. They are not calls to the deleted Watcher API; changing them would require the separate storage migration described above.

The exact audit is:

```bash
rg -n 'defineWatcher|manage_watchers|list_watchers|get_watcher|client\.watchers|/watchers(?:/|\b)|watchers\s*:|ctx\.watcher\b|complete-watcher' examples
```

Expected result: no matches.

The positive audit finds `defineBehavior`, `behaviors`, `manage_behaviors`, and `ctx.behavior` across the examples. No example needs to call `get_behavior` or `client.behaviors` directly today.

## Validation completed

- Branch HEAD is based on the local `origin/main` ref.
- Pre-review audits fixed migration replay safety, transaction-scoped chat Behavior archival, an unused Slack normalization helper, the final Slack parser compatibility re-export, and stale public-API claims in changed plans.
- `make pre-pr` passed: fresh builds, strict typechecks, Knip, and Biome.
- Focused cross-package Bun tests passed, including core event matching, connector descriptors, agent-worker streaming, CLI config, message routing, and Slack parsing.
- Focused server Behavior event-activation, schedule-skip, and template tests passed: 10 tests.
- Owletto route, create-form, model, subscription-candidate, chat-route, and history tests passed: 83 tests.
- Catalog generation passed: 20 connectors, 2 skills, 5 Behaviors.
- Owletto production Vite build passed after the route cleanup.
- Postgres migration replay and channel-feed lifecycle tests passed: 11 tests. The archive transaction fix had explicit red (`malformed array literal`) → fix (`pgBigintArray`) → green evidence.
- Connection-scoped chat Behavior routing tests passed: 6 tests.
- `git diff --check` passes in both root and Owletto.

Still required before merge-ready status:

1. Inspect and commit Owletto with explicit paths, then commit the root with explicit paths and the submodule pointer.
2. Verify committed HEAD and the exact `origin/main...HEAD` path list.
3. Run one posted `make review BASE=origin/main`.

## Gotchas

- Do not reintroduce `agent_channel_bindings` or `behavior_channel_subscriptions`.
- Do not add a second schedule API; schedule columns are derived/indexed storage.
- Do not create a raw webhook payload store just to wake an agent. Persist connector events through the existing append-only event path, then emit normalized signals.
- Connector action `subscribable` hints prefill the editor; they do not silently create subscriptions.
- Validate event capability, steering, and reply support when saving a trigger.
- Runtime connection IDs may be slugs/managed IDs in connector infrastructure, but persisted Behavior trigger `connection_id` is the validated numeric connection row ID.
- Preserve trigger ordering and unknown additional triggers in UI edits until a full multi-trigger editor exists.
- Keep required shared state in Postgres so the design holds with three or more replicas.
