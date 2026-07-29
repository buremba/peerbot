# Watcher ↔ Entity sync + human–AI feedback loop

> **Status (2026-07-15):** **Shipped** — `entity_field_controls` migration + `mergeEntityFields` feedback path live.

## Goal
Watchers sync extracted values **into entities** (the entity is the source of truth), and a
human can correct an entity field; the watcher then **respects** that correction and the
correction **steers** future runs. The human always wins; the AI proposes, the human disposes.

## Validated approach (spikes on glm-5.2, live HN data)
- Showing the human-set value in context flips respect **0% → 100%**; the model also correctly
  **updates on genuinely new evidence** (doesn't blindly freeze).
- Live multi-item HN: **100%** field respect, 80% compositional filter.
- 2-round human-in-the-loop on a live week: **100%** correction respect + **100%** rule
  generalization + clean convergence (queue tightened 8→2, self-corrected its own
  over-generalization, held prior calls).
- Conclusion: the prompt is the UX optimization (fewer approval cards); the **server merge is the
  correctness backstop** (deterministic, 100%). An 80%-filter slip is card-spam, not a data bug.

## Architecture (settled)
- **Value** → `entities.metadata` (unchanged; keeps #1541's deletion of the entity_field projection).
- **Ownership** → `entities.field_controls jsonb` **column** (NOT a side table): a key present means
  that field's current value is human-owned. Read for free with the entity row, written atomically
  with `metadata` under the same `FOR UPDATE` lock. Shape:
  `{ "<field>": { "note": text|null, "set_by": userId, "set_at": iso } }`.
  No `mode` enum — human-owned simply means *watcher proposes via approval, never writes directly*.
- **One merge primitive** → `mergeEntityFields({source})` shared by human edits (`updateEntity`) and
  watcher promotion. `human` writes every changed field and marks it owned; `watcher` writes only
  un-owned fields and returns `blocked` for owned ones (the caller emits an approval).
- **History/audit** → reuse the existing `'change'` event (append-only, entity-scoped, payload-less
  so it stays out of search/embedding); `metadata.{applied,blocked,source}` carry per-field provenance.
- **Conflict** → an **approval interaction on the durable runs+events plane** (copy the `manage_agents`
  gate: pending run + `notifyActionApprovalNeeded` (no SSE dep, headless+multi-replica safe) → web
  approve via `/mcp` → apply callback → `supersedeActionEvent`). Emitted **post-commit**, never the
  ephemeral InteractionService plane (that has the runJobToken/connectionId routing trap).
- **Behavior payload** → return entity values + owned-field markers as structured rows from
  `behavior-mode.ts`; the literal prompt is delivered separately as the run's task instructions.

## Build sequence
1. **Data core (this slice):** `field_controls` column migration + `mergeEntityFields` primitive
   (pure `computeFieldMerge` core + DB wrapper) + wire the human-edit path in `updateEntity` to mark
   ownership. Unit test on the pure core.
2. **Promotion:** `promoteKeyedEntities` calls `mergeEntityFields({source:'watcher'})` — writes
   un-owned extracted fields, collects `blocked`, returns ids; `complete-window.ts` emits the
   post-commit approval for blocked fields.
3. **Approval apply:** new `manage_operations` action_key (`entity_field_change`) mirroring
   `tryApproveManageAgentsRun` — approve writes the field + marks owned, supersedes the event.
4. **Payload/reaction context:** `behavior-mode.ts` returns entity metadata + owned markers;
   reaction gets the Behavior's children + blocked proposals.
5. **Follow-ups:** owletto inline field-edit + annotation UI; device-worker entity context
   (`poll.ts` ships zero entities today); two-tier relevance (post-now vs track/conditional).

## Notes
- Two-phase: adding a column + a free-form `'change'` semantic_type is single-phase (additive).
- Multi-replica: `field_controls` is on the row, written under `FOR UPDATE`; the approval rides the
  durable Postgres plane — no in-memory cross-pod state.
