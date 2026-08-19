# Make chat a render surface for `json_template`

## Thesis, in the codebase's own words

`utils/default-entity-template.ts:127` — on `resolveEntityRender`:

> Every render surface reuses this so a type renders identically everywhere:
> entity detail (`resolve_path`) and event render (`get_content`).

Chat is a render surface that does not reuse it. That is the whole bug. The
symptom the user hit — a connector approval arriving in Slack as *`Action "run"
needs approval`* with no operation, no input, no affordance — is one instance.

## What already exists (do not rebuild)

Almost all of this plan is wiring, not new machinery:

| Need | Already there |
|---|---|
| Template resolution | `resolveEventKindDefinition` (`utils/event-kind-validation.ts:312`) + `resolveEntityRender` (`utils/default-entity-template.ts:133`) |
| The resolve-and-bind tail | `tools/get_content/render.ts:369-386` — 15 lines, already handles the notification branch (`isNotification ? payload_data : metadata`) |
| Notification carrying template data | `CreateNotificationParams.semanticType` + `.payloadData` (`notifications/service.ts:33-35`), persisted at `:641-643` |
| Public authoring surface | `notify`'s `semantic_type` + `data` args (`tools/admin/notify.ts:80,87`) |
| Format vocabulary | `VALUE_FORMATS` (`utils/validate-json-template.ts:23`) — already contracted to stay in sync with owletto |
| Default template for un-authored kinds | `buildDefaultEntityTemplate` — emits exactly `card > card-content > table > tbody > tr > (th > text, td > data)` |

**No new table, API, or SDK surface.** The notification path can already carry
template data end to end. The only thing missing is that chat delivery ignores it.

## The one missing line

`notifications/service.ts:459`, in `deliverToBotConnections`:

```ts
const content = params.card ? { card: params.card } : { markdown: text };
```

`params.card` or plain text. `payloadData` and the kind's `jsonTemplate` are
never consulted. Meanwhile `service.ts:603` persists the card into
`metadata.card` with a comment claiming "the card IS the notification's
rendered form" — but nothing on web or MCP apps reads `metadata.card`.

So today an author who wants a notification to look right everywhere must write
the content **twice**: `data` for web/MCP, `card` for chat. That duplication is
what to consolidate away.

## Why "render any json_template in chat" is the wrong goal

`validate-json-template.ts:11-16` is explicit that the node vocabulary is open:

> it does NOT allowlist component `type` strings. The renderer's component set
> is extended app-side (entity-board, entity-table, charts, …) which the server
> can't know.

Only **four** node types are structural and server-known: `text`, `data`, `if`,
`each`. Everything else is an app-side React component, and the set includes
charts and entity boards. Those cannot become Block Kit, ever. Chasing general
fidelity means porting a 659-line React renderer against a vocabulary that is
by design not enumerable.

Chasing the *structural* subset instead is small and total:

- the 4 structural nodes are closed and defined server-side already;
- the default template only ever emits 9 layout components;
- an unknown component can be skipped without breaking the render.

On that last point, note a **deliberate divergence**: owletto drops an unknown
component outright — `renderer.tsx:532-535` warns and returns `null`, discarding
its children. For chat, render the children and drop only the wrapper. A chart
node's children are typically a title or textual fallback, and keeping them
turns "chart omitted" into a line of useful text. Worth confirming with owletto
whether it should adopt the same behaviour; until then this is a divergence to
state, not a match to claim.

## Plan

### Step 1 — extract the shared resolve-and-bind (pure refactor, no behaviour change)
Lift `get_content/render.ts:369-386` into a helper (`utils/resolve-render-template.ts`)
taking `(semanticType, organizationId, payloadData, entityIds?)` and returning
`{ root, data } | null`. `render.ts` calls it; nothing else changes yet.

Guard: existing `get_content` render tests must pass untouched.

### Step 2 — `json_template` → `CardElement`
New `notifications/template-card.ts`. Handles:

- `text` → literal text
- `data` → resolve path against data, format via the existing `VALUE_FORMATS`
  set (`url` → `CardLink`, everything else → text), honouring `fallback`
- `if` → evaluate condition, take branch
- `each` → repeat `render` per item; string shorthand supported
- `table`/`tbody`/`tr`/`th`/`td` → chat `Table` (this is the default template's
  entire shape, so un-authored kinds work for free)
- `card`/`card-content`/`card-header`/`card-title` → `Card`/`Section`
- `h1`–`h4`, `p`, `span`, `div`, `ul`/`ol`/`li`, `badge` → `Section`/`Text`
- **anything else** → render its children, drop the wrapper (see the
  divergence noted above)

Not handled, deliberately: `Actions`/`Button`. Affordance is not a template
concern (see Step 4).

Tests: one per structural node; one asserting the default-entity-template shape
produces a populated `Table`; one asserting an unknown component (`chart`)
yields its children rather than throwing or emitting an empty card.

### Step 3 — wire chat, and collapse the dual authoring
In `deliverToBotConnections`, replace the line above with:

1. explicit `params.card` still wins (already documented as such at `notify.ts:93`);
2. else if `semanticType` + `payloadData` resolve a template via Step 1 → Step 2's card;
3. else markdown text, as today.

Then give the connector-approval notification a `semanticType` + `payloadData`
(operation key, connection name, `action_input`) in `notifyActionApprovalNeeded`,
and author that kind's `jsonTemplate`. The Slack message then shows what the
operation would actually do — because the template says so, not because a
connector branch hardcodes it.

Finally delete `buildActionApprovalCard`'s hand-built branches as each gains a
template. No shims, no both-paths period.

Verification: the motivating approval must render its command/repo/title in
Slack, and the same event must render equivalently in the Memory view.

### Step 4 — affordance (separate concern, does not gate 1–3)
Buttons are not a rendering problem and should not ride this change.

- **MCP apps** (recommended): `owletto/src/mcp-apps/interaction/` already renders
  `json_template`. Interactive approval lives there with no new chat-side
  execution surface.
- **Slack**: needs `inputSchema: null` from `notifyActionApprovalNeeded` so
  `decisionOnly` is true, plus widening the `ENTITY_CHANGE_ACTION_KEYS` filter at
  `gateway/connections/interaction-bridge.ts:176`. That filter's own comment says
  connector approval "needs a separate env-safe execution path" — and the owner
  chose one-click approve for all connector ops, `os.shell run` included. Ship it
  knowingly or not at all.

## Risk that looked blocking and is not

`semanticType`'s doc warns the approval path omits it to keep "its `notification`
marker and its separate interaction-event supersede chain". Both hold anyway:

1. Notification identity is row presence in `notification_targets`, not
   `semantic_type` — `utils/content-search/params.ts:8-24` says so and names
   `funnel_digest` as a live notification whose `semantic_type` is its content
   kind. Precedent already in prod.
2. The supersede chain is on a *different event*: the pending approval event
   (`manage_operations/handlers/execute.ts`, `originId run_<id>_pending`) carries
   the interaction fields; `createNotificationForUsers`'s insert passes none.
3. The render tail keys `isNotification` off `metadata.notification_type`, not
   `semantic_type`.

Residual: LOW. Cover (2) with a test that approves a run and asserts the pending
event still supersedes.

## Sequencing
Step 1 is a no-op refactor. Step 2 is pure and unit-testable with no wiring.
Step 3 is the user-visible fix. Step 4 is a product/security decision that must
not gate the first three.
