---
name: crm-ops
description: How to operate the Lobu funnel CRM — create and enrich leads, log interactions, advance funnel stages, open and update pilots, and produce the weekly digest. Use whenever the task touches the pipeline.
---

# CRM operations

The CRM lives in Lobu memory. Two entity types — `lead` and `pilot` — hold current state; events of type `lead:*` / `pilot:*` are the append-only history. The `converted-to` relationship links a `lead` to the `pilot` it became.

## Funnel stages (the `stage` field on `lead`)

`signal` → `trial` → `conversation` → `pilot` → `customer`, plus `cold` (went quiet / not a fit). "Reach" (an impression, a passing tweet view) is not a stage — no lead record until there's a signal.

| Stage | Enter it when… |
|---|---|
| `signal` | starred the repo, followed on X, @-mentioned Lobu, commented on an issue |
| `trial` | cloned / ran `lobu run` / completed the quickstart / asked a real deployment question |
| `conversation` | DM'd, requested a demo, booked a call, said "we want to deploy this" |
| `pilot` | signed up for a paid pilot — open a `pilot` entity, link with `converted-to` |
| `customer` | converted from pilot to a paid contract |
| `cold` | three touches with no response, or explicitly not a fit |

## Creating / enriching a lead

1. **Search first** — `search_memory({query: "<github handle | x handle | email | company>"})`. If a `lead` exists, enrich it; don't duplicate.
2. If new: create the `lead` entity with metadata `{name, company, source, stage, github_handle, x_handle, email, notes}`. Set `stage` to the lowest stage the evidence supports.
3. `save_memory({content: "<who, company, source>", semantic_type: "lead:created", entity_ids: [<lead>, <source connector event>]})`.

## Logging an interaction

After any touchpoint (a meeting Burak had, a DM exchange, an issue reply you drafted):
`save_memory({content: "{type, summary, next_action, date}", semantic_type: "lead:interaction", entity_ids: [<lead>]})`. Update the lead's `notes` / `stage` if the touch moved it (see "advancing a stage").

## Advancing a stage

1. `save_memory({content: "{from, to, reason}", semantic_type: "lead:stage_changed", entity_ids: [<lead>]})`.
2. Update the `lead` entity's `stage` field.
Never change `stage` without the matching event.

## Opening / updating a pilot

- Open: create a `pilot` entity `{company, seats, mrr, status: "active", start_date, success_metric, lead_id}`; `converted-to` relationship from the lead; `save_memory({..., semantic_type: "pilot:created", entity_ids: [<pilot>, <lead>]})`; move the lead to `pilot`.
- Update: `save_memory({content: "{from, to, note}", semantic_type: "pilot:status_changed", entity_ids: [<pilot>]})`; update the entity's `status` (`active` → `won` | `lost` | `paused`); if `won`, move the lead to `customer`.

## Reads the operator asks for

- **"who starred us this week and isn't tracked?"** — pull recent `stargazer` events (github connector), diff against `lead` entities with a `github_handle`, return the gap.
- **"show the pipeline"** — `lead` entities grouped by `stage`, each with last-touch date and next action, ranked within stage by closeness-to-pilot.
- **"state of the <company> pilot?"** — the `pilot` entity + its `pilot:*` events, newest first.

## Weekly digest (used by the funnel-digest watcher)

A Slack message, in this shape — keep it short:
1. **One line at the top: the single recommended action this week.**
2. Funnel snapshot: counts per stage, and what moved (new leads, stage changes, new/updated pilots).
3. Top-of-funnel: stars / X mentions / HN+PH activity since last digest.
4. Stale leads: anyone in `conversation` with no touch in 7+ days — flag for follow-up.
5. Gaps: e.g. "12 new stars, 0 became leads — are we capturing the right signal?"

Always end with the next action, never just the status.
