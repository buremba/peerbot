# Agent Model — Behaviors, Surfaces, Workflows

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

One list. Each row is a sentence + a **kind badge**:

- **Listen** — a chat channel. Real‑time. (was Reach)
- **Watch** — a data feed; new items match a rule, evaluated incrementally. (was Watchers)
- **Schedule** — a clock / cron. (was Schedules)

The three kinds keep distinct constructors and empty‑states — a subscription, an
incremental query, and a clock invocation are genuinely different underneath;
the shared sentence is a *summary*, not a claim they're identical.

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

## 3. Backend mapping (reuse‑heavy)

The consolidation is **~80% frontend** over existing APIs; two runtimes and three
tables stay.

- **Behaviors** = a read/dispatch view over `agent_channel_bindings` (Listen) +
  `watchers` (Watch) + `scheduled_jobs` (Schedule). No new source table.
- **Two runtimes (the event detectors — never the agent's job):**
  - realtime chat handler → invokes the agent on a message (Listen).
  - cron due‑scanner → invokes the agent when a Watch/Schedule is due.
- **Watch is cron‑paced + incremental — near‑real‑time by design.** It ticks on
  its schedule (not on data arrival); each run only sees new data since the last
  window (`window_start..window_end`). Near‑real‑time is a *feature*: multiple
  new items in a window are **batched into one reaction** (5 P0s → one triage
  post), which is cheaper and less noisy than 5 real‑time firings. Real‑time is
  reserved for chat (Listen).
  - **Skip‑if‑empty (opt):** each tick runs the source/filter query bounded to
    the window; if **no new matching events**, it **skips** — no run, no agent
    call. Only non‑empty windows spawn the reaction. Falls out of the kind:
    *Watch* skips‑if‑empty; *Schedule* always runs (a digest fires on a quiet
    day too). Also keeps **Runs** to real firings, not empty ticks. Backend: a
    pre‑dispatch `EXISTS` gate in the materialize path + advance the window on a
    skipped tick. (`@refs` already compile to the query this gate reuses.)
  - "On arrival" (event‑driven dispatch, sub‑cadence) is **deferred** — we don't
    need real‑time for data.
- **Runs / Activity** = `events(semantic_type='notification')` ⋈
  `notification_targets(event_id, user_id)`. Append stream; exhaust.
- **Surfaces** = a *keyed* event, updated by **upsert‑via‑supersede**
  (`supersedes_event_id`; `current_event_records` masks superseded rows).
  Incremental‑in (window cursor) → upsert‑out (rewrite the board). Distinct from
  Runs (append). No new table.
- **Chat replies** = `channel_messages` (the conversation transcript), separate
  from the events spine.

New backend for the base model: proactive‑chat + first‑class silent outcome on
the chat handler; approval wiring (mostly exists); webhook→feed (so external
push sources become queryable events).

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
  the per‑run token (`BUILDER_ADMIN_TOOLS` / `resolveBuilderAdminTools`).
- **Event waits** → a detector (Watch cron tick / ingest) resumes the **suspended
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
- **Real‑time (event‑driven) Watch dispatch** — Watch stays cron‑paced (~1 min);
  real‑time is chat‑only.
- Least‑privilege scoping of the self‑wake capability (hardening follow‑up).

---

## 8b. Surface change summary — API / MCP / backend

**The consolidation itself needs no new MCP tool, no API change, no new engine.**
The Behaviors / Surfaces / Runs / Persona tabs are a frontend re‑presentation over
what exists:
- list = the existing `channel-bindings`, `manage_watchers` (list), and
  `manage_schedules` (list) APIs, merged client‑side;
- create/edit = dispatch to the existing `bind_channel` / `manage_watchers` /
  `manage_schedules` writers;
- Surfaces/Runs = reads over `events` + `notification_targets`;
- Watch editor = the existing watcher builder (incl. `@refs` from #1655);
- self‑wake for workflows = a **capability grant flip** (`manage_schedules` is
  already grantable via the per‑run token), not a new tool.

So Phase 1 ships with **zero backend / API / MCP change**.

The **new capabilities** each need a small, targeted backend change — none is a
new MCP tool or a new engine:

| capability | backend change | new MCP tool? |
|---|---|---|
| proactive + silent chat | wake agent on non‑mention; first‑class "no reply" (chat handler) | no |
| skip‑if‑empty | pre‑dispatch `EXISTS` gate in the watcher materialize path | no |
| webhook → feed | materialize a webhook connection as a feed | no |
| maintained Surfaces | upsert‑via‑supersede write path | no |
| proactivity | one structured field (persona default + per‑behavior override) | no |
| workflow event‑wait | the WAIT resume‑subscription (§5) + event→run correlation | no |
| workflow safety | idempotency on terminal actions + approval binding (§6) | no |

No new admin/MCP tool is introduced; writes reuse `manage_watchers` /
`bind_channel` / `manage_schedules`.

## 9. Build phases

1. **Frontend consolidation** — the Behaviors + Surfaces + Runs + Persona tabs
   over existing APIs (bindings / watchers / schedules / events). No backend.
2. **Proactive + silent chat** — wake the agent on non‑mention messages in
   opted‑in channels; make "no reply" a first‑class, logged outcome; inject the
   proactivity policy into the turn.
3. **Surfaces** — the upsert‑via‑supersede path for a maintained board.
4. **Webhook → feed** — external push sources become queryable events.
5. **Workflows** — enable self‑wake + watcher‑resume; implement the WAIT
   resume‑subscription (§5) and the safety guarantees (§6).
6. **(deferred)** disable toggles, branching builder, autonomous goals.

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
consolidation above — the consolidation itself was zero‑migration; model
selection is separate work with its own schema change.

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
- **Behavior** (Listen/Watch/Schedule) — an optional per‑behavior model.

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
- **Behavior override storage** rides existing surfaces where possible: Watch
  reuses the dormant `watchers.model_config`; Schedule rides
  `scheduled_jobs.action_args`; Listen needs a new `agent_channel_bindings.model`
  column (it has no config blob today).

### Fail‑closed tail
Today an unresolved model **hard‑throws** ("No model selected… Providers
settings") — there is no default tail. The org default becomes that tail; the
throw remains only when the org itself has no default, with an updated message
(the Providers page it names no longer exists).
