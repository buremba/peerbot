# Reactive Behaviors consolidation handoff

## Current scope

Worktree: `/Users/burakemre/Code/lobu-ai/lobu/.claude/worktrees/reactive-subscriptions-spike`

Goal: consolidate watchers, schedules, Slack/chat bindings, and connector event listening into one Behavior trigger model without adding parallel subscription storage.

The intended product shape is:

- Behaviors are still stored in the existing `watchers` / `watcher_versions` / `watcher_windows` tables.
- Behavior activation is configured by `watchers.triggers`.
- `event` triggers cover connector events such as GitHub PR events and Slack messages.
- `schedule` triggers cover cron starts and project to existing indexed `schedule`, `timezone`, and `next_run_at` columns.
- `triggers: []` means manual/API/CLI/MCP-only.
- `agent_channel_bindings` is migrated into ordinary tagged Behaviors and dropped.
- No webhook payload table, subscription ledger, compatibility view, or adapter table is introduced.

## Important completed cleanup

- Removed the `behavior_channel_subscriptions` compatibility view from `db/migrations/20260717123000_behavior_channel_subscriptions.sql`.
- Made runtime readers project active `message.created` subscriptions directly from `watchers.triggers`.
- Removed the old Owletto `/watchers/create` redirect route and its generated route references.
- Removed declarative `Behavior.schedule`; CLI config now uses canonical schedule triggers and derives the indexed schedule projection from them.
- Updated `init-from-org` to emit `defineBehavior({ triggers: [{ kind: "schedule", ... }] })` instead of a top-level schedule field.
- Updated stale docs that described `behavior_channel_subscriptions` as a current view.
- Added a scheduled-delivery auth regression so one connection’s channel Behavior cannot authorize delivery on another connection with the same platform/team/channel.

## Files to inspect first after compaction

- `packages/server/src/scheduled/scheduled-jobs-service.ts`
  - `validateDeliveryAuthorization` now selects the resolved connection `id` and filters trigger projections with `c.id = connection.id`.
- `packages/server/src/tools/admin/__tests__/manage-schedules-delivery.test.ts`
  - New regression: “does not authorize a schedule through another connection's matching channel Behavior”.
- `packages/cli/src/commands/_lib/apply/map-config.ts`
  - `mapBehavior` rejects multiple schedule triggers, validates schedule trigger cron, and sets `DesiredWatcher.schedule` from the schedule trigger.
- `packages/cli/src/commands/_lib/init-from-org/bootstrap.ts`
  - Behavior export no longer emits top-level `schedule`.
- `packages/server/src/gateway/channels/behavior-subscription-service.ts`
  - Main product-link/preview chat subscription service; no compatibility view should be reintroduced here.
- `packages/server/src/__tests__/setup/behavior-subscriptions.ts`
  - Test-only helper for projecting active message-event subscriptions from Behavior triggers.

## Validation already run in this continuation

Review-fix was started and applied changes, then was interrupted because it continued into long manual audits. It exited with code `130`, so treat its edits as ordinary changes that were verified by the focused checks below.

Green runs observed during/after review-fix and the final cleanup:

- `make pre-pr`
  - Passed after the final scheduled-auth patch.
- `git diff --check`
  - Passed.
- `git -C packages/owletto diff --check`
  - Passed.
- `bun test packages/cli/src/commands/_lib/apply/__tests__/map-config.test.ts packages/cli/src/commands/_lib/init-from-org/__tests__/init-from-org.test.ts packages/cli/src/config/__tests__/define.test.ts`
  - 70 passing.
- `bun run test -- src/app/__smoke__/all-routes.test.tsx src/components/agents/behaviors/behaviors-new.test.tsx src/lib/behaviors/model.test.ts src/lib/behaviors/subscription-candidate.test.ts` in `packages/owletto`
  - 68 passing.
- `LOBU_EMBEDDED=1 bun test packages/server/src/tools/admin/__tests__/manage-schedules-delivery.test.ts`
  - 7 passing.
- `LOBU_EMBEDDED=1 bun test packages/server/src/gateway/channels/__tests__/behavior-subscription-service-org-scope.test.ts packages/server/src/__tests__/integration/behaviors/channel-subscription-migration.test.ts packages/server/src/gateway/__tests__/dm-link-e2e.test.ts packages/server/src/gateway/__tests__/dm-link-message-e2e.test.ts packages/server/src/__tests__/integration/slack/claim-onboarding.test.ts packages/server/src/tools/admin/__tests__/manage-schedules-delivery.test.ts`
  - 19 passing.
- `bun run vitest run src/tools/__tests__/search-managed-recall-and-acl.test.ts src/preview/__tests__/slack-preview.test.ts` in `packages/server`
  - 23 passing.
- `bun test packages/agent-worker/src/__tests__/custom-tools.test.ts packages/agent-worker/src/__tests__/sse-client-harden.test.ts packages/agent-worker/src/__tests__/tool-use-events.test.ts packages/server/src/__tests__/unit/behavior-event-trigger.test.ts packages/server/src/__tests__/unit/connector-behavior-signal.test.ts packages/server/src/__tests__/unit/manage-wire-schema.test.ts packages/server/src/__tests__/unit/watcher-execution-config.test.ts packages/connectors/src/__tests__/github-behavior-events.test.ts packages/connectors/src/__tests__/slack-behavior-events.test.ts`
  - 105 passing.

Review status:

- `make review BASE=origin/main` was run once on the settled diff.
- It failed before producing a verdict because the review wrapper rejected its JSON schema input:
  - `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`
  - The wrapper exited fail-closed with code `2`.

## Commit status

- Owletto submodule commit: `84199349 chore: remove legacy watcher create route`.
- Root commit message: `chore: remove behavior subscription compatibility paths`.
- Final status after these commits was clean in both the root worktree and `packages/owletto`.

## Gotchas

- Do not re-add `behavior_channel_subscriptions`; the agreed direction is direct projection from `watchers.triggers`.
- Do not re-add `agent_channel_bindings`; the migration is one-way and manual rollback is acceptable.
- Do not re-add declarative `Behavior.schedule`; source config should use canonical schedule triggers.
- `schedule` remains as a server/API indexed projection for existing schedule machinery. That is not a second trigger system.
- `watchers` table naming remains storage vocabulary. Renaming it is a separate large migration and out of scope.
- Connector action `subscribable` hints only prefill the Behavior editor. They must not create subscriptions themselves.
- Provider-specific event parsing stays in connector code. Core should receive only normalized connector signals.
- No raw webhook payloads or credentials should enter runs.
- `events` remains append-only.
- Any cross-replica state must be Postgres-mediated; no in-memory singleton state for trigger/dedupe behavior.
