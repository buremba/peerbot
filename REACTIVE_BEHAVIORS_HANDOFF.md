# Reactive Behaviors consolidation handoff

## Objective and status

Worktree: `/Users/burakemre/Code/lobu-ai/lobu/.claude/worktrees/reactive-subscriptions-spike`

Branch: `feat/reactive-subscriptions-spike`

The branch is rebased on `origin/main`. The implementation consolidates scheduled watches, connector events, and chat-message activation into one Behavior trigger model. It does not add a second subscription system.

The final cleanup is intentionally a breaking migration: old Watcher-named public tools, REST routes, SDK namespaces, catalog kinds, declarative config, UI routes, and worker routes are removed rather than adapted. Existing database storage names are retained as storage vocabulary only.

Rebase state on 2026-07-18:

- Root base: `origin/main` at `f4858e11` (`feat: list_activity feed + Home + agent attention inject`).
- Owletto base: `origin/main` at `c8e2dbe1`.
- The rebase preserved main's manual-feed invariant: a feed without a schedule remains manual-only and does not regain the historical six-hour cadence.

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

The unused `resolve_path.bootstrap.recent_watchers` DTO and query are also removed. The Behavior pages load through the canonical Behavior API, so retaining that unused bootstrap branch would have kept a second stale public shape and an unnecessary SQL query.

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

Home activity links were audited in both the server feed and Owletto. Both now target `/$owner/agents/$agentId/behaviors/$watcherId`; neither emits the deleted `/watchers/$watcherId` route. User-visible fallbacks and public-page counters say Behavior/Behaviors while `run_type='watcher'` and `watcher_id` remain storage values.

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

- The branch and Owletto submodule are rebased on their current `origin/main` refs listed above.
- Pre-review audits fixed migration replay safety, transaction-scoped chat Behavior archival, an unused Slack normalization helper, the final Slack parser compatibility re-export, and stale public-API claims in changed plans.
- The final post-rebase `make pre-pr` passed: fresh builds, strict typechecks, Knip, and Biome.
- Focused cross-package Bun tests passed, including core event matching, connector descriptors, agent-worker streaming, CLI config, message routing, and Slack parsing.
- Final focused server unit tests passed: 92 tests across auth/tool access, registry deletion guards, Behavior dispatch messages, markdown formatting, and activity links.
- Core tests passed: 347 tests. Client tests passed: 7 tests.
- Final focused Postgres tests passed: 7 files / 28 tests covering event activation, unchanged scheduled batches, channel-subscription migration/replay, streaming feeds, manual feeds, terminal worker completion, and the `resolve_path` contract.
- Owletto route, create-form, Behavior model, subscription candidate, chat-route, history, activity-link, and notification tests passed: 9 files / 111 tests.
- Catalog generation passed: 20 connectors, 2 skills, 5 Behaviors.
- Owletto production Vite build passed after the route cleanup.
- Postgres migration replay and channel-feed lifecycle tests passed: 11 tests. The archive transaction fix had explicit red (`malformed array literal`) → fix (`pgBigintArray`) → green evidence.
- Connection-scoped chat Behavior routing tests passed: 7 tests. A new
  red-to-green regression proves chat-link creation uses the same
  Postgres-locked numeric ID allocator as canonical Behavior creation instead
  of stale watcher/version sequences.
- The final deletion audit added explicit red→green evidence:
  - activity links expected `/behaviors/:id` and initially received `/watchers/:id` in both server and Owletto tests;
  - `resolve_path` initially returned the retired `recent_watchers` property;
  - after deletion, the activity-link tests (17 Owletto + 5 server) and resolve-path contract (6 Postgres tests) are green.
- The settled pre-review pass also caught and fixed two stale integration assumptions:
  - the Owletto branch initially reintroduced the deleted `/$owner/c/$threadId` route; the route helper was removed and the production build is green;
  - the CLI diff test still changed the retired scalar schedule instead of canonical triggers; the schedule-trigger drift test and all 216 focused CLI tests are green.
- The typed client was regenerated from the live post-rebase OpenAPI document. The document contains `manage_behaviors` and contains no `manage_watchers`, `list_watchers`, `get_watcher`, `recent_watchers`, or `/watchers` path.
- The final examples audit returns no matches for the exact old public API pattern. Positive matches are `defineBehavior`, `behaviors`, and `manage_behaviors` only.
- The settled review-fix pass found a device-polling regression for queued event runs: once a device-pinned Behavior had a `running` run, a second poll could claim another pending run and violate the one-executing-run partial index. The regression was reproduced red with PostgreSQL `23505`, fixed by excluding Behaviors with a `claimed`/`running` run in the device claim query, and the full 9-test manual-trigger integration file is green using the real `createBehaviorEventRun` queue path.
- The deletion-audit working diff was net negative across the root and Owletto:
  439 insertions and 536 deletions (net `-97`). The complete feature remains
  net positive because it adds the generalized trigger model, connector event
  descriptors, migrations, UI, and regression coverage. Final rebased totals
  are 13,810 insertions and 11,281 deletions across root plus Owletto (net
  `+2,529`): root is 11,348/7,939 and Owletto is 2,462/3,342.

## Posted review findings and fixes

The installed Claude reviewer could not accept the repository's Draft 2020-12
JSON schema, so the supported Codex reviewer fallback was used. The first
completed posted review identified three blockers; each was reproduced with a
focused regression and fixed across its whole class:

1. Empty or unchanged scheduled windows advanced cron without advancing the
   durable canvas cursor. A skipped tick now appends a zero-content
   `canvas_state` root before advancing `next_run_at`, so the next period starts
   at the prior `window_end`. The append races safely on
   `idx_canvas_chain_root`; `events` remains append-only.
2. The trigger migration backfilled legacy schedules with
   `skip_if_unchanged: true`, changing their prior always-run behavior. The
   backfill now writes `false`; new Behaviors may opt into the gate explicitly.
3. Connector ingestion discarded every unchanged durable delivery before
   trigger matching. It now materializes an `unchanged` normalized signal and
   applies the policy per matching trigger. Retry-stable delivery IDs include
   the sync run, persisted event, and draft index. Existing resources use the
   connector's update event key when declared, so an opted-out PR-update
   trigger can match.

The populated-database migration regression also exposed the same stale-ID
allocator class in chat Behavior creation. Runtime chat linking now uses the
canonical transaction-scoped advisory-lock allocator, and the migration takes
those allocator locks while deriving `MAX(id)+1`.

Focused green evidence after the fixes:

- connector-signal unit tests: 3/3
- connector-event activation: 4/4
- scheduled unchanged cursor: 1/1
- channel-subscription migration/replay: 1/1
- connection-scoped chat Behavior routing and stale-ID allocation: 7/7
- device/manual Behavior triggering: 9/9

## Finalization checkpoint

- Owletto cleanup commit: `c2222835` (`refactor: remove legacy Watcher UI remnants`).
- Root cleanup commit: `refactor: finish Behavior API deletion cleanup`, including the Owletto submodule pointer. Its hash is intentionally not embedded in this self-referential commit; use `git rev-parse HEAD`.
- Review-blocker fix commit: current HEAD
  (`fix: preserve reactive Behavior delivery semantics`; use
  `git rev-parse HEAD`). The source fixes and focused regressions were verified
  from committed HEAD with `git show`.
- Root and Owletto merge bases equal their current `origin/main` refs, and both committed diffs pass `git diff --check`.
- The final `make pre-pr` is green on the settled fix commit: fresh builds,
  strict typechecks, Knip, and Biome all pass.
- A full-branch Codex reviewer rerun was stopped after it resent 316 files /
  19,281 changed lines and the user flagged excessive weekly-token spend. A
  bounded `HEAD^..HEAD` rerun (17 files / 417 changed lines) was also stopped
  after four minutes without a verdict. No second verdict exists; do not claim
  that reviewer gate is green. If policy still requires another model verdict,
  resume with the bounded fix-commit base only—never resend the whole branch.

## Gotchas

- Do not reintroduce `agent_channel_bindings` or `behavior_channel_subscriptions`.
- Do not add a second schedule API; schedule columns are derived/indexed storage.
- Do not create a raw webhook payload store just to wake an agent. Persist connector events through the existing append-only event path, then emit normalized signals.
- Connector action `subscribable` hints prefill the editor; they do not silently create subscriptions.
- Validate event capability, steering, and reply support when saving a trigger.
- Runtime connection IDs may be slugs/managed IDs in connector infrastructure, but persisted Behavior trigger `connection_id` is the validated numeric connection row ID.
- Preserve trigger ordering and unknown additional triggers in UI edits until a full multi-trigger editor exists.
- Keep required shared state in Postgres so the design holds with three or more replicas.
