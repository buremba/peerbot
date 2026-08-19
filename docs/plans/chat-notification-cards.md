# Chat cards for kind-bearing notifications

## Problem

Connector-operation approvals arrived in Slack as bare text:

> Action "run" needs approval
> A queued action on Mac Shell is waiting for your review.

Never *which* operation, on *which* connection, with *what* input — so the
decision could not be made from the notification.

## Why not render `json_template` in chat

The obvious fix is "chat should render the same `json_template` the web app and
MCP apps render". It was the first plan here, and it is wrong.

`validate-json-template.ts:11-16` refuses to allowlist component types:

> The renderer's component set is extended app-side (entity-board,
> entity-table, charts, …) which the server can't know.

Only `text` / `data` / `if` / `each` are structural; the rest is an open,
app-side React vocabulary that has no Block Kit equivalent. A chat-side walker
would be a second renderer that can never be faithful, drifts every time the DSL
grows, and that no visual test covers. A prototype hit three sharp edges within
an hour: `each` nested in a table lost its item scope, Slack's 10-field section
cap silently produced undeliverable messages, and long values needed clamping.

## What chat reads instead

The kind's `metadataSchema` — a closed shape of properties plus annotations.
This is also the common case: `jsonTemplate` is optional and, per its own doc,
"when absent, rendering falls back to a default synthesized from
`metadataSchema`". A kind that DOES author a template usually did so to get a
component chat cannot show, which is exactly when guessing is worse than
linking out.

One rule covers everything chat cannot show — an authored template, fields past
the platform cap, an over-long value: **show what fits and link to the event.**

## What was built

- **`@lobu/core/json-template`** — `formatValue`, `getValueByPath`,
  `VALUE_FORMATS`. Owletto has an identical copy at
  `src/lib/json-renderer/format-value.ts`; a follow-up PR in that repo deletes
  it and imports this, so scalar formatting is one implementation for all three
  surfaces.
- **`orderedSchemaFields`** — extracted from `buildDefaultEntityTemplate` and
  exported. Ordering (`x-table-column`), hiding (`x-hidden`) and labelling
  (`x-table-label` / `title`) are now shared by the web default template and the
  chat card, so they agree by construction rather than by convention.
- **`notifications/template-card.ts`** — `buildKindCard`: schema fields →
  `Fields`, capped at 10 and clamped to 1800 chars, plus an "Open in Lobu"
  `CardLink`. Declines (returns null → markdown body) when the kind authored a
  `jsonTemplate` or the schema has no usable fields.
- **`utils/platform-event-kinds.ts`** — kinds the platform emits, consulted as
  the LAST resort in `resolveEventKindDefinition` so an org declaring the same
  slug still wins. Holds `connector_operation_approval` (operation, connection,
  input) as a `metadataSchema` only.
- **Wiring** — `service.ts` builds the card from the kind when the caller passed
  no explicit `card`; `triggers.ts` gives connector-operation approvals that
  semantic type + payload; `execute.ts` passes the operation name and input.

Because the kind is resolved the normal way, the Memory view and MCP apps pick
up the same approval rendering with no extra work.

## Does the approval use `json_template`?

Not in chat. The two surfaces build the same content two different ways:

- **web / MCP** — the kind declares no `jsonTemplate`, so `resolveEntityRender`
  synthesizes one from `metadataSchema` and the event ships as
  `payload_type: 'json_template'`.
- **chat** — `buildKindCard` reads `metadataSchema` straight into `Fields`; no
  template is ever constructed.

They agree because both go through `orderedSchemaFields` and format values with
the shared `formatValue`, not by coincidence — `template-card.test.ts` pins it.

The deliberate divergence: if a kind DOES author a `jsonTemplate`, web renders
that design and chat declines to markdown + link.

## Slack output

```
Action "run" needs approval
A queued action on Mac Shell is waiting for your review.

Operation    Run shell command
Connection   Mac Shell
Input        Command: git status --porcelain; Cwd: /Users/burakemre/Code/lobu

Open in Lobu
```

## Not done

Decision buttons. They are a separate concern from rendering: Slack buttons need
`inputSchema: null` from `notifyActionApprovalNeeded` plus widening the
`ENTITY_CHANGE_ACTION_KEYS` filter at `interaction-bridge.ts:176`, whose comment
says connector approval "needs a separate env-safe execution path". One-click
approve for `os.shell run` from Slack is a security decision, not a formatting
one, and must not ride this change.
