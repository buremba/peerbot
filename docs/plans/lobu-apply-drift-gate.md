# `lobu apply` drift gate & reconcile — Plan

Status: **planning** · Owner: @buremba · Builds on `lobu-apply.md` (v1 merged) · Related to `lobu-pull.md` (builds on the same attribution) · Reviewed against pi second-opinion: round 1 → 3 blockers (baseline advancement, latest-deployment read, both-moved rule), round 2 → 3 blockers (delete-after-baseline-edit, no-baseline ambiguity, plan-to-execute race) + 1 index note — all addressed in the current revision; re-review pending

## Goal

Make `lobu apply` **fail closed** instead of silently destroying un-declared remote state. Today a config-managed org with `prune: true` (e.g. `examples/personal-agent`, org `buremba`) has exactly two outcomes for manual work done in the web UI:

- a UI edit to a declared definition (adding `x-lobu.role` to `task.status`) → `update` row → apply overwrites it (silently loses the user's work);
- a UI-created definition (`contact`) → `delete` row → apply proposes deleting the user's work.

This plan changes the contract to: **apply converges what the config declares, and refuses — exit 1, no mutation — to touch anything the config doesn't declare.** Un-declared remote state is either folded back into config (**adopt**), or explicitly reverted/deleted via a **token-bound confirmation**. The deterministic executor stays in the CLI; the *judgment* (adopt vs revert vs delete) lives in the operator or a reconciler agent loop.

Three behaviors, decided:

1. Never overwrite a remote change the config doesn't know about.
2. Never auto-delete a UI-created definition.
3. Make convergence cheap: adopt (write-back to `lobu.config.ts`) or token-confirmed revert/delete.

## Mental model

```
   last-applied manifest          desired (lobu.config.ts)          remote (cloud)
   (deployment event in events)            │                              │
          └────────────────────────┬───────┴──────────────┬──────────────┘
                                   └───── three-way compare ─────┘

   desired == remote                          → noop
   remote == manifest AND desired ≠ remote    → config moved  → converge (update)
   desired ≠ remote AND remote ≠ manifest     → remote moved / both moved  → BLOCK (drift/adopt/revert)
   remote-only definition, IN manifest AND remote == manifest
                                              → config-expressed delete  → rides --yes
   remote-only definition, IN manifest AND remote ≠ manifest
                                              → edited after baseline  → BLOCK (both moved)
   remote-only definition, NOT in manifest    → UI-created     → drift (adopt / token delete)
   no baseline (never applied / summary lost) → creates converge; every remote mismatch
                                               and remote-only definition → BLOCK (no attribution)
```

Note the third rule: **convergence happens only when the remote is untouched** (`remote == manifest`). If both config and a concurrent UI edit moved the same field (`remote ≠ manifest AND desired ≠ remote`), that field **blocks** — never let config silently win over a user's edit. Creates converge naturally (both remote and manifest are absent). And the config-expressed delete tier is **not** unconditional: a definition that was edited in the UI *after* the baseline (`remote ≠ manifest`) is a both-moved block even though config removed it — deleting it would destroy that edit.

**Destructive operations are race-guarded.** The attribution happens client-side, but the write is server-enforced: every revert, delete, and config-expressed delete carries an optimistic precondition (an expected remote fingerprint — the snapshot's `updated_at`/content hash) that the mutation endpoint verifies and answers `409 conflict` on if a UI edit landed between planning and execution. Config-declared convergent *updates* keep today's config-wins semantics (the config is the declared owner of that field — no promise to preserve a mid-apply UI edit on it).

The **deployment manifest** (`buildDeploymentManifest` → `deployment.ts:118`, stored in the deployment event's `payload_data`) is the attribution record: it is the redacted desired state *as last applied*. It is exactly the "last-applied state" that `lobu-pull.md:240` claims is missing — apply v1 already persists it; this plan just reads it back. With three versions of every field (manifest / desired / remote), "who moved" is deterministic: **converge only when remote equals manifest** (the remote hasn't moved since the last apply), **block whenever remote differs from manifest AND from desired** (a remote edit, or both sides moving — fail closed). A stale baseline only ever over-blocks (safe), never under-blocks.

No new state table, no new columns, no `managed_by` marker — the only DB touch is one additive partial index for the `/latest` read (surfaced for approval in PR-1).

## Background — what already exists

- **Manifest persistence**: every apply POSTs a summary to `POST /api/<org>/deployments` (`deployment-routes.ts:59`), storing the redacted desired-state snapshot in `payload_data.manifest`. `GET /deployments` (feed, `deployment-routes.ts:178`) returns metadata only; `GET /deployments/:applyId` (`deployment-routes.ts:382`) returns the manifest. CLI already has `client.getDeployment(applyId)` (`client.ts:514`).
- **Baseline gaps**: an **all-noop apply does not POST a summary** (`apply-cmd.ts:1535-1538` — it returns after "Nothing to apply." unless provider keys are declared), and summary persistence is best-effort (`postDeploymentSummarySafe` warns, never fails). So the manifest does not track the last *endorsed* config unless apply always records it — decision #2. The feed also **mixes deployment events with standalone config changes** (`category='config'`, `apply_id IS NULL`) and has **no status filter** — a `limit=1` client-side lookup is ambiguous, so PR-1 adds a dedicated latest-succeeded read.
- **Manifest hash**: `computeManifestHash(state)` (`deployment.ts:90`) — sha256 of canonical redacted desired state; the server stores it as `metadata.manifest_hash`.
- **Diff verbs**: `create | update | noop | drift | delete` (`diff.ts:34`). `diffEntityType` compares whole `properties` via `deepEqual` (`diff.ts:390`) — the reason a UI edit is currently folded into `update` and clobbered.
- **Prune**: `computeDiff({ prune })` emits `delete` for any org-owned remote definition absent from desired (`diff.ts:997`), guarded by `isSystemEntityType` (`$` prefix) and the org-ownership filter (`ownsDefinition`, `diff.ts:923`).
- **Blast radius**: `confirmDeletions` re-prompts when a plan deletes >3 definitions (`apply-cmd.ts:1554`, `prompt.ts:36`).
- **Deployment statuses**: server accepts only `succeeded | partial_failure` (`deployment-routes.ts:44`).
- **`event_kinds` / `viewTemplate` are already prune-aware** (`diff.ts:412-428`): declared → diff; omitted + prune → removal; omitted + no prune → unmanaged. The new attribution generalizes this pattern to `properties` and to the "who moved" question.

## Locked decisions

1. **Fail-closed drift gate.** If the plan contains blocking drift (below), apply prints the report, exits 1, and mutates nothing — including under `--yes`. `--yes` never destroys un-declared state.
2. **Three-way attribution via the deployment manifest.** Complete rule: `noop` when desired == remote; **converge only when `remote == manifest`** (remote untouched since last apply); **block whenever `remote ≠ manifest AND desired ≠ remote`** — this covers both pure remote-moves and the both-moved case, which fails closed rather than letting config win over a concurrent UI edit.
   **No-baseline is a block, not a default-converge.** A missing baseline is *ambiguous*: it could be a true first apply (never applied) or an applied org whose summary POST failed best-effort. These are indistinguishable, so with no baseline, creates converge but **every remote mismatch and every remote-only definition blocks** (drift/adopt). This is the only safe reading — a first-apply "config wins" default would silently overwrite UI state after a lost summary. The bootstrap escape hatch is `lobu apply --bootstrap`: an explicit, confirmed snapshot of current remote as the baseline (a deployment-style record), after which attribution resumes.
   **Baseline advancement** (fixes the "stale baseline" gap): the manifest baseline advances **only on a fully-succeeded run — including all-noop runs**. Apply must POST the summary on noop runs too (today it skips them, `apply-cmd.ts:1535`), so the baseline tracks the last *endorsed* config. A `partial_failure` run **never advances** the baseline (some resources didn't land). If the baseline is missing or its persistence failed ambiguously, over-block — never under-block.
3. **Field-level scope: memory schema + Behaviors.** Entity types (properties, required, name, description, backing, metrics, eventKinds, viewTemplate), relationship types, and Behaviors get per-field attribution; a remote-moved field is a blocking item. Everything else (agents, settings, connections, feeds, auth profiles, providers, connector definitions) keeps today's behavior — converge what's declared, non-blocking drift notes for the rest. Rationale: the idempotent/declared paths there emit perpetual "update" rows by design (connector-definition re-push `diff.ts:608`, BYO connection `config` always-changed `diff.ts:736`, write-only provider keys), so a whole-state gate would block forever on an untouched org.
4. **Two delete tiers.**
   - **Config-expressed** (definition was in the last-applied manifest, now absent from config, **and `remote == manifest`** — untouched since baseline): a `delete` row that **rides `--yes`** — the config PR is the review, matching Terraform's destroy-in-plan. Blast-radius confirm stays. **If the definition was edited in the UI after the baseline (`remote ≠ manifest`), it is NOT config-expressed** — it is a both-moved block; deleting it would destroy the edit.
   - **Un-declared** (remote-only, never in a manifest): UI-created. **Never a delete row.** Reported as blocking drift; resolved by adopt or `--confirm-deletes <token>`.
   Both tiers carry the optimistic precondition (decision #11) at execution.
5. **`prune` semantics narrow.** `prune: true` now means "this config owns deletions" with a delete set of *previously-applied-and-removed only*. It no longer deletes UI-created definitions. This is a deliberate, safe-direction breaking change (the personal-agent config relies on prune catching removed Behaviors — that still works).
6. **Token-bound confirm.** `lobu apply --confirm-deletes "lobu1:tkn_<base64url>"` carries the encoded blocking set `{ v, plan_hash, items: [{kind, id, field?, action: delete|revert}] }`. On confirm, apply recomputes the plan, verifies `plan_hash` matches the freshly-computed blocking set, prints the decoded action list (the "seeing" step, again, at execution), and executes the confirmed items. **Any recompute mismatch — hash or any item's candidate state — rejects the entire token**: exit 1, no partial execution, full re-report. A bare-slug escape hatch stays available.
7. **Adopt = minimal codegen.** Modified field → print the exact delta (e.g. `"x-lobu": { role: "workflowState" }` under `status`). New definition → print a generated `defineEntityType` skeleton plus the remote schema, flagged for review. The *surfacing* is the value; codegen is mechanical translation, never a promise of perfect config. Resolution is a normal git change to `lobu.config.ts`.
8. **Agent autonomy split by reversibility.** Adopt is a config edit (reversible, git-visible) → the reconciler agent may do it autonomously. Revert/delete is destructive → the agent may *issue* the token confirm, but it lands as `pending_approval` and a human approves the exact list via a link before it fires.
9. **No "keep" verb.** Unresolved drift stays red (apply keeps exiting 1) until adopt or revert/delete. No hidden unmanaged state. A documented ignore list is out of scope unless it nags in practice.
10. **No schema/table changes.** Blocked applies reuse the deployment event with a widened `status`; attribution reads existing deployment rows. Append-only `events` invariant is preserved (a blocked apply is one more append-only row). The only DB touch is **one additive partial index** for the `/latest` read (see PR-1) — surfaced for approval.
11. **Optimistic concurrency on destructive operations.** Every revert (field), delete, and config-expressed delete is executed against a server-enforced precondition: the CLI sends the remote fingerprint it snapshotted at plan time; the mutation endpoint returns `409 conflict` if the current remote differs. The whole token/plan then fails closed and re-reports. Config-declared convergent updates do **not** carry the precondition (config is the declared owner — mid-apply UI edits on config-owned fields are config-wins by design).

## Phasing

### v1 (this plan) — deterministic CLI core

- Three-way attribution + field-level entity-type/Behavior diff; **no-baseline blocks** (with `--bootstrap` escape).
- Drift gate: block + exit 1 on blocking drift; blocked report with adopt snippets and the confirm token.
- `--confirm-deletes <token>` (recompute → verify → execute exact set, preconditioned). Config-expressed deletes ride `--yes` (only when `remote == manifest`).
- **Optimistic preconditions** on every destructive op (PR-4) close the plan-to-execute race.
- Baseline advances on every fully-succeeded run including noop (decision #2).
- Blocked applies POST a deployment with `status: "blocked"` carrying the candidates + token; server widens `DEPLOYMENT_STATUSES` and exposes them.
- No agent loop: the event is emitted and a human resolves (the operator or the existing agent tooling picks it up manually).

### v2 — reconciler loop

- A `reconcile-config` Behavior watches `status: "blocked"` deployments, reads candidates + token, and per item: adopt (edit `lobu.config.ts`, open a PR), revert/delete (issue the token confirm → `pending_approval`), or leave.
- Agent PR path for adopt (requires a repo-write/PR tool on the agent). Until then, adopt prints the snippet for the operator.

## v1 work breakdown — 4 PRs

Each PR lands independently; PR-2/PR-3/PR-4 can develop in parallel after PR-1.

### PR-1 — server: accept and expose `blocked` deployments + latest read

**Branch**: `feat/apply-blocked-deployments` · **Risk**: Low · **LOC**: ~70

- `deployment-routes.ts:44` → `DEPLOYMENT_STATUSES` += `"blocked"`.
- `POST /` accepts `candidates` (the token + blocking-item list) and stores it in `payload_data` (mirrors `manifest`).
- `GET /` feed and `GET /:applyId` detail expose `status` + `candidates` for the new status. The Deployments tab renders blocked applies as a distinct state.
- **New read `GET /deployments/latest`**: the latest deployment with `status = 'succeeded'` (org-scoped, `category='deployment'`, status filter, `ORDER BY id DESC LIMIT 1`), including its manifest. **API-surface change — surfaced here for explicit approval.** The mixed feed cannot answer "latest succeeded deployment" reliably (it interleaves standalone config changes and blocked applies, and has no status filter), so this is a bounded single-row read, not a client-side scan. (Alternative considered and rejected: a `status` filter on the feed — a dedicated read is unambiguous and cheap.)
- **Index**: the existing `(organization_id, id DESC)` config-changes index doesn't cover the `status` predicate, so add a small **additive partial index** `(organization_id, id DESC) WHERE semantic_type='change' AND metadata->>'category'='deployment' AND metadata->>'status'='succeeded'`. **DB change — surfaced for explicit approval.** New index only; no columns/tables.
- Tests: POST accepts `blocked` + candidates; rejects unknown statuses as today; detail round-trips candidates; `/latest` returns the newest succeeded deployment with standalone/blocked rows in between ignored.

### PR-2 — CLI: attribution, drift gate, token

**Branch**: `feat/apply-drift-gate` · **Risk**: Medium · **LOC**: ~450

- `client.ts`: `getLatestDeployment()` — calls the new `GET /deployments/latest` (PR-1) and returns the manifest. Only `succeeded` baselines count; `partial_failure` never advances (decision #2).
- `deployment.ts`: `loadLastAppliedState()` (parse manifest), token mint/verify (`mintConfirmToken`, `verifyConfirmToken`), `computeBlockingHash`.
- `diff.ts`: replace whole-`properties` deepEqual in `diffEntityType` with per-field comparison; add the three-way attribution pass against the last-applied state using the complete rule (converge only when `remote == manifest`; block when `remote ≠ manifest AND desired ≠ remote`; **no-baseline blocks** remote mismatches and remote-only definitions). New blocking-drift row shape: `{ kind, id, field?, verb: "drift", blocking: true, adoptSnippet, remoteChange, expectedFingerprint }`. Delete rows only for manifest-present definitions **whose remote still matches the manifest**; remote-only-absent-from-manifest and edited-after-baseline both become blocking drift (never delete). Preserve org-ownership and `$`-system guards.
- `apply-cmd.ts`: after `computeDiff`, if blocking drift exists or un-gated deletes exist → render blocked report, POST the blocked deployment, exit 1. `--confirm-deletes <token>` path: recompute, verify the full blocking set (hash + every item's candidate state) — **any mismatch rejects the entire token** — print decoded list, execute exactly the confirmed items via the existing per-kind executors, passing each item's `expectedFingerprint` to the preconditioned endpoints (PR-4); a `409 conflict` fails the whole run and re-reports. Config-expressed deletes proceed under `--yes` as today, also preconditioned. **POST the summary on every fully-succeeded run including all-noop** so the baseline advances (decision #2). `lobu apply --bootstrap` snapshots current remote as the baseline for no-baseline orgs (decision #2).
- `apply-cmd.ts` command surface: `--confirm-deletes <token|slug...>` (single flag, per the interview decision) and `--bootstrap` (new flag — surfaced for approval).
- Tests: three-way attribution table tests (manifest/desired/remote × moved-side), token mint/verify, staleness refusal, **no-baseline block**, **edited-after-baseline delete block**, **409 conflict on a race**, prune-narrowing regressions.

### PR-3 — CLI: blocked report + adopt snippets

**Branch**: `feat/apply-drift-report` · **Risk**: Low · **LOC**: ~200

- `render.ts`: `renderBlockedReport(plan)` — the `✖ BLOCKED` transcript: per item `kind · slug · field`, the remote-only change, the adopt snippet, and the confirm command line. `renderConfirmSummary` for the decode-at-execution step.
- Adopt snippet generator (pure function, snapshot-tested): field delta vs definition skeleton.
- Wire the blocked deployment POST (PR-1 client method) into the blocked path.
- E2E via the personal-agent scenario (see Testing).

### PR-4 — server: optimistic preconditions on destructive mutations

**Branch**: `feat/apply-preconditions` · **Risk**: Medium · **LOC**: ~250

- Entity-type / relationship-type / Behavior / connector mutation endpoints accept an optional `expected_fingerprint` (the remote's `updated_at` or content hash). On mismatch with the current row → `409 { error: "conflict", kind, id }`, no write. Delete handlers enforce it too.
- Scope: **revert, delete, and config-expressed delete only** (the destructive/attributed ops). Convergent updates keep current upsert semantics (decision #11).
- Multi-replica safe: each mutation validates against the current row at write time — no client-held lock, no in-memory state.
- Tests: fingerprint match → write; mismatch → 409 no-op; a test that edits the resource between plan and execution (the race) surfaces the 409.

## Footguns to avoid

Carried from `lobu-apply.md` / `lobu-pull.md`, plus new:

1. **Whole-state gate false-positives.** Never gate on the whole plan; gate only on the field-level blocking items (decision #3).
2. **Token staleness.** Any recompute mismatch rejects the **entire** token — never "confirm anyway," never partial execution. A stored/expired token is a failure, not a proceed.
3. **No-baseline is never config-wins.** Missing baseline (first apply or lost summary) → remote mismatches and remote-only definitions block; only `--bootstrap` (an explicit, confirmed snapshot) establishes a baseline. A config that assumes config-wins on first apply is a config that silently overwrites UI state after a lost summary.
4. **Manifest is redacted.** Secret-bearing fields are sentinel'd; never attribute from them (they're already always-update). Only structural fields participate.
5. **`prune` narrowing is breaking.** Existing `prune: true` configs stop deleting UI-created definitions. Surface loudly in the changelog/docs; the blast-radius confirm stays.
6. **Never delete `$`-system or foreign-org definitions** (`isSystemEntityType`, `ownsDefinition` — keep both guards in the new delete path).
7. **`event_kinds` / `viewTemplate` interplay.** The new attribution must not regress the existing declared-vs-omitted semantics (`diff.ts:412-428`) — an omitted template stays unmanaged outside prune, a remote-only one under attribution is a blocking drift item.
8. **Idempotent re-push rows excluded from blocking** (connector defs, BYO connections, provider keys) — blocking them makes apply unusable (decision #3).
9. **Stale baseline.** An all-noop apply must advance the baseline (decision #2), or a later UI edit is misattributed as config-moved. By construction a stale baseline only over-blocks (fail-closed), never under-blocks — keep it that way; never "fix" an ambiguous baseline by assuming config wins.
10. **Plan-to-execute race (TOCTOU).** The client-side snapshot can go stale before the write lands. Every destructive op must carry the optimistic precondition (decision #11) — a `409 conflict` is a failure and a re-report, never an overwrite.
11. **Concurrent applies.** Attribution reads the latest deployment; a racing apply can shift it. Document "don't run applies concurrently on one org" (same as today) — fail-closed on any ambiguous read.
12. **Agent deletes always human-approved.** Never grant an un-gated delete path to the reconciler in v1/v2 (decision #8).

## Testing strategy

### Unit

- `diff.test.ts`: three-way attribution table — (manifest, desired, remote) × outcome, for entity-type fields, relationship-type fields, Behavior fields, remote-only-in-manifest, **remote-only-in-manifest-but-edited-after-baseline → block**, remote-only-not-in-manifest, **no-baseline → block**, **both-moved → block** (never config-wins).
- `deployment.test.ts`: token mint → verify round-trip; tampered token fails; **stale token (any single item changed) rejects the whole token — no partial execution**; baseline advancement (noop run advances, partial_failure does not, missing/ambiguous baseline over-blocks).
- `render.test.ts`: snapshot the blocked-report transcripts from the personal-agent `task` case.
- Server PR-1: POST/GET round-trip for `blocked` + candidates; `/latest` index-bound lookup ignores interleaved standalone/blocked rows.
- Server PR-4: fingerprint match → write; mismatch → `409` no-op; **a test that edits the resource between plan and execution (the race) surfaces the 409**.

### End-to-end (this plan's exit criterion)

Boot local cloud (bootstrap path per `lobu-apply.md` E2E). Reference project: `examples/personal-agent` (org `buremba`, `prune: true`).

1. `lobu apply --yes` from a clean tree → all noops. Assert a `succeeded` deployment was POSTed (baseline advanced on the noop run, decision #2) and `GET /deployments/latest` returns it.
2. Add the board annotation in the UI (`manage_entity_schema` on `task.status`) → `lobu apply` → assert `✖ BLOCKED`, exact transcript, token printed, exit 1.
3. `lobu apply --confirm-deletes <token>` → assert decode line, deletion/revert of the annotation, exit 0.
4. Re-add annotation → apply blocked → apply the printed adopt snippet to `lobu.config.ts` → `lobu apply` → green, no drift.
5. Create `contact` in the UI → apply → blocked (never a delete row) → `--confirm-deletes <token>` → gone.
6. Remove a previously-applied type from `lobu.config.ts` with **no UI edits since baseline** → `lobu apply --yes` → config-expressed delete proceeds. Repeat with a **UI edit after baseline** → blocks as both-moved (never auto-delete).
7. `--yes` with blocking drift → exits 1, nothing mutated (assert via GET).
8. Blocked → confirm with a *stale* token (make a second unrelated UI edit first) → whole token rejected, nothing mutated, full re-report.
9. No-baseline org: `--bootstrap` snapshots current remote as the baseline (explicit confirm), then a UI edit afterwards blocks correctly. Without `--bootstrap`, an existing UI-managed definition blocks instead of being overwritten.

## Cross-cutting concerns

- **Auth / org**: blocked deployment POST uses the same apply-id threading and `requireSessionOrAdminPat` as today; attribution reads org-scoped deployment events only.
- **Append-only**: a blocked apply is one append-only deployment event; never tombstone or supersede it. The reconciler watches `status: "blocked"` rows.
- **Multi-replica**: no new shared mutable state. Manifest reads are org-scoped single-row lookups (the new `GET /deployments/latest` and the existing detail endpoint) on the partial index — bounded, not a history aggregation. Optimistic preconditions (PR-4) are enforced per-request against the current row at write time, so no client-held lock or in-memory state — correct under N replicas.
- **Naming**: user/agent-facing surface says **Behavior**, never `watcher`. The `--confirm-deletes` flag covers both delete (definition) and revert (field) — the token decode names each item's action, so one flag stays simple.

## Stacking & ordering

```
   lobu-apply v1 (merged)
            │
            ▼
   docs/lobu-apply-drift-gate  (this doc)
            │
   ┌────────┼───────┬────────┐
   ▼        ▼       ▼        ▼
 PR-1     PR-2    PR-3     PR-4
 (server, (CLI     (CLI     (server,
  small)   core,    report,  precondi-
          medium)  small)   tions)
            │
            ▼
     E2E (this session)
            │
            ▼
   v2: reconcile-config Behavior + agent PR path
```

PR-1 and PR-4 are server-side and independent; PR-2/PR-3 are CLI-side and develop in parallel. v2 (the agent loop) depends on v1's blocked-deployment event + token being live.

## Non-goals (for the avoidance of doubt)

- ❌ Full `lobu pull` (see `lobu-pull.md`) — adopt is targeted write-back, not a converger.
- ❌ LLM judgment *inside* `lobu apply` — the CLI stays deterministic; judgment is the reconciler's.
- ❌ Reconcile-config Behavior / agent PR automation (v2).
- ❌ Per-field "unmanaged" annotations in the schema (the Rule-4 hack — rejected in design; adopt-into-config replaces exemptions).
- ❌ Ignore list / "keep" verb.
- ❌ Field-level attribution for settings/connections/providers (out of the pain surface; revisit only if it nags).
- ❌ New DB table, `managed_by` marker, or server-side state (the additive partial index in PR-1 is the entire DB footprint).
- ❌ Bidirectional sync.

If any of these turn out to be hard requirements during real use, they get their own plan and PR; v1 ships small.
