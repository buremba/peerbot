# Watcher / Entity Consolidation — Implementation Plan

## Thesis
The system reduces to a small primitive set. Most of the debated surface is **duplicate
implementations of two patterns**:
1. **Source-ranked projection** — fold append-only events → `(target, key) → value`, resolving
   conflicts by source rank (`user > llm/agent > system`) then recency. Implemented 3× today
   (`entity_field_state` trigger, `event_classifications` read-CTE, watcher-`correction` DISTINCT ON),
   with inconsistent precedence — only classifications carry the rank.
2. **Label vocabularies** — a per-org described value set over content. Implemented 2×
   (`events.semantic_type` via `entity_types.event_kinds`, and classifiers via `classify_facet`).

Build the keystone (source-ranked projection) once; the rest collapses onto it.

## Confirmed facts (this analysis)
- Classification corrections **stick** (`content-search/ctes.ts:88`, `user>llm>embedding`).
- Entity-field corrections **do NOT stick** — `project_entity_field` is pure latest-wins by
  `events.id`, no source rank (`db/migrations/20260623040000…:33-49`). Agent re-writes clobber human edits. **Bug.**
- keyingConfig config-API is camelCase but server reads snake_case; nothing translates →
  config-authored entity-typed watchers silently become untyped (`map-config.ts:606` vs `watcher-extraction-schema.ts:98`). **Bug (pi blocker).**
- Promotion is create-once / no-op-on-match (`promote-keyed-entities.ts:266`) — can't evolve entities.
- Watcher version *history* is dead (`watcher-detail.tsx:96` `includeVersions:false`; `upgrade` unreachable + buggy at `version-actions.ts:243`); only run-snapshot + group-sharing are load-bearing.
- Condensation is unreachable in every shipped config (no caller, NULL in provisioning).
- Spikes: embeddings + semantic entity-merge are the retrieval primitives; classifiers are NOT
  (hard-filter & soft multi-classifier both ≤ plain embeddings). Classifiers = labeling/facet only.

## Cross-cutting discipline (every PR)
- **No compat shims / escape hatches. Prefer one-time MANUAL data migration.** When removing a
  feature would strand prod data, move the data manually (SQL or a one-off script against the prod
  watcher/event rows) into the clean model — do NOT keep the old code path alive for compat. Keep the
  code consolidated and simplified; the prod-safety budget is "migrate the data once," not "carry debt."
- **Two-phase column drops**: allowlist removal + stop-reads in release N (expand); `DROP COLUMN` in N+1 (contract). QUERYABLE_SCHEMA removal precedes the drop. Squawk migration gate (`ban-drop-column` excluded, but lint locally).
- **Multi-replica**: all shared state Postgres-mediated; no in-memory cross-pod assumptions.
- **Gate**: red→green E2E reproducer in PR body; `make review BASE=origin/main`; prod-count before destructive migrations.
- **Cross-repo**: owletto UI lands first, then bump submodule pointer.

---

## Track A — stabilize PR #1533 (this branch)
- **A1 ✅ DONE** (`b6380d228`) keyingConfig camelCase→snake_case in `map-config.ts` + test.
- **A2 ✅ DONE** (`e0e1d2e5d`) Full `json_template` removal (reads/writes/allowlist; column drop deferred). Server tsc green.
- **A3 ✅ DONE** (`e0e1d2e5d`) Two-phase: removed the `extraction_schema` DROP migration; deferred to contract release.
- **A4** Restore classifier `source_path` lint vs the *derived* entity-type schema (recover the deleted validator's loud-fail).
- **A5 (RESOLVED — remove, migrate data manually)** Inline `extraction_schema` is transitional debt, not
  long-term value → **keep the branch's removal**; do NOT restore the hatch. Prod safety = a one-time MANUAL
  migration of the 3 live reaction-handoff watchers into the entity / reaction-reads-entity model:
  - `lunch-finalize` — reaction already reads the `lunch-run` entity (committed `b7ff486b3`). ✅
  - `hn-engagement` (org_lobucrm, no repo config) — migrate the live row + its reaction to read its entity. ← owed
  - `catalog-staleness-checker` — archived; no migration needed.
  This is the gate for #1533 deploy (not a code hatch). Column drop itself stays deferred (Track C4 contract release).

## Track B — keystone: source-ranked projection (branch off main)
- **B1** Add `source` rank to entity-field events + `project_entity_field` (`user>llm>system`, then event id). Fixes the corrections-clobber bug. Expand/contract migration. **Highest leverage.**
- **B2** Unify the 3 folds onto one source-ranked rule; decide eager (state table) vs lazy (CTE). The rule is identical; only storage differs.

## Track C — promotion-as-single-write + run_entities (branch off main)
- **C1** Promotion update-on-match: emit `entity_field` events on match (not no-op). Fixes create-once.
- **C2** `PromoteKeyedEntitiesResult` returns ids; `complete_window` populates a new `ctx.run_entities`.
- **C3** Migrate reaction watchers to entity output + reaction-reads-entity (lunch done; HN next).
- **C4** THEN execute A5's deferred removal: drop inline `extraction_schema` + contract migration (`extraction_schema`, `json_template` columns).

## Track D — corrections consolidation (depends on B1)
- **D1** Collapse `submit_feedback` window-`correction` onto the event-level field/label edit; watcher feedback reads projected state. One correction concept.

## Track E — versioning collapse (depends on nothing; mirrors classifier P4)
- **E1** Inline watcher config onto group-root row; snapshot resolved config into `runs.approved_input`;
  config-change events for audit; drop `watcher_versions`/`current_version_id`/`version`/`change_notes`/`source_watcher_id`; keep `watcher_group_id`. Replace `create_from_version` (init-from-org clone). Delete dead+buggy `upgrade`/`get_versions`.

## Track F — condensation kill
- **F1** Remove condensation surface (code + owletto UI) + two-phase drop of `condensation_*`/`is_rollup`/`depth`/`source_window_ids`. Prod-count `WHERE is_rollup` first.

## Track G — facets unification (SPEC FIRST, largest)
- **G1** Design doc: `semantic_type` as a system-managed `kind` classifier, preserving the hot indexed column + synchronous AJV metadata-schema validation. Write-site sweep before committing.

---

## Sequence & dependencies
```
A1 → A2 → A3 → A4   (this branch, ship #1533)
B1 → B2             (keystone; B1 unblocks D)
C1 → C2 → C3 → C4   (C4 needs A5 deferred + C1-3)
D1                  (needs B1)
E1                  (independent)
F1                  (independent)
G1                  (spec; independent)
```
Order of execution: **A1–A4 (ship) → B1 (keystone) → F1 + E1 (independent cleanups) → C1–C4 → D1 → G1.**
