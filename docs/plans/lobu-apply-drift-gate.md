# `lobu apply` drift gate & reconcile — Plan

Status: **planning** · Owner: @buremba · Builds on `lobu-apply.md` (v1 merged) · Related to `lobu-pull.md` (builds on the same attribution) · Reviewed against pi second-opinion: pending

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
   desired ≠ remote AND desired == manifest   → remote moved  → BLOCK (drift/adopt/revert)
   desired ≠ remote AND desired ≠ manifest    → config moved  → converge (update)
   remote-only definition, IN manifest        → config-expressed delete  → rides --yes
   remote-only definition, NOT in manifest    → UI-created     → drift (adopt / token delete)
```

The **deployment manifest** (`buildDeploymentManifest` → `deployment.ts:118`, stored in the deployment event's `payload_data`) is the attribution record: it is the redacted desired state *as last applied*. It is exactly the "last-applied state" that `lobu-pull.md:240` claims is missing — apply v1 already persists it; this plan just reads it back. With three versions of every field (manifest / desired / remote), "who moved" is deterministic: if the config is unchanged since the last apply but remote differs, the change came from the remote (the user, the UI, an agent).

No new state table, no DB migration, no `managed_by` marker.

## Background — what already exists

- **Manifest persistence**: every apply POSTs a summary to `POST /api/<org>/deployments` (`deployment-routes.ts:59`), storing the redacted desired-state snapshot in `payload_data.manifest`. `GET /deployments` (feed, `deployment-routes.ts:178`) returns metadata only; `GET /deployments/:applyId` (`deployment-routes.ts:382`) returns the manifest. CLI already has `client.getDeployment(applyId)` (`client.ts:514`).
- **Manifest hash**: `computeManifestHash(state)` (`deployment.ts:90`) — sha256 of canonical redacted desired state; the server stores it as `metadata.manifest_hash`.
- **Diff verbs**: `create | update | noop | drift | delete` (`diff.ts:34`). `diffEntityType` compares whole `properties` via `deepEqual` (`diff.ts:390`) — the reason a UI edit is currently folded into `update` and clobbered.
- **Prune**: `computeDiff({ prune })` emits `delete` for any org-owned remote definition absent from desired (`diff.ts:997`), guarded by `isSystemEntityType` (`$` prefix) and the org-ownership filter (`ownsDefinition`, `diff.ts:923`).
- **Blast radius**: `confirmDeletions` re-prompts when a plan deletes >3 definitions (`apply-cmd.ts:1554`, `prompt.ts:36`).
- **Deployment statuses**: server accepts only `succeeded | partial_failure` (`deployment-routes.ts:44`).
- **`event_kinds` / `viewTemplate` are already prune-aware** (`diff.ts:412-428`): declared → diff; omitted + prune → removal; omitted + no prune → unmanaged. The new attribution generalizes this pattern to `properties` and to the "who moved" question.

## Locked decisions

1. **Fail-closed drift gate.** If the plan contains blocking drift (below), apply prints the report, exits 1, and mutates nothing — including under `--yes`. `--yes` never destroys un-declared state.
2. **Three-way attribution via the deployment manifest.** "Who moved" is `desired vs manifest` (config moved) vs `desired vs remote` (remote moved). No prior deployment → treat all `desired ≠ remote` as config-moved (converge) and all remote-only definitions as drift (never auto-delete on first apply).
3. **Field-level scope: memory schema + Behaviors.** Entity types (properties, required, name, description, backing, metrics, eventKinds, viewTemplate), relationship types, and Behaviors get per-field attribution; a remote-moved field is a blocking item. Everything else (agents, settings, connections, feeds, auth profiles, providers, connector definitions) keeps today's behavior — converge what's declared, non-blocking drift notes for the rest. Rationale: the idempotent/declared paths there emit perpetual "update" rows by design (connector-definition re-push `diff.ts:608`, BYO connection `config` always-changed `diff.ts:736`, write-only provider keys), so a whole-state gate would block forever on an untouched org.
4. **Two delete tiers.**
   - **Config-expressed** (definition was in the last-applied manifest, now absent from config): a `delete` row that **rides `--yes`** — the config PR is the review, matching Terraform's destroy-in-plan. Blast-radius confirm stays.
   - **Un-declared** (remote-only, never in a manifest): UI-created. **Never a delete row.** Reported as blocking drift; resolved by adopt or `--confirm-deletes <token>`.
5. **`prune` semantics narrow.** `prune: true` now means "this config owns deletions" with a delete set of *previously-applied-and-removed only*. It no longer deletes UI-created definitions. This is a deliberate, safe-direction breaking change (the personal-agent config relies on prune catching removed Behaviors — that still works).
6. **Token-bound confirm.** `lobu apply --confirm-deletes "lobu1:tkn_<base64url>"` carries the encoded blocking set `{ v, plan_hash, items: [{kind, id, field?, action: delete|revert}] }`. On confirm, apply recomputes the plan, verifies `plan_hash` matches the freshly-computed blocking set, verifies each item is still a drift/delete candidate, prints the decoded action list (the "seeing" step, again, at execution), and executes **exactly** the confirmed items. Any staleness → that item refuses; the rest proceed; new candidates are re-reported. A bare-slug escape hatch stays available.
7. **Adopt = minimal codegen.** Modified field → print the exact delta (e.g. `"x-lobu": { role: "workflowState" }` under `status`). New definition → print a generated `defineEntityType` skeleton plus the remote schema, flagged for review. The *surfacing* is the value; codegen is mechanical translation, never a promise of perfect config. Resolution is a normal git change to `lobu.config.ts`.
8. **Agent autonomy split by reversibility.** Adopt is a config edit (reversible, git-visible) → the reconciler agent may do it autonomously. Revert/delete is destructive → the agent may *issue* the token confirm, but it lands as `pending_approval` and a human approves the exact list via a link before it fires.
9. **No "keep" verb.** Unresolved drift stays red (apply keeps exiting 1) until adopt or revert/delete. No hidden unmanaged state. A documented ignore list is out of scope unless it nags in practice.
10. **No DB changes.** Blocked applies reuse the deployment event with a widened `status`; attribution reads existing deployment rows. Append-only `events` invariant is preserved (a blocked apply is one more append-only row).

## Phasing

### v1 (this plan) — deterministic CLI core

- Three-way attribution + field-level entity-type/Behavior diff.
- Drift gate: block + exit 1 on blocking drift; blocked report with adopt snippets and the confirm token.
- `--confirm-deletes <token>` (recompute → verify → execute exact set). Config-expressed deletes ride `--yes`.
- Blocked applies POST a deployment with `status: "blocked"` carrying the candidates + token; server widens `DEPLOYMENT_STATUSES` and exposes them.
- No agent loop: the event is emitted and a human resolves (the operator or the existing agent tooling picks it up manually).

### v2 — reconciler loop

- A `reconcile-config` Behavior watches `status: "blocked"` deployments, reads candidates + token, and per item: adopt (edit `lobu.config.ts`, open a PR), revert/delete (issue the token confirm → `pending_approval`), or leave.
- Agent PR path for adopt (requires a repo-write/PR tool on the agent). Until then, adopt prints the snippet for the operator.

## v1 work breakdown — 3 PRs

Each PR lands independently; PR-2 and PR-3 can develop in parallel after PR-1.

### PR-1 — server: accept and expose `blocked` deployments

**Branch**: `feat/apply-blocked-deployments` · **Risk**: Low · **LOC**: ~40

- `deployment-routes.ts:44` → `DEPLOYMENT_STATUSES` += `"blocked"`.
- `POST /` accepts `candidates` (the token + blocking-item list) and stores it in `payload_data` (mirrors `manifest`).
- `GET /` feed and `GET /:applyId` detail expose `status` + `candidates` for the new status. The Deployments tab renders blocked applies as a distinct state.
- Tests: POST accepts `blocked` + candidates; rejects unknown statuses as today; detail round-trips candidates.

### PR-2 — CLI: attribution, drift gate, token

**Branch**: `feat/apply-drift-gate` · **Risk**: Medium · **LOC**: ~450

- `client.ts`: `getLatestDeployment()` — feed (`limit=1`, status `succeeded|partial_failure`, prefer latest) → `getDeployment(applyId)` → manifest. Two requests, no new server read endpoint.
- `deployment.ts`: `loadLastAppliedState()` (parse manifest), token mint/verify (`mintConfirmToken`, `verifyConfirmToken`), `computeBlockingHash`.
- `diff.ts`: replace whole-`properties` deepEqual in `diffEntityType` with per-field comparison; add the three-way attribution pass against the last-applied state. New blocking-drift row shape: `{ kind, id, field?, verb: "drift", blocking: true, adoptSnippet, remoteChange }`. Delete rows only for manifest-present definitions; remote-only-absent-from-manifest becomes blocking drift (never delete). Preserve org-ownership and `$`-system guards.
- `apply-cmd.ts`: after `computeDiff`, if blocking drift exists or un-gated deletes exist → render blocked report, POST the blocked deployment, exit 1. `--confirm-deletes <token>` path: recompute, verify hash + per-item staleness, print decoded list, execute the confirmed items via the existing per-kind executors, re-report remaining. Config-expressed deletes proceed under `--yes` as today.
- `apply-cmd.ts` command surface: `--confirm-deletes <token|slug...>` (single flag, per the interview decision).
- Tests: three-way attribution table tests (manifest/desired/remote × moved-side), token mint/verify, staleness refusal, first-apply defaults, prune-narrowing regressions.

### PR-3 — CLI: blocked report + adopt snippets

**Branch**: `feat/apply-drift-report` · **Risk**: Low · **LOC**: ~200

- `render.ts`: `renderBlockedReport(plan)` — the `✖ BLOCKED` transcript: per item `kind · slug · field`, the remote-only change, the adopt snippet, and the confirm command line. `renderConfirmSummary` for the decode-at-execution step.
- Adopt snippet generator (pure function, snapshot-tested): field delta vs definition skeleton.
- Wire the blocked deployment POST (PR-1 client method) into the blocked path.
- E2E via the personal-agent scenario (see Testing).

## Footguns to avoid

Carried from `lobu-apply.md` / `lobu-pull.md`, plus new:

1. **Whole-state gate false-positives.** Never gate on the whole plan; gate only on the field-level blocking items (decision #3).
2. **Token staleness.** The token must fail closed on any recompute mismatch — never "confirm anyway." A stored/expired token is a failure, not a proceed.
3. **First-apply default.** No manifest yet → converge everything, never auto-delete remote-only definitions. A config that prunes on first apply is a config pointed at the wrong org.
4. **Manifest is redacted.** Secret-bearing fields are sentinel'd; never attribute from them (they're already always-update). Only structural fields participate.
5. **`prune` narrowing is breaking.** Existing `prune: true` configs stop deleting UI-created definitions. Surface loudly in the changelog/docs; the blast-radius confirm stays.
6. **Never delete `$`-system or foreign-org definitions** (`isSystemEntityType`, `ownsDefinition` — keep both guards in the new delete path).
7. **`event_kinds` / `viewTemplate` interplay.** The new attribution must not regress the existing declared-vs-omitted semantics (`diff.ts:412-428`) — an omitted template stays unmanaged outside prune, a remote-only one under attribution is a blocking drift item.
8. **Idempotent re-push rows excluded from blocking** (connector defs, BYO connections, provider keys) — blocking them makes apply unusable (decision #3).
9. **Concurrent applies.** Attribution reads the latest deployment; a racing apply can shift it. Document "don't run applies concurrently on one org" (same as today) — fail-closed on any ambiguous read.
10. **Agent deletes always human-approved.** Never grant an un-gated delete path to the reconciler in v1/v2 (decision #8).

## Testing strategy

### Unit

- `diff.test.ts`: three-way attribution table — (manifest, desired, remote) × outcome, for entity-type fields, relationship-type fields, Behavior fields, remote-only-in-manifest, remote-only-not-in-manifest, no-manifest, both-moved (config wins).
- `deployment.test.ts`: token mint → verify round-trip; tampered token fails; stale (changed plan) token refuses.
- `render.test.ts`: snapshot the blocked-report transcripts from the personal-agent `task` case.
- Server: PR-1 POST/GET round-trip for `blocked` + candidates.

### End-to-end (this plan's exit criterion)

Boot local cloud (bootstrap path per `lobu-apply.md` E2E). Reference project: `examples/personal-agent` (org `buremba`, `prune: true`).

1. `lobu apply --yes` from a clean tree → all noops.
2. Add the board annotation in the UI (`manage_entity_schema` on `task.status`) → `lobu apply` → assert `✖ BLOCKED`, exact transcript, token printed, exit 1.
3. `lobu apply --confirm-deletes <token>` → assert decode line, deletion/revert of the annotation, exit 0.
4. Re-add annotation → apply blocked → apply the printed adopt snippet to `lobu.config.ts` → `lobu apply` → green, no drift.
5. Create `contact` in the UI → apply → blocked (never a delete row) → `--confirm-deletes <token>` → gone.
6. Remove a previously-applied type from `lobu.config.ts` → `lobu apply --yes` → config-expressed delete proceeds.
7. `--yes` with blocking drift → exits 1, nothing mutated (assert via GET).

## Cross-cutting concerns

- **Auth / org**: blocked deployment POST uses the same apply-id threading and `requireSessionOrAdminPat` as today; attribution reads org-scoped deployment events only.
- **Append-only**: a blocked apply is one append-only deployment event; never tombstone or supersede it. The reconciler watches `status: "blocked"` rows.
- **Multi-replica**: no new shared mutable state. Manifest reads are org-scoped single-row lookups on the existing `(org, semantic_type, metadata->category)` index — bounded, not a history aggregation.
- **Naming**: user/agent-facing surface says **Behavior**, never `watcher`. The `--confirm-deletes` flag covers both delete (definition) and revert (field) — the token decode names each item's action, so one flag stays simple.

## Stacking & ordering

```
   lobu-apply v1 (merged)
            │
            ▼
   docs/lobu-apply-drift-gate  (this doc)
            │
   ┌────────┼────────┐
   ▼        ▼        ▼
 PR-1     PR-2     PR-3
 (server, (CLI core,  (CLI report,
  small)   medium)    small)
            │
            ▼
     E2E (this session)
            │
            ▼
   v2: reconcile-config Behavior + agent PR path
```

PR-1 is independent and can land first. PR-2/PR-3 are CLI-side and develop in parallel. v2 (the agent loop) depends on v1's blocked-deployment event + token being live.

## Non-goals (for the avoidance of doubt)

- ❌ Full `lobu pull` (see `lobu-pull.md`) — adopt is targeted write-back, not a converger.
- ❌ LLM judgment *inside* `lobu apply` — the CLI stays deterministic; judgment is the reconciler's.
- ❌ Reconcile-config Behavior / agent PR automation (v2).
- ❌ Per-field "unmanaged" annotations in the schema (the Rule-4 hack — rejected in design; adopt-into-config replaces exemptions).
- ❌ Ignore list / "keep" verb.
- ❌ Field-level attribution for settings/connections/providers (out of the pain surface; revisit only if it nags).
- ❌ New DB table, `managed_by` marker, or server-side state.
- ❌ Bidirectional sync.

If any of these turn out to be hard requirements during real use, they get their own plan and PR; v1 ships small.
