# WS-B — Slack channel operations (list/join) as connection actions + auto-join driver

> Status: plan, ready for an implementer. Mostly independent; integrates with WS-A
> for binding/capture. See [README](./README.md) for cross-cutting decisions.

## Goal
Let an agent (esp. the per-org builder agent) add the Slack bot to public channels
and enumerate channels via **connection actions**, plus a driver to auto-join all
public channels so the bot listens workspace-wide. Today the bot only receives
messages from channels it is manually invited to.

## Central grounded correction (lead with the risk)

**Slack does not live in the operations world at all.** `manage_operations.execute`
targets rows in the **`connections`** table by `connection_id`
(`operations/connector-operations.ts:481-495`). Slack writes only an
`app_installations` row at install (`slack-connection-coordinator.ts:154` —
*"This is NOT an agent_connections row"*) plus per-agent `agent_connections` rows
at `/lobu link`. There is **no `connections` row for Slack**. So
`manage_operations.execute` has nothing to point at, and neither credential
resolver reaches the bot token:
- `http_operation` → `resolveCredentialsByConnectionId` hard-joins
  `auth_profiles … profile_kind='oauth_account'`; the bot token is in the secret
  store (`installations/<id>/botToken`), not an oauth_account. Returns null.
- `local_action` → `resolveExecutionAuth` has an app-installation branch, but the
  installation-token registry only registers `GitHubInstallationTokenProvider`
  (`gateway/installation/registry.ts:23`) — no Slack provider ⇒ throws.

The **proven** bot-token path already used in prod is `slack-acl-sync.ts:226-235`:
`getSlackInstallByTeamId(store, teamId)` → `install.config.botToken` →
`resolveSecretValue(secretStore, ref)` under `orgContext.run({organizationId})`.

→ Two strategies; **Approach 1 (native gateway action handler) recommended** —
reuses the proven token path, avoids compiling the deliberately-inert Slack
connector. **Approach 2 (full framework: Slack InstallationTokenProvider +
compiled connector)** documented as the heavier "framework-pure" alternative.

## Phase 0 — Slack Web API surface (shared by ops + driver)
`gateway/connections/slack-web.ts`: add to `SlackWebApi` + `createSlackWebApi`,
reusing the form-encoded `slackPost` helper:
- `conversationsList(botToken, {types,excludeArchived})` — `conversations.list`,
  `types='public_channel'`, cursor-paginated. Returns `{id,name,isPrivate,isMember,isArchived}`.
- `conversationsJoin(botToken, channelId)` — `conversations.join`; treat
  `already_in_channel` as success, `method_not_supported_for_channel_type`/`is_archived`
  as non-fatal skips. Needs a raw (`{ok,error}`) variant to inspect errors without
  the throwing wrapper.
- `conversationsInvite(botToken, channelId, userIds)` — optional.

Add 429 handling to `slackPost` (read `Retry-After`, bounded retry): `conversations.list`
is Tier-2 (~20/min), `conversations.join` Tier-3 (~50/min), per-workspace.

## Phase 1 — Scopes & manifest (must precede join)
`conversations.list` is already permitted (`channels:read`). `conversations.join`
needs **`channels:join`**, currently missing.
1. `connectors/src/slack.ts:36-56` — add `'channels:join'` to `SLACK_BOT_SCOPES`.
2. `config/slack-app-manifest.self-install.json` + `qa-user.json` — add to bot scopes.
3. (Optional, instant new-channel join) subscribe `channel_created` + add to
   `SLACK_BOT_EVENTS`.
4. Keep `scripts/slack-manifest.ts` parity (CI test asserts it).

**Re-consent:** adding a bot scope means every already-installed workspace must
reinstall before `conversations.join` succeeds (old token → `missing_scope`). The
driver treats `missing_scope` as a soft, non-fatal, per-workspace condition (log
once, surface on the connection, nudge admin via the connector-health Slack alert).

## Phase 2 — A `connections` row for the workspace (the missing ops target)
Create one `connections` row per (org, workspace), bound to the install, mirroring
the GitHub pattern (`app-install.ts:415-560`, advisory-locked select-or-insert
keyed on `config->>'installation_ref'`). Add `ensureSlackOperationsConnection(...)`
in `slack-connection-coordinator.ts` `persistInstallation()` (~`:165`):
- advisory lock; `SELECT … WHERE connector_key='slack' AND config->>'installation_ref'=$installId`;
- if absent, `INSERT INTO connections (..., connector_key='slack', slug='slack-<team>',
  config={installation_ref, team_id})`.
- `config` carries only `installation_ref` + `team_id` (no channel target), like GitHub.

Workspace-scoped (the bot acts as the app, not a per-agent identity) — correct for
"add the bot to channels". Backfill: a one-shot task over active Slack
`app_installations` (can ride the auto-join driver's first tick).

> For Approach 2, `config.installation_ref` must be the **`app_installations`
> bigint PK** (what `resolveAppInstallationCredential` loads), not the
> `slackinst-<uuid>` external id. Approach 1 keys on `team_id`, so the PK only
> matters for Approach 2.

## Phase 3 — Declare Slack connector `actions` (discovery + gating)
`connectors/src/slack.ts:71-152` — add an `actions` block (projected to
`connector_definitions.actions_schema`, surfaced by `getLocalActionOperations`).
Declaration-only; requires no feeds/sync/runtime.

```
list_channels   requiresApproval:false  input:{types?,exclude_archived?,cursor?}  output:{channels:[{id,name,is_private,is_member,is_archived}],next_cursor?}
join_channel    requiresApproval:false  input:{channel_id}                        output:{ok,already_in,channel_id}
post_message    requiresApproval:false  input:{channel_id,text}                   output:{ok,ts?}
invite_users    requiresApproval:true   input:{channel_id,user_ids[]}             output:{ok}
```
`getLocalActionOperations` forces `kind:'write'` (cosmetic for `list_channels`).

**Approval policy:** default `list_channels` + `join_channel` to `auto` (the
builder agent must operate workspace-wide); `invite_users` to `approval`. Admins
override per-op via `connection.config.action_modes` (`disabled|approval|auto`).
The org-wide auto-join driver (Phase 5) bypasses the agent path, so `action_modes`
governs only agent-initiated joins. The `actions` facet flips true automatically.

## Phase 4 — Wire bot-token execution into the operations executor

### Approach 1 (RECOMMENDED) — native gateway action handler
Add a dispatch branch in `manage_operations.ts` `executeOperationInline` (`:481-505`):
for a Slack `local_action`, call `executeSlackNativeAction(...)` instead of the
compiled executor. The handler:
1. reads `team_id` from `connection.config.team_id`;
2. resolves the bot token via the proven `slack-acl-sync.ts:226-235` path under
   `orgContext.run`; rejects if `install.organizationId !== orgId`;
3. switches on `operation_key` → `conversationsList`/`conversationsJoin`/`postMessage`/`conversationsInvite`;
4. after a `join_channel`, fires the per-channel binding/capture step (Phase 6);
5. persists the run via existing `completeRunInline`/`failRunInline`.

Set `requireCompiledCode:false` for the Slack native case (`:743`). Keep the
connector-aware branch behind a tiny native-handler registry keyed by
`connector_key` (mirrors the `onChromeDispatch` seam). Pros: reuses the exact
proven token path, no Slack compilation, minimal blast radius.

### Approach 2 (alternative) — Slack InstallationTokenProvider
New `gateway/installation/slack-installation-token-provider.ts` implementing
`InstallationTokenProvider` (`provider='slack'`, mint from `install.metadata.config.botToken`),
registered in `registry.ts:20-26`. But `local_action` still requires **compiled
Slack connector code** with `execute()` handlers — i.e. Slack stops being inert.
Heavier. Keep steps 1–3 as a fast follow (the "right" abstraction) once another
Slack op needs the framework path; Phase 2's `installation_ref` makes it a drop-in.

## Phase 5 — Auto-join-all-public-channels driver
Model exactly on `runSlackAclSyncTick` (`slack-acl-sync.ts:211-249`) — same query,
token resolution, single-claimant scheduling — so multi-replica safety is inherited.

New `gateway/connections/slack-auto-join.ts`:
- `syncSlackWorkspaceJoins({organizationId,teamId})`: resolve token →
  `conversationsList(public, excludeArchived)` → for each `isMember===false`,
  `conversationsJoin` (idempotent; `missing_scope` → soft-degrade; 429 handled in
  `slackPost`) → ensure binding+capture (Phase 6). Concurrency 1 (Tier-3 limit).
- `runSlackAutoJoinTick(coreServices)`: query distinct active Slack workspaces from
  **`app_installations`** (workspace-level, not per-agent); iterate; aggregate.

Register in `scheduled/jobs.ts` alongside `:139-164`:
`scheduler.register('slack-auto-join', …, { cron: '*/15 * * * *' })` — single-claimant
per tick via the TaskScheduler runs-queue (same as `connection-health`/`authz-acl-sync`);
`conversations.join` idempotency makes accidental double-claims harmless.

Triggers (all idempotent, converge on `syncSlackWorkspaceJoins`):
1. Install time — fire once after `ensureSlackOperationsConnection`.
2. Incremental — `channel_created` webhook (if subscribed) joins just that channel.
3. Periodic — the `*/15` tick (catches down-pod gaps, scope re-grants, drift).

`member_joined_channel` (already subscribed) is the hook to (re)assert binding/capture
when the bot is manually added — wire to Phase 6.

## Phase 6 — Per-channel binding/capture (routability; WS-A seam)
A joined channel only produces routable traffic with a binding + capture:
- `createChannelBinding({organizationId, agentId:system_agent_id, platform:'slack',
  channelId, teamId})` (`postgres-stores.ts:499-523`, idempotent).
- Set `connection.settings.recordChannelMessages = true` (`types.ts:152`,
  consumed at `message-handler-bridge.ts:424-433`) = "listen without responding".

WS-A owns the binding/capture semantics; WS-B calls
`ensureChannelRoutable(orgId, teamId, channelId)` after each join. If WS-A lands
together, WS-A implements the body; else WS-B provides a minimal binding+capture.

## Phase 7 — Builder-agent UX & gating
`manage_operations.list_available {connection_id}` (the Phase-2 workspace row) →
sees `list_channels`/`join_channel`/`post_message` (filtered by `action_modes`) →
`execute {operation_key,input}`. `execute` is owner/admin-gated (`tool-access.ts:89`);
an owner/admin-initiated builder turn (`system_agent_id`) satisfies it. The auto-join
driver runs server-side, outside this gate. Verify `manage_operations` is exposed to
the builder turn's tool set.

## Schema / data
No new tables. `connector_definitions.actions_schema` gains 3–4 actions (Phase 3,
no DDL). One new `connections` row per (org, workspace) (Phase 2, no DDL).
Existing `agent_channel_bindings` / `recordChannelMessages` (Phase 6). New runtime
job row `slack-auto-join`.

## Tests (mock Slack via the injectable `SlackWebApi` seam)
1. `slack-web.ts` — pagination; `join` maps `already_in_channel`/`missing_scope`/429.
2. `manage_operations` native dispatch — routes to `executeSlackNativeAction`,
   resolves token, persists run; cross-org install rejected; `requireCompiledCode`
   not enforced for Slack.
3. action listing — `getOperationsSummary('slack').total` becomes 3–4;
   `list_available` honors `action_modes`.
4. auto-join — joins only non-member non-archived; idempotent; `missing_scope`
   soft-degrades without throwing; one workspace failure doesn't abort others.
5. multi-replica — concurrent `syncSlackWorkspaceJoins` both succeed; single-run per tick.
6. install-time bridge — exactly one `connections` row per (org,team) under
   concurrency; reinstall reuses it.
7. binding/capture — post-join, binding + `recordChannelMessages` set; subscribed
   non-mention message recorded but no turn.
8. manifest/scope parity — `channels:join` in both `SLACK_BOT_SCOPES` and the
   manifest JSONs.

## Rollout / phasing
1. PR1 — `slack-web.ts` methods + 429 + tests (no behavior change).
2. PR2 — scopes + manifests + parity; deploy → reinstall hosted app for `channels:join`.
3. PR3 — Phase 2 connections-row bridge + backfill (idempotent).
4. PR4 — Phase 3 actions + Phase 4 Approach-1 executor + gating.
5. PR5 — Phase 5 auto-join driver, **dark-launched** behind
   `connection.config.auto_join_public` (default off) + kill-switch; pilot one org.
6. PR6 — Phase 6 binding/capture hardening with WS-A; optional `channel_created`.
7. PR7 (optional) — Approach-2 Slack InstallationTokenProvider.

## Risks
- **(High, user-facing) Re-consent gap** — existing installs lack `channels:join`;
  soft per-workspace degrade + admin nudge; never crash the tick.
- **(High, verified) Bot-token credential path** — neither resolver reaches it;
  Approach 1 sidesteps via the native token path.
- **Rate limits** — Tier-2/3 per workspace; pagination, concurrency 1, 429
  Retry-After, 15-min cadence; large workspaces join gradually (idempotent).
- **Noisy joins** — `connection.config.auto_join_public` flag (default off) +
  optional allow/deny pattern.
- **Inert-connector tension (Approach 2)** — adding `execute()` contradicts Slack's
  INERT design; Approach 1 keeps it runtime-free.
- **Cross-tenant token leak** — existing guards + explicit `install.organizationId === orgId` check.

## Files to touch
`gateway/connections/slack-web.ts` (methods + 429); `tools/admin/manage_operations.ts`
(native dispatch `:481-505`, `requireCompiledCode` `:743`); `connectors/src/slack.ts`
(actions `:71-152`, `channels:join` `:36-56`); new `gateway/connections/slack-auto-join.ts`
(model on `slack-acl-sync.ts:211-249`) + register in `scheduled/jobs.ts:139-164`;
`slack-connection-coordinator.ts` (`ensureSlackOperationsConnection` + install-time
trigger ~`:165`). Secondary: `utils/execution-context.ts:409-591`,
`gateway/installation/registry.ts` (Approach 2), the manifest JSONs,
`stores/slack-installations.ts`, `stores/postgres-stores.ts:499-523`,
`message-handler-bridge.ts:424-433`, `auth/tool-access.ts:89`.
