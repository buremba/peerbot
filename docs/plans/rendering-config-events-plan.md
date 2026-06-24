# Rendering + Config-as-Events + Branching — Implementation Plan

## Thesis (what we landed on)
- **Types own schema + template.** Two first-class type registries — `entity_types` and a new
  first-class `event_types` (lifted out of `entity_types.event_kinds`). Watchers own neither.
- **One renderer, one resolution order** for entities AND events:
  `instance override → thread overlay → env applied → type default → auto-generated-from-schema`.
- **Config is field-grained config-change events on the events spine**, folded into "effective
  config" by the **same projection mechanism as `entity_field_state` (B1)** — with a `layer`
  precedence axis (instance > thread > env > type-default) instead of B1's `source` axis.
- **Render-latest = render the effective top-of-stack for the current `(env, thread)` context.**
  A thread folds its own uncommitted config-events on top of `applied@watermark`, so it's
  deterministic and "can't apply latest until committed."
- **Audit = git (declarative `lobu apply`) + config-change events (runtime/dev/thread).** Replay
  reconstructs any state, in any thread, at any time. dev = runtime edits accepted as working set;
  prod = locked, declarative-only.
- **Commit = field-grained 3-way merge** (`base=applied@watermark`, `theirs=applied@now`,
  `ours=thread-events`); conflicts only where both touched the same config field, resolved by
  per-field precedence (reuse the corrections logic).

## Already shipped (the foundation)
- **B1** (`36f405b5e`) — source-ranked `entity_field_state` projection: events fold to current
  state with a precedence axis. **This is the exact primitive the config projection reuses.**
- **Track A** — watcher authors no schema/template; rendering is the type's job. The reason this
  plan exists.

## Cross-cutting discipline
- Two-phase column drops (expand release N, contract N+1; QUERYABLE_SCHEMA before drop; squawk).
- Multi-replica: all state Postgres-mediated; the config projection + overlays are PG-backed, no
  in-memory cross-pod assumptions.
- Each phase: red→green integration tests against a real PG; `make review`; prod-count before drops.
- Cross-repo: owletto changes land first, then bump the lobu pointer.
- Render NEVER crashes — graceful-skip is the universal backstop.

---

## Phase R0 — Rendering reliability (ship now, unblocks Track A consistency)
*No new architecture; closes the json_template-removal regression.*
- **R0.1** Auto-generate a default template from a type's `metadata_schema` (fields → rows/sections,
  honor `x-table-column`/`x-table-label`). Resolver returns it when no template is declared →
  promoted entities are never bare.
- **R0.2** Unify the entity resolver to `instance → type → auto-default` (extend the existing
  `resolve_path` COALESCE with the auto-default tail).
- **R0.3 (owletto)** Remove the dead watcher-`json_template` rendering (`watcher-detail`,
  `watcher-group-detail`, `watcher-summary-view`); add **watcher → promoted-entities navigation**
  so the watcher view links to the richly-rendered entities. Bump the lobu pointer.
- Gate: entity render tests (default + override + drift graceful-skip); owletto compile + manual.

## Phase R1 — First-class event types (Gap 1)
*Make event kinds a peer of entity types; unify event rendering.*
- **R1.1** New `event_types` registry (org-scoped), keyed by `semantic_type`:
  `{ description, metadata_schema, json_template }`. Migrate `entity_types.event_kinds` jsonb → this
  table (two-phase; backfill `$member` defaults).
- **R1.2** Move `event-kind-validation` to read `event_types`; events resolve their kind via the
  registry (org-scoped events stop routing through `$member`).
- **R1.3** Event rendering via the **same resolver** (`instance payload_template → event_type
  template → auto-default`). Collapse `event-card.tsx`'s ad-hoc `payload_type` rendering into it.
- **R1.4** This subsumes the `semantic_type`-vs-classifier overlap — `semantic_type` is now the
  first-class event-type facet. (Retire the nested jsonb taxonomy.)
- Gate: event render tests; semantic_type validation tests; migration squawk-clean + prod-count.

## Phase C0 — Config-as-events foundation (the unified audit)
*Config changes become field-grained events; build the config projection.*
- **C0.1** Define the **config-change event** shape (`semantic_type='config_change'`):
  `{ target_kind (entity_type|event_type|template|classifier|watcher), target_id, field_path,
  mutation, value, layer, actor, thread_id? }` — same field-grained shape as corrections/`entity_field`.
- **C0.2** Build the **config projection**: fold config-change events → effective config state,
  reusing the B1 projection pattern with a `layer` precedence axis. PG-backed projected table
  (`config_state` or per-type) + trigger, mirroring `project_entity_field`.
- **C0.3** Make runtime config writers emit config-change events: `manage_view_templates`,
  `manage_entity_schema`, `manage_classifiers`, watcher CRUD. (Audit lands on the spine — the
  "it's in the event logs" requirement.) Keep version tables for now (mirror), retire later.
- Gate: config projection tests (fold, precedence, replay); audit-replay test.

## Phase B0 — Thread overlay / branching (the advanced model)
*The keystone primitive: `applied ⊕ thread-overlay` resolution.*
- **B0.1** Thread-scoped overlay: config-change events tagged `thread_id` + `uncommitted`, NOT
  folded into global applied state. Resolver merges `applied@watermark ⊕ thread-events` per request.
- **B0.2** Watermark: a thread records the applied config-event id at fork; renders deterministically
  against `applied@watermark ⊕ overlay` (global advances don't leak in).
- **B0.3** Commit = field-grained 3-way merge (`base=applied@watermark`, `theirs=applied@now`,
  `ours=overlay`); conflict resolution per-field (reuse corrections precedence); on success the
  overlay events become applied (new watermark) / become a `lobu apply` diff.
- **B0.4** Resolution caching: memoize merged config per `(env, thread)`, invalidate on overlay/
  applied change (multi-replica: PG-mediated invalidation, not in-memory only).
- Gate: overlay isolation test (thread A's edit invisible to thread B); determinism test; 3-way
  merge + conflict tests; multi-replica invalidation test.

## Phase A0 — `lobu apply` + dev/prod policy
*Declarative integration + the env modes.*
- **A0.1** Declarative templates-on-types in `lobu.config.ts` (entity + event types carry templates);
  `lobu apply` validates each template's field-refs against that type's `metadata_schema` (the gate).
- **A0.2** dev/prod write policy: prod rejects runtime config events (declarative-only, git = overlay);
  dev accepts them as the working set. A mode flag the config write-path checks.
- **A0.3** Thread commit → PR/apply path (a thread's overlay diff becomes a config change applied via
  the declarative pipeline).
- **A0.4** Retire the version tables (`view_template_versions`, `watcher_versions`) once the config
  projection + git are the source of truth — contract migrations, two-phase.
- Gate: apply validation tests; dev/prod policy tests; e2e thread→commit→apply.

---

## Sequence & dependencies
```
R0 (rendering reliability)         ← ship first, standalone, closes Track A
R1 (first-class event types)       ← needs R0 resolver; resolves semantic_type/classifier
C0 (config-as-events audit)        ← reuses B1; independent of R1 but pairs with it
B0 (thread overlay/branching)      ← needs C0 (overlay = uncommitted config events)
A0 (lobu apply + dev/prod)         ← needs C0 + B0
```
Order: **R0 → R1 → C0 → B0 → A0.** R0 is shippable immediately; C0 is the audit win; B0 is the
branching keystone; A0 ties it to `lobu apply`.

## Open decisions (carry into the phases)
- Per-type projected `config_state` table vs one generic — settle in C0.2 (mirror B1's table shape).
- Overlay = events-only (replay each render) vs events + a cached projected overlay table — B0.4.
- How aggressively to retire version tables (A0.4) vs keep for fast rollback.
