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

## 4. Schema (write_approval_policies)
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

## 5. Implementation — three small PRs (v1)

**PR 1 — DB + `agentId` plumbing (refactor, NO behavior change).**
Migration 1: rename `entity_approval_policies` → `write_approval_policies`; add
`resource_class`/`target_scope_*`/`principal_*`/`predicate jsonb NULL`; move to id-based
CRUD + new unique index; backfill existing rows (`resource_class='entity'`, collapse any
field/row-scoped rows to their type row — enumerate first, they're rare per the shipped
defaults). Thread `agentId` through the gate request + 3 call sites. All behavior
identical (defaults preserve today's decisions). Reviewable as pure refactor.

**PR 2 — per-principal policy for entities (the new capability; backend + tests).**
Resolver consumes `principal_kind`/`principal_id`; add the second specificity axis +
restrictive-wins. Prove red→fix→green: watcher #N auto-allowed while other agents gated;
tie-break; users never gated; field-ownership approval still fires (regression guard).

**PR 3 — UI (frontend-only; the acknowledged gap).**
`organization-settings-page.tsx`: resource-class tab strip (Entities + Agents) + a
principal picker beside the type picker; generalize `useEntityApprovalPolicy` →
`useWriteApprovalPolicy(resourceClass)`; widen the effect type. NO predicate builder, NO
connector reflection page. Approvals inbox untouched.

Agents-as-a-governed-class (wiring `manage_agents` through the generalized gate + the
`manage_agents` human-immediate behavior change + building its `isStale`) is a **fourth
small PR** once PRs 1–3 land — kept separate because it carries the one behavior change.

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

**Grouping key already exists:** `window_id` is threaded through
(`manage_operations.ts:695`) — every proposal from one watcher run is tagged with it.

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

## 7. Non-goals
- No policy engine / DSL runtime (Cedar dropped, #1802).
- No `role_permissions` config table (roles stay code until custom roles are demanded).
- No user-principal policy rows (users stay manifest-governed).
- No raw-SQL predicates from admins (structured conditions only, v1.1).
- No inline diff-editor in the approval card — subset changes are conversational (§6b).
