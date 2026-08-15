# Design: two-axis Automation executors — running a Lobu agent ON a device

Status: draft for review
Scope: server (dispatch + worker-api) + device-worker contract; no DB schema change proposed yet

## 1. Goal

Make `agent_id` and `device_worker_id` two independent axes instead of a
conflicting pair:

- `agent_id` = **who** — the managed Lobu agent's identity and config
  (model, tools, prompt authoring)
- `device_worker_id` = **where** — the pinned device that executes the run
- `agent_kind` = **local harness** — which device-local CLI runs when there
  is no managed identity (today's device lane)

Setting both then means *"run this Lobu agent ON this device"* — the user's
proposed model — instead of today's silent device-first resolution that
drops the agent on the floor.

Non-goal: changing manual-only Automations (no triggers → executor optional,
any connected MCP client may execute and complete them).

## 2. Context — the silent failure class this replaces

#2499 centralized executor resolution in `resolveAutomationExecutor` with
device-pin-first precedence — deliberately preserving the legacy execution rules
where dual rows always ran on the device lane (#802). An Automation row carrying
BOTH `agent_id` and `device_worker_id` silently runs on the device and
ignores the managed agent entirely. Nothing rejects the combination at
create/update time (`assertAutomationExecutorsResolve`,
`packages/server/src/tools/admin/manage_automations/executors.ts`).

Prod casualties (2026-08-05): buremba `b5` (hourly-task-collaborator, 48
runs with zero pins) and `b71` (social-interest-radar-v2, 136 runs with one
pin) both died with
`no local agent executor configured for agent_kind='opencode'` — dual rows
at the moment the failing runs fired (the pins were added later the same
day), even though a point-in-time row count had earlier suggested dual
rows "don't exist". Lesson recorded: row counts of a mutable
config table cannot retire a runtime risk. `b2` (`hn-engagement`,
org_lobucrm) is still an active dual row.

A rejection guard was prototyped (worktree `reject-dual-executors`,
discarded 2026-08-05 by product decision) but rejected in favour of this
design: rejecting the combination codifies today's accident as permanent
semantics, while the two-axis model is what users actually mean when they
set both.

## 3. Current state (ground truth, verified 2026-08-05)

- **Device payload carries no identity.** The device job payload
  (`packages/server/src/worker-api/poll.ts`, `automation:` object) contains
  only `{ id, name, slug, agent_kind, notification_channel,
  notification_priority, execution_config, prompt, extraction_schema }`.
  No `agent_id`, no resolved model, no tools.
- **`agent_kind` selects a local CLI** on the device
  (`claude-code`, `codex`, `opencode`, `pi`, `agy`); the managed agent
  never crosses the boundary.
- **Completion stamps `model_used = device-cli:${agent_kind}`**
  (`packages/server/src/worker-api/run-lifecycle.ts:1280,1335`) — a dual
  row's run is indistinguishable from a pure device run after the fact.
- **Content already crosses the boundary**: the payload ships the
  version-pinned `prompt` plus composed skill snapshots (see the dispatch
  comment in `poll.ts`), and `extraction_schema` as the output contract.
  Only identity/config is missing.
- **Dispatchability** gates on
  `device_worker_id IS NOT NULL OR agent_id-resolvable`
  (`packages/server/src/automations/automation.ts:752`,
  `packages/server/src/automations/activation.ts:128`); device-pin-first
  resolution was centralized in `resolveAutomationExecutor` by #2499,
  preserving #802-era precedence.

## 4. Proposed semantics

| agent_id | device_worker_id | meaning | lane |
| --- | --- | --- | --- |
| set | null | managed agent, server dispatch | today's server lane |
| null | set | device-local CLI (`agent_kind`) | today's device lane |
| set | set | **managed agent ON the device** | new |
| null | null | manual-only | unchanged |

Create/update validation (`assertAutomationExecutorsResolve`) accepts all
four; the "zombie" rule (automated Automation with no executor) stays.

## 5. What must cross the boundary

1. **Identity/config**: `agent_id`, the agent's resolved model, tool set,
   and any agent-level config the executor needs. Additive fields on the
   existing `automation:` payload object — device-worker payload decode is
   strict, so the worker-side schema must land in the same release.
2. **Execution substrate decision (OPEN — see §8)**: on the device, either
   (a) the local CLI selected by `agent_kind` executes with the managed
   agent's config injected, or (b) the device hosts/streams a managed
   agent-worker session. (a) is incremental; (b) is the faithful model.
3. **Completion attribution**: `model_used` must record the managed agent's
   resolved model (plus the device fact), not `device-cli:<kind>`, or runs
   stay indistinguishable and the failure class hides again.
4. **Credentials**: the invariant stands — workers never receive real
   credentials. The sanctioned routes already exist: device-pinned
   connectors, and short-lived provider-derived credential leases
   (`packages/server/AGENTS.md`). A managed agent ON a device reuses the
   lease mechanism. Today's leases are minted per deployment with ~1h
   natural expiry (revocable at the provider, not auto-revoked); scoping a
   lease to the run and revoking it at completion is the proposed
   tightening (§8.4 covers refresh vs hard timeout). Nothing durable is
   shipped in the poll payload.

## 6. Migration

Existing dual rows today mean "silently device-first". Under this design
they become "agent on device" — a semantics CHANGE for live rows (`b2` is
known; a full audit query is cheap: `automations` is bounded config). Options:

- One-time migration that lists every dual row for human confirmation
  before the new semantics ship (preferred — matches the "surface them one
  at a time" rule for ambiguous org data).
- A transitional read-time warning log on dual-row dispatch until the
  device-worker side of §5.1 lands.

## 7. Rejected alternative

Reject dual rows at create/update (the discarded prototype). It matches
today's code and kills the failure class with one validation line, but it
permanently forbids the combination users intend, and it was prototyped
against an unsettled design. If this design stalls, the guard is a single
validation line in `assertAutomationExecutorsResolve` and can be
reintroduced in one small commit.

## 8. Open questions

1. §5.2 substrate: inject-into-local-CLI (a) vs hosted-agent-session (b)?
   (a) reuses the entire existing device lane; (b) needs a device-hosted
   runtime and is a much larger surface.
2. Which `agent_kind` values can host a managed agent, and does
   `agent_kind` remain user-settable when `agent_id` is present?
3. Device offline: queue-and-wait (today's device-pin policy) vs a
   per-Automation fallback policy. Leaning: keep queue-and-wait; a pin is a
   deliberate placement.
4. Lease duration on a device that may sleep: lease refresh protocol or a
   hard run-timeout.
5. Observability: surfacing "managed agent ran on device X" in the
   activity UI (ties into the `model_used` change).
