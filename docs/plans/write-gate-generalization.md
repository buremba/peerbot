# Write-gate generalization — policy for every governed write

> **Related:** the read-side ACL program → [`authz-acl-permission-program.md`](authz-acl-permission-program.md)
> (who can *see* what). This doc is the **write** side (who/what may *change* what).
> Connector authz backbone → [`connector-authz-model.md`](connector-authz-model.md).

**Status: FINALIZED — decisions locked via interview; reviewed independently by
Codex + Fable (12 correctness fixes folded in, cited inline). Extends the shipped
entity-approval system (#1802); does NOT introduce a policy engine (Cedar was
spiked and dropped, #1802 — the TS interceptor IS our policy-as-code).**

Most of this system already exists. The shipped surface is ~1,640 LOC: the mutation
gate, the interceptor chain, the entity approval flow (propose→approve→apply), the
connector action-approval path, and `manage_agents`' own propose/apply path. What is
missing is **generalization plumbing + one new scope axis (principal) + the UI**.
This RFC scopes that as **three small, independently-reviewable PRs**, then a roadmap.

## 0. The requirement
Admins governing an org must be able to say, for any governed write — adding an
entity, changing a schema, adding an entity type, creating an agent/watcher/schedule,
installing a connector, running a connector action — whether it **commits**, **needs
human approval**, or is **denied**; and to scope that decision by resource type and by
**which principal** (a specific agent or watcher) is acting. Humans are governed by
role (a code manifest), not by this policy surface.

## 1. Locked decisions
1. **Effects**: `auto | approval | deny` for all classes; `disabled` additionally for
   connector-action execution only.
2. **Roles stay CODE** — a `WRITE_ACTION_MANIFEST` (`tool.action → {resourceClass,
   role floor}`) that `tool-access.ts` consumes; a coverage test asserts every write
   action is classified. NO `role_permissions` table until custom roles are requested.
   The role floor is a **safety floor**: if role says deny, policy cannot override.
3. **Users are never gated by policy** — the `principalKind==="user" → allow`
   invariant (`entity-policy.ts:243,270`) stays. No user-principal policy rows.
4. **Agents & watchers ARE principals** — policy may target `principal_kind`
   (agent|watcher) + optional `principal_id`. NULL = any. This is the newly-requested
   capability: "watcher #6 may auto-create person entities; every other agent needs
   approval."
5. **Per-principal policy is an effect SELECTOR, not a grant.** Enforcement order:
   `hard invariants > org/resource ownership > role/MCP/capability floor > write-policy
   winner > approval/apply staleness`. "Agent X may install connectors" means "IF X
   legitimately reaches the write path, this effect applies" — never a bypass of the
   capability floor. (Codex + Fable.)
6. **One policy table**, typed scope kinds per resource class (a code map declares
   which kinds are legal per class; the DB never assumes every class supports every
   scope). Narrowest match wins.
7. **Two enforcement moments, one policy authority (the hooks).** Durable
   propose→approve for config/data writes; synchronous decision for connector-action
   execution (a live run pauses — nothing to re-apply later). Both read one table.
8. **Command adapter for apply-on-approve**, per class: `WriteCommandAdapter{ prepare,
   apply, isStale, describe }`. Approve calls `adapter.apply(prepared)` — NEVER a raw
   re-dispatch. (Codex.)
9. **Tie-break = restrictive-wins** (`deny > approval > auto`), not oldest-row. (Fable.)
10. **v1 scopes = entity_type + principal ONLY.** Row (`entity_id`) and field
    (`field_path`) scopes DEFER to v1.1 — they are redundant with the predicate feature
    that lands then, and each carries cost v1 need not pay (entity_id = FK cascade;
    field_path = per-field decision folding). **Field OWNERSHIP is unaffected** — the
    `field_controls` human-ownership guardrail (`entity-policy.ts:278`) is a hard
    invariant above policy, not a field-scoped policy row; it survives v1 untouched.

## 2. What already exists (verified)
- `authz/entity-mutation-gate.ts` (230 LOC): pluggable interceptor pipeline;
  `runMutationGate()` folds decisions (deny wins; first defer short-circuits; per-field
  approval sets union for updates). `registerMutationInterceptor()` seam (no external
  callers yet).
- `authz/approval-interceptor.ts` (224) + `authz/entity-policy.ts` (446): the ONE
  registered interceptor, over `entity_approval_policies`; scope specificity
  `entity_id(4) > field_path(2) > entity_type(1)`.
- `tools/admin/entity-field-approval.ts` (673): durable propose→approve→apply for
  entities, with per-field staleness (`:575-617`).
- `tools/admin/manage_agents.ts`: SECOND propose/apply path already built
  (`buildProposal` → `runs.action_input` → `applyManageAgents*`) — but **no `isStale`**
  (`applyUpdate` blindly overwrites, `:184-192`).
- `operations/action-modes.ts` (69): connector action policy — `resolveActionMode`
  over `connection.config.action_modes` → disabled|approval|auto. Approval ENFORCEMENT
  already shared: `manage_operations.ts:681` creates a `runs` row
  (`approvalMode:"queued"`) + `:732` an `interaction_type:'approval'` event — same
  primitive as entities.
- UI: `organization-settings-page.tsx` "Agent change approvals" (entity-only, real API
  `/api/:org/entity-approval-policy`). Approve/reject inbox = generic Events-tab card,
  already works for any `runs` row.

Conclusion: the mechanism is done. Missing = generalization columns, `agentId`
threading (3 call sites), the principal axis, and the UI.

## 3. Correctness fixes from review (folded in)
- `agentId` is NOT on `EntityMutationRequest` today (only on an internal
  classification helper, `entity-policy.ts:139`). Per-principal needs it threaded
  through the request + `manage_entity` / `promote-keyed-entities` /
  `entity-management` call sites. (Codex + Fable.)
- The COALESCE natural-key unique index + upsert-with-race-retry
  (`entity-policy.ts:357-421`, migration `:24-30`) cannot extend to new columns
  cleanly → **Migration 1 moves to id-based CRUD** + a new unique index. (Fable.)
- Generic `scope_value text` loses the `entity_id` FK cascade → keep a typed side
  column for FK-able scope kinds, or add explicit cleanup. (Fable.) *(Moot in v1 since
  entity_id scope is deferred, but relevant when it returns.)*
- Delivery-target inheritance assumes exactly one global row
  (`entity-policy.ts:196-209`) → define the inheritance chain per class or scoped
  approvals silently fall back to generic admin fan-out. (Fable.)
- `manage_agents` currently queues approval **unconditionally for everyone incl. human
  admins** (`:497-507`). **RESOLVED: human admin agent edits apply immediately** (drop
  the human-gating); agent/watcher-authored changes follow policy. Note as an
  intentional behavior change in the PR. (Fable-flagged.)
- Adapter extraction is real work: the agent adapter's `isStale` must be BUILT.
- Code-API naming: separate `target_scope_*` from `principal_*` even if physical
  columns are generic — don't call both "scope". (Codex.)

## 4. Schema (columns added to entity_approval_policies; renamed to write_approval_policies in the LATER contract PR — see §6e.1)
```
id, organization_id,
resource_class     text NOT NULL,   -- entity | entity_type | agent | watcher | schedule
                                    --   | feed | classifier | connector | connector_action
target_scope_kind  text NOT NULL,   -- v1: global | entity_type  (per-class equivalents)
                                    --   v1.1+: field_path | entity_id | entity_predicate
                                    --   later: connection_id | connector_slug | connection_op
target_scope_value text NULL,
predicate          jsonb NULL,       -- RESERVED in v1 (unused); populated in v1.1
principal_kind     text NULL,        -- agent | watcher ; NULL = any
principal_id       text NULL,        -- specific agent/watcher id ; NULL = any of kind
create_mode/update_mode/delete_mode text
   CHECK (... IN ('auto','approval','deny'))          -- 'disabled' only for connector_action
approval_connection_id/channel_id/team_id/channel_name,
created_at, updated_at
UNIQUE (organization_id, resource_class, target_scope_kind,
        COALESCE(target_scope_value,''), COALESCE(principal_kind,''),
        COALESCE(principal_id,''))
```
Resolution: load candidate rows for `(org, resource_class)` matching scope + principal;
sort by `(scope_specificity desc, principal_specificity desc)`; ties → restrictive-wins
(`deny > approval > auto`). Hard invariants (cross-org, field-ownership) sit above
policy, unconditionally.

## 5. Implementation — ONE v1 PR, stacked commits (DECIDED)
**v1 ships as a single PR** so it's usable end-to-end at merge (no backend-without-UI
half-state) — INCLUDING batched approvals (§6b). Reviewability comes from clean stacked
commits read in order, NOT from separate PRs:
1. `M1a expand (additive columns, deploy-safe) + principal identity plumbing` — agent AND
   watcher ids threaded; NO rename, NO column drop (§6e.1). No behavior change.
2. `M1b cutover + per-principal resolver + additive API + tests` — new code reads new
   columns; backfill verbatim-move; scope-keyed API gains resource_class/principal_* additively
   (§6e.2); resolver understands deny before CHECK admits it (§6f R5).
3. `manage_agents as a governed class` (backend: gate wiring + isStale + human-immediate) —
   BEFORE the UI so the Agents tab has real backend (fixes Codex gap #2).
4. `run change-set first-class (windowId on runs.window_id column) + batched approvals +
   conversational revision (revision rewrites run+event+card)` (§6b/§6c/§6e.3/§6f).
5. `UI: class tabs (Entities+Agents) + principal picker + run-diff view + batch card`.
- **Follow-up PR (post-rollout): M1c contract** — rename table → write_approval_policies,
  drop old scope columns (§6e.1). NOT in the v1 PR.

The sub-sections below detail each commit's content.

### Commit-level content (was: three small PRs)

**Commit 1 — M1a expand + principal plumbing (refactor, NO behavior change).**
M1a (deploy-safe, additive): ADD `resource_class DEFAULT 'entity'`, `target_scope_*`,
`principal_*`, `predicate jsonb NULL` columns to the EXISTING `entity_approval_policies`
table; widen mode CHECK. **No rename, no column drop** — old pods keep working (§6e.1).
Thread principal identity (agent → agentId, watcher → watcherId, system → NULL; §6d.1)
through the gate request + the 3 call sites (`manage_entity`, `promote-keyed-entities`,
`entity-management`). Behavior identical (defaults preserve today's decisions).

**Commit 2 — per-principal policy for entities (the new capability; backend + tests).**
Resolver consumes `principal_kind`/`principal_id`; add the second specificity axis +
restrictive-wins. Prove red→fix→green: watcher #N auto-allowed while other agents gated;
tie-break; users never gated; field-ownership approval still fires (regression guard).

**Commit 3 — batched approvals + conversational revision (§6b).**
Group proposals by `window_id` into one parent `runs` row + child proposals; batch card
data; approve-all / reject-all; the in-place child-proposal update operation for the
conversational-revision loop; reject-with-reason re-dispatch. Backend + tests.

**Commit 4 — UI (frontend).**
`organization-settings-page.tsx`: resource-class tab strip (Entities + Agents) + a
principal picker beside the type picker; generalize `useEntityApprovalPolicy` →
`useWriteApprovalPolicy(resourceClass)`; widen the effect type. Batch approval card
(collapsible list reusing the existing before→after diff renderer,
`event-card.tsx:524-542`). NO predicate builder, NO connector reflection page.

**Commit 5 — `manage_agents` as a governed class.**
Wire `manage_agents` through the generalized gate; build its `isStale`; implement the
human-admin-immediate behavior change (drop today's unconditional-approval for humans).
Carries the one intentional behavior change — kept as its own commit for a clean review.

## 6. Roadmap after v1
- **v1.1 — granular scopes**: predicate DSL (flat AND-only `{field, op, value}`, no
  OR/nesting; eval = **pre-image ∨ post-image** — Fable: merged-only is bypassable;
  create=proposal, delete=current; `$`-path field addressing) + evaluator + contract +
  builder UI. Thread current/patch values into the gate. Row scope = `{$id eq N}`; field
  scope via field-path predicates (or reinstate `field_path` scope if per-field union is
  cleaner). **Note: the entity-filter DSL does NOT exist today (Fable, verified) — this
  is net-new, which is why it's deferred.**
- **v1.2 — more classes**: watcher · schedule · feed · classifier.
- **LAST — connectors + connector-action consolidation**: add the `connector_action`
  class; `resolveActionMode` stops reading `connection.config.action_modes`, asks the
  same policy resolver (the hooks become the single decision authority); migrate the
  blob → scoped rows (migration 2). Ships last because it's a sync→async refactor on the
  hot tool-list-filtering path (`connector-operations.ts:577`) + credential-replay
  staleness. **Architecture unified day one** (the class is first-class in the table);
  only the refactor is deferred.
- **Enterprise (Snowflake-informed)**: privileges-to-roles-not-users (already our
  model); design the manifest **hierarchy-ready** (a role can include another) for
  custom roles; extend `field_controls` ownership to **object ownership** on the
  principal axis; name our type-scope as **future-grants** ("policy applies to objects
  that don't exist yet"). **ADD auditability** — a queryable *effective-policy* view +
  *gate-decision log* (the gap an enterprise security eval will probe; we're 80% there
  via append-only `events` + `runs`). Do NOT build Snowflake's full role graph /
  secondary roles / MANAGE GRANTS for v1.

## 6b. Batched approvals + conversational revision (operational follow-on)
**Problem:** today it's one `runs` row + one Slack card per proposal (dedupe is
per-*entity*, `entity-field-approval.ts:303`, not batch grouping). A watcher window
creating 100 entities ⇒ 100 cards. Unusable at watcher scale.

**Grouping key must be ADDED (correction, §6e.3):** entity-change proposal runs carry NO
window_id today (`manage_operations.ts:695` is a different path — connector-action reactions).
The `runs.window_id`/`runs.watcher_id` COLUMNS exist (baseline.sql:1868-1890) but proposals
don't set them. Thread windowId through the gate → deferral builders → propose INSERT, into
the `runs.window_id` COLUMN (not `action_input` — preserves the md5 dedupe identity). Group on
that column.

**Design (DECIDED):**
- Group all proposals from one `window_id` into **ONE batch approval** — a parent
  `runs` row with child proposals — rendered as a single card: summary
  ("87 creates · 11 updates · 2 deletes") + **read-only expandable diff**.
- Coarse controls: **Approve all** (applies the batch) / **Reject all** (one reason).
- **Subset changes are CONVERSATIONAL, not a diff-editing UI (DECIDED).** The reviewer
  asks the agent — "the 3 SaaS ones have wrong company names, fix them" — and the agent
  revises those child proposals **in place** (reject-reason as context), then the batch
  card updates and the reviewer approves. The card stays read-only; ALL mutation flows
  through the agent. The human does judgment, never data entry. This CUTS the per-item
  inline-editor UI entirely.
- **Revision loop = reject-with-reason re-dispatches the agent (DECIDED).** Rejecting a
  batch or an item with a reason re-runs the watcher/agent with that reason as context;
  it produces a revised batch that returns for approval. **This closes the feedback-loop
  gap** identified in the original investigation (reject reason is captured on
  `runs.error_message` today but dead-ends).
- **One new operation** (the only non-trivial wiring): let the agent *target a pending
  batch's child proposal and update it in place* — mutate the pending `runs.action_input`
  proposal, not the live entity. Small; reuses the existing proposal storage.

**Sequencing:** NOT v1. Highest-value operational follow-on — build right after the core
lands, BEFORE pushing watchers-at-scale on customers (100 cards makes the feature
unusable for exactly watchers' main use case).

## 6e. Blocking gaps from Fable review (deploy-safety — MUST close)
1. **Migration is NOT deploy-window safe — needs two-phase (CRITICAL).** Migrations run in
   a Helm **pre-upgrade hook BEFORE new pods roll out** (`docker/app/start.sh:48-53`; a past
   incident is documented there). A bare `RENAME` → old pods hit the new schema → every
   agent/watcher entity write throws (`loadCandidatePolicies` errors; only
   `principalKind==="user"` short-circuits before the query) + settings API 500s for the
   whole rollout. **DECIDED: additive-expand / cutover / contract, three migrations:**
   - **M1a (expand, deploy-safe):** CREATE the NEW columns on the EXISTING
     `entity_approval_policies` table (`resource_class DEFAULT 'entity'`, `target_scope_*`,
     `principal_*`, `predicate jsonb NULL`); widen mode CHECK per §6d.2. NO rename, NO column
     drop. Old pods keep working (they ignore new columns; INSERTs get the DEFAULT).
   - **M1b (cutover, same PR, later commit):** new code reads/writes the new columns;
     backfill `target_scope_*` from the old `entity_type_slug/field_path/entity_id`
     (verbatim-move per §6d.3, not lossy). Table KEEPS its name this cycle — do NOT rename
     while old pods may exist.
   - **M1c (contract, FOLLOW-UP PR after full rollout):** rename table →
     `write_approval_policies` (+ compat updatable VIEW `entity_approval_policies` if any
     external SQL references it), drop the old `entity_type_slug/field_path/entity_id`
     columns. Two-phase column drop per the repo's squawk discipline.
   → Net: **the physical table stays `entity_approval_policies` through v1**; the "rename"
     is a post-rollout contract step. All code uses the new columns from M1b.
2. **The HTTP API generalization is BACKEND work — assign it, don't leave it homeless.**
   Shipped contract is natural-key upsert/delete (`index.ts:1370,1531`) consumed by the live
   UI (`entities.ts:158-219`). DECIDED: keep the **scope-keyed** endpoints (translate to
   id-based rows server-side, preserving the upsert-race retry), and make them ADDITIVE —
   accept/return `resource_class`/`principal_*`, default `resource_class='entity'` when
   omitted so the shipped UI keeps working unchanged. This backend change lands in the
   per-principal commit (Commit 2), NOT the UI commit. Kills the "id-based CRUD breaks the
   shipped UI" contradiction — we do NOT move to id-based endpoints, only id-based storage.
3. **§6b window_id claim was WRONG — corrected.** `manage_operations.ts:695` is
   `trackWatcherReaction` for connector-action runs (writes `watcher_reactions.window_id`), a
   DIFFERENT path. Entity-change proposal runs carry NO window_id: the deferral builders
   don't accept it (`entity-mutation-gate.ts:165-183`), `promote-keyed-entities.ts` has
   `windowId` in scope but doesn't pass it, and `proposeEntityChange` sets neither
   `runs.window_id` nor `runs.watcher_id` columns (which EXIST, baseline.sql:1868-1890 —
   watcher_id currently lives only in `action_input`). **DECIDED: thread windowId through the
   gate request → deferral builders → propose INSERT, writing the `runs.window_id` COLUMN
   (NOT into action_input — that would change the `md5(action_input)` dedupe identity across
   window retries). Grouping reads the column.** This is §6c/Commit 4 scope.

## 6f. Residual risks (Fable — note in PR, not blocking)
- **R1 (§6b revision must rewrite the CARD, not just the run).** The pending event's
  `interaction_input`/`metadata` and the Slack card are propose-time snapshots
  (`entity-field-approval.ts:386-447`); approve applies from `runs.action_input`. Revising
  `action_input` alone ⇒ card shows OLD, approve applies NEW. The in-place revision op MUST
  also rewrite the pending event + refresh/replace the Slack message. (Undersold as "small".)
- **R2 (revise-vs-approve-all race).** The revision UPDATE must guard
  `approval_status='pending'` so it blocks on the claim row-lock and no-ops after a claim
  (mirrors `claimEntityChangeRun`, `manage_operations.ts:1212-1234`).
- **R3 (batch card is net-new UI).** `FieldChangeDiff` (`event-card.tsx:522-589`) is reusable
  PER ITEM, but the parent-batch card, a new batch action_key + its dedupe story, and the
  per-child staleness loop on approve-all are new. Budget it.
- **R4 (backfill collision rule).** A collapsed/moved scoped row can collide with an existing
  type row under the new unique index — but §6d.3 verbatim-MOVE (to `field_path`/`entity_id`
  scope kinds, reserved now) avoids collapse entirely, so no collision. Confirm no two rows
  share the exact new unique key; if they do, restrictive-wins.
- **R5 (deny fail-open).** `normalizeMode` coerces unknown modes to fallback
  (`entity-policy.ts:83-88`) → a `deny` row reads as auto until the resolver understands it.
  **Land deny-handling in the resolver (Commit 2) BEFORE widening the CHECK to allow deny, OR
  widen CHECK in the same commit as the resolver change.** Don't let M1a admit `deny` while
  the resolver still normalizes it.

## 6c. Watcher-run change-set is FIRST-CLASS — diff ≠ approval (DECIDED)
**Correction to §6b framing.** The diff of "what a watcher run changed" is a property of
the RUN, not of the approval flow. A run that AUTO-applies 100 changes must be just as
inspectable as one that needed approval. Do NOT encapsulate the change-set inside
`entity-field-approval.ts`.

**Two layers:**
1. **Run change-set (always visible, any policy outcome).** Every watcher/agent run
   records its create/update/delete change-set, grouped by `watcher_run_id`/`window_id`,
   viewable as a diff on the RUN itself — whether auto-applied, approval-gated, or denied.
   This is observability ("what did watcher #6 do at 3pm?"), independent of gating.
2. **Approval is an OVERLAY.** When policy = approval, the same change-set gets
   approve/reject + reviewer routing. When policy = auto, the change-set still exists and
   is still viewable; it just applied without a gate.

**Already partially exists** (grounds this, not net-new): `watcher_run_id` threaded through
`complete_window` (`manage_watchers/complete-window.ts:72,148`);
`promoted-entities-recap.tsx` + `watcher-summary-view.tsx` in owletto render a run recap.
The work is to make the change-set the FIRST-CLASS primitive both the recap AND the batch
approval read from — one source, two views (mirrors "one writer many mirrors").

**This also fixes Codex gap #6**: the batch grouping contract lives on the RUN change-set
(`watcher_run_id`), not invented inside the approval flow.

## 6d. Blocking gaps from final review (Codex — MUST close before coding)
1. **Principal identity mapping — SPECIFY exactly.** Not just `agentId`. Define
   principal resolution for every context: agent run → `(agent, agentId)`; watcher run →
   `(watcher, watcherId)`; system/automation token (no agent id) → `(agent, NULL)`; user →
   never a policy principal. Today `watcherId` is *attribution*, not policy identity —
   promote it. This is Commit 1 scope, not deferrable.
2. **Effect model is resource-class-aware, not one flat CHECK.** `disabled` applies ONLY
   to connector_action; `deny` for entities means the entity code must handle a deny
   outcome (today it only knows auto/approval). Define per-class legal effects in CODE
   (a map) + a lightweight DB CHECK; the three mode columns are reused positionally per
   class via the manifest. Connector-action execution mode uses the create_mode column
   (single-verb class) — document it.
3. **Migration collapse needs a deterministic rule, not "collapse."** When folding a
   field/row-scoped row into its type row, modes may conflict → **restrictive-wins**
   (deny>approval>auto) per verb; delivery target → keep the more-specific row's target,
   else inherit global. PREFLIGHT: if a collapse would change an effective decision, LOG
   each collapsed row (no silent mode changes). Better: since scoped rows are rare, MOVE
   them to `target_scope_kind='field_path'/'entity_id'` verbatim (they're valid v1.1
   shapes reserved now) instead of collapsing — zero decision change. **Adopt the
   verbatim-move; no lossy collapse.**
4. **Effect resolution vs notification routing are SEPARATE concerns.** Specify (a) which
   row wins the effect, and (b) independently, the delivery-target inheritance chain:
   winning row's target → nearest ancestor scope's target → class global → org global →
   generic admin fan-out. A principal-specific row with no target inherits down this chain.
5. **§6b parent/child + revision concurrency (SPECIFY):** parent run + child-proposal
   rows; child cards suppressed (only the parent card posts); in-place child edit uses
   **optimistic version** on the child row; after any revision, **re-run policy + staleness
   on the changed child** before it's approvable; **approve-all = per-child partial apply**
   (not atomic — a stale child fails individually and re-opens, the rest apply), matching
   today's single-proposal apply-failure-reopens semantics (`manage_operations.ts:1419`).

## 7. Non-goals
- No policy engine / DSL runtime (Cedar dropped, #1802).
- No `role_permissions` config table (roles stay code until custom roles are demanded).
- No user-principal policy rows (users stay manifest-governed).
- No raw-SQL predicates from admins (structured conditions only, v1.1).
- No inline diff-editor in the approval card — subset changes are conversational (§6b).

## 8. Codex sol review (post-implementation) — fixed + deferred

A `gpt-5.6-sol` review of the full branch found 10 findings. Resolved on-branch:
- **#1 precedence inversion (high, FIXED):** `specificity()` made principal weight
  (16/8) outrank target scope (≤7), inverting the RFC's target-first order. Replaced
  with a tuple comparator: scope-specificity → principal-specificity → restrictive-wins
  (`deny>disabled>approval>auto`) → id. Inverse regression added.
- **#2 watcher_source principal spoof (high, FIXED):** caller-supplied `watcher_source`
  could reclassify an agent as `watcher:<id>` to dodge its agent policy.
  `classifyMutationPrincipal`/`mutationPrincipalId` now prefer trusted `ctx.agentId`.
- **Display bug (FIXED in owletto):** `deny`/`disabled` rendered as "Auto"; now
  "Denied"/"Disabled".

Deferred (tracked follow-ups, NOT in v1):
- **#3** approve/reject should require `ctx.userId != null`, not just `!clientId`.
- **#5** re-evaluate connector_action `deny`/`disabled` at execute time, not only queue.
- **#7** `normalizeMode` unknown → `deny` (fail-closed), not `auto`.
- **#8** legacy `manage_agents` pending runs without `proposal.base` must fail closed.
- **#9** thread `window_id` through `manage_entity` watcher writes (not only promotion).
- **#4** add `window_id` to the entity-change dedup key (cross-window collapse).
- **#6** bare rename outage — ACCEPTED tradeoff (user chose clean-cut).

**Part B — architecture (sol + prior reviews agree):** code-defined resolver over one
Postgres policy authority is right (beats Cedar/OPA, OpenFGA/SpiceDB, per-class tables).
sol's material suggestion for v1.1: make the table **action-oriented** — replace the
three entity-shaped `create_mode/update_mode/delete_mode` columns with `(action, effect)`
rows (action ∈ create/update/delete/execute/install; effect ∈ auto/approval/deny/disabled),
so verbs like `execute`/`install` aren't crammed into create/update/delete semantics. A
code registry declares legal actions/effects/targets/predicate-fields per resource class.
Closer to the Snowflake privilege model. Adopt when connector_action's own UI + the
v1.1 predicate engine land.
