# Design: one primitive for agent-emitted UI (chips, cards, progress blocks)

Status: **parked** — written while landing starter chips (`feat/suggested-actions`), before
building progress blocks. Nothing here is implemented. Read §2 before adding the *next*
agent-emitted element; the point of this doc is that the next one should not be hand-rolled.

Scope: plugin-conversations + server (gateway routes, history replay) + owletto renderer.

## 1. Goal

Today every "the agent emits something the client renders as a component, not prose" feature
hand-wires some or all of five layers: a plugin tool → an internal POST route → an SSE kind →
a renderer branch → a history-replay branch. The three current elements take different
subsets of that path, and progress blocks would add another bespoke variant.

Goal: **one substrate** so element #4 is a payload schema plus a renderer, not five files
across three packages.

Non-goal: replacing interaction *semantics*. Approvals gate execution and carry
accept/reject; suggestions do not. This is about the transport, persistence and replay
plumbing they share — not collapsing their meanings.

## 2. Current state (ground truth)

Three elements exist today, each hand-rolled:

| element | plugin tool | emit route | persistence | SSE kind | replay |
|---|---|---|---|---|---|
| approval card | (server-side) | `/internal/interactions/create` | `events.interaction_type='approval'` | `tool-approval` | `agent-history.ts` |
| question | `ask_user` | `/internal/interactions/create` | none | `question` | — |
| suggestion chips | `suggest_actions` | `/internal/suggestions/create` | `events.interaction_type='suggestion'` | on `complete` payload | `agent-history.ts` |

Load-bearing facts:

- **`events` already IS the durable substrate.** `interaction_type ∈ {none, approval,
  suggestion}` with `interaction_status`, `interaction_input`, `interaction_output`, and
  explicit supersession between event rows. Stable `origin_id` values identify an
  interaction stream; the suggestion writer serializes and supplies `supersedesEventId`
  itself because API conversations have no numeric `connection_id`. Adding an element type
  today is a CHECK-constraint migration
  (`20260724010000_events_interaction_suggestion.sql` did exactly that for `suggestion`).
- **The renderer is an `if/else` chain** on `env.kind` in `lobu-chat-store.tsx`, covering
  `output`, `status`, `complete`, `closed`, `error`, `agent-error`, `question`, `tool_use`,
  `link-button`, and `tool-approval`. Each new element appends a branch.
- **Two emit routes already diverge** for no real reason: `suggest_actions` posts to
  `/internal/suggestions/create` while `ask_user` posts to `/internal/interactions/create`.
  That split is historical, not principled.
- **History replay is per-type.** `agent-history.ts` carries a discriminated union
  (`ToolApprovalHistoryInteraction`, `SuggestionHistoryInteraction`, …); each replayed
  element adds a member and its own lookup.
- **Delivery timing differs and this is the one real axis.** Suggestions ride the terminal
  `complete` payload because that branch returns from the stream loop and the `finally`
  closes the EventSource — a separate post-complete card cannot arrive live. Progress
  blocks are the opposite: many mid-turn updates, nothing at the end.

## 3. The trap this doc exists to prevent

Progress blocks (grouped tool calls with human labels + status, as in ChatGPT/Claude UIs)
look like a new feature but reuse much of the same plumbing. Built the current way they would
add another emit payload or route, another SSE branch, and another replay shape if persisted
— plus a *second* independent notion of "structured thing attached to a turn" that will drift
from the first.

The specific duplication risk is **`tool_use`**. It already streams mid-turn and already has
a renderer branch in `lobu-chat-store.tsx`. Progress blocks are largely *grouping and
labelling of `tool_use` events*, not a new event stream. Building them as a parallel channel
would mean two sources of truth for "what the agent did during this turn".

## 4. Proposed shape

### 4.1 One emit path

Collapse to a single internal route (`/internal/interactions/create`) taking
`{ kind, payload, lifetime }`. Retire `/internal/suggestions/create`. `kind` maps to
`events.interaction_type`; adding an element is a CHECK migration + a payload schema, as
today, but with no new route.

### 4.2 Declare delivery, don't hand-wire it

Each kind declares a `lifetime`:

- `terminal` — resolved at completion, embedded on the `complete` payload (chips today).
- `streaming` — emitted mid-turn, superseded in place by `origin_id` (progress blocks).
- `durable` — outlives the turn, replayed until resolved (approvals).

Delivery is then a property of the kind, not bespoke code per element. This is the piece that
would have saved the most work on chips: the terminal-vs-post-complete race
(`api/platform.ts` unawaited `queue.send`) cost a full redesign round and is a *general*
problem every future element hits.

### 4.3 One renderer registry

Replace the `env.kind` if/else with a map from kind → component. Adding an element becomes
one registry entry. The union in `agent-history.ts` collapses to
`{ kind, payload }` with per-kind parsing at the edge.

### 4.4 Progress blocks specifically

Build on `tool_use`, do not parallel it. A `progress_group` is a labelled span over tool
calls already streaming. Open question worth deciding before building: **where do labels come
from?** Model-supplied reads better ("Reading most recent prior chat") but costs tokens and
can drift from what the call did; derived-from-tool-name is free but generic. A hybrid —
model supplies a label when it opens a group, tool names fill in otherwise — is probably
right but is a product call, not an architecture one.

## 5. Migration path (if this is picked up)

Strictly incremental; no big-bang rewrite:

1. Land the renderer registry behind the existing branches (no behaviour change, pure refactor).
2. Move `suggest_actions` onto the unified route; delete `/internal/suggestions/create`.
3. Add `lifetime` and express chips/approvals in terms of it — the two existing shapes must
   fall out of the model, or the model is wrong.
4. Only then build progress blocks as the first element authored *on* the substrate. It is
   the proof the abstraction holds; if step 4 needs new plumbing, steps 1–3 were premature.

## 6. Why parked

The substrate is worth building **only when there is a second streaming consumer**. Right now
progress blocks are the sole candidate, and one instance is not a pattern — generalising from
it risks an abstraction shaped like a single feature. Two rules of thumb:

- If progress blocks are built and a *third* element is proposed, build the substrate first.
- If progress blocks are built the current way, budget for the refactor rather than pretending
  another `env.kind` branch is free.

The cheap insurance meanwhile: when adding a durable element #4, put its payload on
`events.interaction_type` (do not invent side storage), give it a stable `origin_id`, and
link replacement rows through the existing supersession fields. Those choices are what make
a later consolidation mechanical rather than a rewrite.

## 7. Prior art to check before building

The starter-chip work turned up three constraints any element must satisfy — all learned the
hard way, all still true:

- **Live vs reload render from different sources.** Live comes off the SSE echo; reload
  replays the stored transcript. A block that renders correctly while streaming can be wrong
  after refresh (this produced a visible bug: the worker's `## This conversation` scaffolding
  showed above every user message on reload — fixed in `stripRunContextBlock`, core
  `session-file.ts`).
- **Unattended turns must not gain capability.** Anything that dispatches a hidden turn goes
  through `UNATTENDED_SOURCES` (agent-worker `plugin-composition.ts`): read-only MCP tools
  only, no conversation mutation, no memory capture. `toolsConfig.allowedTools` does NOT
  cover plugin/MCP tools — it gates built-ins only.
- **`events` is append-only.** Append a superseding event linked to the prior row; never
  DELETE.
