# Agent Model — Behaviors, Surfaces, Workflows

> **Status (2026-07-17):** **Reactive Behaviors implemented** — event, schedule,
> and manual activation now share one model and editor. Surfaces, workflow WAIT,
> and the broader proactivity policy remain future work.

Design of record for consolidating the agent config surface. Supersedes the
separate "Reach", "Watchers", and "Schedules" tabs. Written after review by
GPT‑5.5 (xhigh) and Grok, and a use‑case gauntlet.

Status: **model + UX locked; workflow execution has a small new mechanism +
two safety guarantees (below).**

---

## 1. The mental model — three nouns

An agent is three things a person can hold in their head:

- **Connections** — what it can *see* (sources + feeds).
- **Behaviors** — what it *does*. Each is one sentence: *"When ⟨X⟩, Ada ⟨Y⟩."*
- **Surfaces** — durable boards it *maintains* (dashboards, digests, reports).

Plus **Persona** (who it is), **Chat** (ad‑hoc / ambient Q&A), and **Runs** (an
audit view — secondary, not a headline noun).

Nav: `Chat · Behaviors · Surfaces · Persona · Connections` (+ Skills, Guardrails).

### Why "Behaviors" (not Triggers/Automations/Rules)
Agent‑native, and it makes *silence* and *quiet watching* read as features, not
failures ("Ada's behavior is to only speak when she can help"). Works because
Persona is a separate surface, so "behavior" unambiguously means *actions*, not
*character*.

---

## 2. Behaviors

One list. Each row is a sentence + an activation badge:

- **Event** — a normalized event from a connection, such as
  `pull_request.created` or `message.created`.
- **Schedule** — a clock / cron, optionally skipping unchanged source state.
- **Manual** — explicitly started from Lobu, API, CLI, or MCP.

An event can execute as one turn per event or as a window. Chat listening is not
a separate code path in the product model: it is an Event Behavior with a chat
connection, a channel filter, and optionally `reply_to_source`. Connector event
catalogs own the available event types, filter schema, and capability defaults.

### Output = attributes, not a verb‑noun
There is no "Say/Keep/Do" noun. A behavior's output is expressed as attributes:

- **destination**: `thread | channel | surface | inbox | external | silent`
- **disposition**: `ephemeral | maintain`
- **governance**: `auto | needs-approval`
- **proactivity** (per‑behavior override): `always | on-mention | when-confident | silent`

Use plain words in the UI ("Reply in thread", "Update a board", "Request
approval"), and structured facets for filtering (kind / output / state).

### Proactivity
A structured control, not prose. Default lives on **Persona** (Reserved /
Balanced / Proactive); each behavior can override it. It is the lever that
decides reply‑vs‑silence and must be per‑context.

---

## 3. Backend mapping

- **Behaviors are canonical `watchers` rows.** The `triggers` JSON array holds
  event and schedule activations; an empty array is manual-only. Prompt,
  sources, version history, execution settings, and activity remain on the
  existing watcher/version/run spine. No parallel Behavior table was added.
- **`manage_behaviors` is the canonical declarative writer** for API, MCP, CLI,
  and UI. The CLI `Project.behaviors` shape maps to the same trigger contract,
  and generated clients expose the same integer `connection_id` API.
- **Connector event catalogs are declarative.** A connector publishes event
  keys, filters, defaults, and capabilities. During ingestion it may publish a
  bounded normalized signal. The server persists the canonical connector event
  and materializes matching Behavior runs in the same Postgres transaction.
  Delivery IDs in existing `runs.approved_input` provide durable dedupe; there
  is no webhook-ledger table.
- **Chat uses the same matching model.** Slack/other Chat SDK adapters remain
  transport implementations, but routing comes from Event Behavior triggers.
  `reply_to_source` turns use the normal chat reply transport; silent/window
  matches use durable Behavior runs. Queue, coalesce, and opt-in steer behavior
  are explicit. Queue-policy chat events stay one turn per delivery.
- **Schedule is the batch engine.** The existing due scanner creates a window
  run. With `skip_if_unchanged`, it executes the normalized sources and hashes
  their durable state before dispatch. Empty or identical state advances the
  schedule without creating an agent run or LLM call. Without the flag, the
  schedule always runs.
- **Chat links are Behaviors only.** A one-shot migration backfills legacy
  `agent_channel_bindings` into tagged Event Behaviors, then drops that table.
  Runtime routing and ACL readers use active message triggers from
  `watchers.triggers` (via the `behavior_message_subscriptions` view). No
  dual-write bridge remains.
- **Runs / Activity** use the existing `runs`, watcher windows, and chat
  transcript paths. Event turns finish with their normal response and do not
  advance a cron schedule.
- **Surfaces** = a *keyed* event, updated by **upsert‑via‑supersede**
  (`supersedes_event_id`; `current_event_records` masks superseded rows).
  Incremental‑in (window cursor) → upsert‑out (rewrite the board). Distinct from
  Runs (append). No new table.
- **Chat replies** = `channel_messages` (the conversation transcript), separate
  from the events spine.

Connector actions may return a bounded `subscribable` resource candidate. Tool
result events preserve that candidate, and the chat UI renders **Add behavior**,
deep-linking to the same editor with connector/resource/event prefill. This is a
constructor hint, not an agent-created hidden subscription.

---

## 4. Workflows — a Behavior with a multi‑step body

**Option A (locked):** a Workflow is a Behavior whose action is a sequence with
`WAIT` steps (`do → WAIT → do`). Not a separate builder tab. Simple behaviors
stay one step; the list shows one sentence with a `workflow` tag and expands to
the flow.

Internally the body is a **versioned step graph/sequence**, even though the UI
renders one list item. (Locked invariant — see §6.)

The line where a separate builder is warranted (deferred until it appears):
branching, loops, parallel waits, reusable subflows, step‑level permissions, or
nontrivial data mapping between steps.

### WAIT — the one new primitive
Four conditions, **one mechanism** (suspend → resume on signal):

| condition | resumed by | owner |
|---|---|---|
| duration / deadline ("in 20 min") | a clock | **agent self‑schedules** `wake_agent` |
| count / threshold ("until 5 replies") | an event lands, check count | detector (Watch/ingest) |
| specific event ("PR merges") | the event lands | detector |
| a human ("until I approve") | approve clicked (an event) | detector |

**Key unification: approval *is* wait‑for‑human.** The governance
"needs‑approval" gate and a workflow WAIT are the same mechanism.

### Two resume paths
- **Time waits** → the agent schedules its own `wake_agent` and ends the turn;
  the scheduler re‑invokes it with a synthetic prompt. Durability rides
  `scheduled_jobs` leasing (multi‑replica safe). **Works today** —
  `manage_schedules(wake_agent)` is a real admin tool, grantable to a worker via
  the per‑run token (`BUILDER_ADMIN_TOOLS` / `resolveBuilderAdminGrant`).
- **Event waits** → a detector (schedule tick / connector ingest) resumes the **suspended
  run**, not a fresh behavior. This is the one genuinely‑new mechanism (§5).

### v1 scope (simplification)
- **Enable** agent self‑wake and watcher‑resume **by default** for workflow
  agents. The per‑agent / per‑watcher **disable toggles are deferred**.
- Self‑wake capability should be scoped to *self‑wake* (least privilege), not the
  full `manage_schedules` admin surface — a follow‑up hardening, not a v1 blocker.

---

## 5. The WAIT resume‑subscription (spec — the one new mechanism)

A time wait already resumes via the scheduler. An **event** wait needs the
detector to wake the right suspended run. Design:

- When a workflow reaches a WAIT‑for‑event step, it writes a **resume‑subscription**:
  `{ run_id, step_id, behavior_version, match: <event filter>, deadline, created_at }`.
  A deadline is always set (even for pure count/event waits) so nothing hangs
  forever.
- **Collection** (optional, a property of WAIT, not a separate step): inbound
  events matching the filter are correlated to the run (`run_id`) and appended to
  the run's partial state as they arrive.
- **Resume** happens on whichever fires first:
  - the detector (Watch tick / ingest) matches a new event against active
    resume‑subscriptions → wakes `run_id` at `step_id`; or
  - the deadline `scheduled_jobs` row fires → wakes with whatever was collected.
- **Claiming**: resuming a run takes an atomic lease (reuse the scheduler's
  `FOR UPDATE SKIP LOCKED` leasing) so exactly one replica resumes it.
- **Invariant**: *every WAIT resumes exactly one suspended step, under a durable
  claim.*

---

## 6. Safety guarantees (NOT toggles — required for correctness)

A capability checkbox enables a feature; these are correctness properties a
checkbox can't provide:

1. **Idempotency on irreversible terminal actions** — a re‑wake (crash before
   recording completion, then retry) must not double‑fire "order / pay / send".
   Require a per‑step idempotency key, or an agent "did I already?" check backed
   by memory. Model external effects as recorded `effect_started / effect_completed`
   (outbox‑style).
2. **Approval binding** — an approval event must bind to
   `run_id + step_id + behavior_version + approver + expiry` and be single‑use, so
   a stale approval can't resume the wrong run after an edit or retry.
3. **Versioned steps** — the run carries the `behavior_version` it started under,
   so an edit mid‑flight doesn't corrupt an in‑progress run.

---

## 7. Goals

- **Monitoring a goal** ("track MRR toward $50k, show progress, alert on drift")
  = a **Watch that maintains a progress Surface**. Buildable today with the base
  model; no new primitive.
- **Autonomously pursuing a goal** = a planning/agentic loop, not a reactive
  behavior. **Deferred** — an explicit, separate product bet. Do not smuggle an
  agentic loop into Behaviors.

---

## 8. Deferred (explicit)

- Per‑agent / per‑watcher **disable** toggles for self‑wake / resume (v1 enables
  by default).
- **Branching / parallel** workflow builder (Option B) — only when branching,
  loops, parallel waits, or subflows appear.
- **Autonomous goal pursuit**.
- Least‑privilege scoping of the self‑wake capability (hardening follow‑up).

---

## 8b. Surface change summary — API / MCP / backend

The consolidation changes the existing Behavior contract rather than adding a
new engine or admin tool:

- `manage_watchers` is removed; `manage_behaviors` owns the full prior watcher
  action set plus canonical trigger writes.
- `bind_channel`/binding CRUD is removed. Link/claim flows create or update a
  tagged chat Event Behavior through the same service.
- Connector definitions expose `behavior_events`; connector stream items may
  carry normalized `behavior_signals`.
- Public API, generated client, MCP registry, CLI config/apply/init, and UI all
  use the same trigger schema.
- An ordinary SQL view projects message subscriptions from active Behavior
  triggers for routing and ACL reads; it stores no state and adds no table.
- Self-wake for future workflows remains a capability grant over
  `manage_schedules`, not a new trigger engine.

The capabilities remain parts of the existing runtime rather than new MCP
tools:

| capability | backend change | new MCP tool? |
|---|---|---|
| connector events | normalized signal → matching durable Behavior run | no |
| proactive + silent chat | `message.created` Event Behavior + output policy | no |
| skip‑if‑unchanged | pre-dispatch normalized-source fingerprint | no |
| action subscription | bounded `subscribable` result → editor prefill | no |
| maintained Surfaces | upsert‑via‑supersede write path | no |
| proactivity | one structured field (persona default + per‑behavior override) | no |
| workflow event‑wait | the WAIT resume‑subscription (§5) + event→run correlation | no |
| workflow safety | idempotency on terminal actions + approval binding (§6) | no |

No new admin/MCP tool is introduced; Behavior writes use `manage_behaviors`.

## 9. Build phases

1. **Reactive Behavior consolidation (implemented)** — one trigger schema,
   connector catalogs/signals, schedule unchanged gate, chat subscription
   migration, canonical API/CLI/MCP/UI, and action-result constructor hints.
2. **Surfaces** — the upsert‑via‑supersede path for a maintained board.
3. **Workflows** — enable self‑wake + Behavior-resume; implement the WAIT
   resume‑subscription (§5) and the safety guarantees (§6).
4. **(deferred)** broader proactivity policy, disable toggles, branching
   builder, autonomous goals.

---

## Appendix — decisions & their basis

- Consolidation to `Behaviors` + `Surfaces` + `Runs`: converged across GPT‑5.5,
  Grok, and the internal gauntlet.
- Output‑as‑attributes (not Say/Keep/Do): both external reviews flagged the verb
  taxonomy as leaky.
- Surfaces first‑class, Runs as exhaust: "feeds are temporal; boards are spatial"
  (Grok); "activity is exhaust, not something you manage" (GPT‑5.5).
- Approval = wait‑for‑human: internal, endorsed with the binding caveat (§6.2)
  from GPT‑5.5.
- Option A over a workflow builder: GPT‑5.5 ("users should think 'this is a
  behavior that sometimes pauses'"), with the versioned‑step invariant (§6.3).

---

## 10. Model selection — layered fallback (delta, 2026‑07‑04)

Status: **locked; new backend + one migration.** This section is a *delta* to the
Behavior-trigger consolidation above; model selection is separate work with its
own schema change.

### The problem
Today "what model runs?" is answered by **four interdependent per‑agent fields** —
`installedProviders` (ordered; `[0]` = primary anchor), `modelSelection`
(auto|pinned), `providerModelPreferences` (per‑provider preferred model), and
legacy `model` — reconciled at turn time by `resolveEffectiveModelRef`
(`gateway/auth/settings/model-selection.ts`). The per‑agent **Providers page**
edits them and doubles as the credential‑connect surface. Four fields for one
question is confusing, and the page is heavy. Meanwhile the org **inference‑providers**
registry (`inference_providers`, #1710) is where infra maps providers — and each
row already carries a per‑modality model at `capabilities.text.model`.

### The model — three optional layers, one chokepoint
Model choice becomes a **fallback chain**, mapped where infra already lives:

- **Infra (org inference‑providers)** — infra maps providers/models; a user marks
  one provider row as the org **default**. Its `capabilities.text.model` is the
  org default model. This is the tail.
- **Agent** — an optional `defaultModel` (a `provider/model` ref, or `auto`).
- **Behavior** (Event/Schedule/Manual) — an optional per‑behavior model.

Resolution: **`behavior.model → agent.defaultModel → org default`.** Nothing is
required at the agent or behavior level; each layer is an optional override of the
one below. This *replaces* the four‑field machinery — `installedProviders` /
`providerModelPreferences` / `modelSelection` / legacy `model` collapse into the
single agent `defaultModel` plus the org tail.

Both worker channels — the run payload (`mergedOptions.model`) and the
session‑context `providerConfig.defaultModel` — already derive from the one
server function `resolveEffectiveModelRef`. So the whole chain is composed there
(agent → org tail) plus a per‑run injection of `behavior.model` at enqueue. This
is the resolver cutover the `TODO(inference-providers): remove after resolver
cutover` marker (`agent-routes.ts`) anticipated.

**Verified channel behavior (E2E, real DB — 2026‑07‑04).** The resolved model
reaches the worker via **Channel 1** (`resolveAgentOptions` → `agentOptions.model`
→ `rawOptions.model`) *unconditionally* — it carries `behavior → agent → org`
regardless of the agent's installed‑provider catalog. **Channel 2**
(`providerConfig.defaultModel` at `/session-context`) only *surfaces* a
`defaultModel` when the agent has a routable installed/synthesized provider
(`getInstalledModules` returns `[]` for an empty catalog → `resolveProviderConfig`
returns `{}`). So the org‑default takes effect through Channel 1; Channel 2 echoes
it only when a provider is installed to route through. Both were driven against a
seeded org default in `worker-session-context-model-fallback.test.ts`.

### The Providers page goes away
The per‑agent Providers page is removed. Its **model‑selection** half is deleted;
its **credential‑connect** half (OAuth / API‑key — already org‑scoped after #1715)
relocates to a Credentials surface. The API surface consolidates: the fused
`PATCH /:agentId/config` splits so credentials and the lone `defaultModel` write
are distinct, and the dead `installProvider`/`uninstallProvider`/`reorderProviders`
catalog methods are removed.

### Decisions & their basis
- **`auto` survives** as a valid value at every layer — it means "newest live
  model for this provider" (Claude auto‑tracks the newest release via the OAuth
  module's live model list). Dropping it would force a manual re‑pick on every
  model release; the resolution logic already exists.
- **Org default = a flagged provider row** (`inference_providers.is_default`, one
  live default per org), not a new `org_settings.defaultModel` string. It reuses
  the per‑modality `model` field the row already has and adds no new table. An
  explicit org‑settings model ref was considered and deferred as heavier.
- **Behavior override storage** is `watchers.execution_config.model` for every
  activation kind. Chat, connector event, schedule, and manual dispatch share
  the same model-resolution layer.

### Fail‑closed tail
Today an unresolved model **hard‑throws** ("No model selected… Providers
settings") — there is no default tail. The org default becomes that tail; the
throw remains only when the org itself has no default, with an updated message
(the Providers page it names no longer exists).
