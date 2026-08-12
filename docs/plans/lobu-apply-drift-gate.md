# `lobu apply` drift gate & reconcile — Plan

Status: **v1 shipped in PR #2663** (token + `--bootstrap` + adopt codegen deferred — see "What actually shipped") · Owner: @buremba · Builds on `lobu-apply.md` (v1 merged) · Related to `lobu-pull.md` (shares the attribution record) · Reviewed against pi second-opinion: 7 rounds hardened an earlier, stronger fail-closed contract; **revised to a narrowed contract** (coordination-design-brake); rounds 8–12 on the narrowed contract each closed 1–2 blockers (baseline evolution, `--only` scope, mixed-plan confirm, token→full-plan binding, write-only `reaction_script`, mandatory index) — re-review pending

## Goal

Make `lobu apply` stop silently destroying **un-declared** remote state, while keeping the config authoritative for everything it declares. Today a config-managed org with `prune: true` (e.g. `examples/personal-agent`, org `buremba`) does two harmful things to manual work done in the web UI:

- a UI edit to a declared definition (adding `x-lobu.role` to `task.status`) → `update` row → apply overwrites it;
- a UI-created definition (`contact`) → `delete` row → apply proposes deleting it.

The contract, **narrowed**:

1. **Config-declared state converges, config wins** (Terraform semantics) — including a UI edit that lands in the plan-to-execute window. This is the declared owner's behavior, not an accident.
2. **Un-declared remote state is never clobbered or auto-deleted.** A remote-only change or remote-only definition blocks the apply (non-zero exit, no mutation) and is reported with an **adopt** snippet or a **named delete** (`--confirm-deletes`).
3. **Never auto-delete a UI-created definition.** Delete eligibility is config-expressed only.
4. The **reconciler agent** gets clean, safe options: adopt (autonomous, git-visible) or delete/revert (approval-gated, named).

## Why not the full fail-closed contract

Seven review rounds hardened an earlier version that promised "never lose any UI edit, under any race, across crashes" — and each round surfaced a real but *diminishing* gap in the distributed state machine built to honor it (org admission, two-phase baseline, per-write optimistic preconditions, crash recovery). That machinery is stronger than Terraform or ArgoCD provide, and it grew into exactly the shape the coordination-design-brake warns about (a second lock, a retry/recovery budget, prose termination arguments). The residual risks of the narrowed contract are small, well-understood, and documented below; the machinery to close them is deferred to its own plan if it ever nags.

## Mental model

```
   attribution snapshot          desired (lobu.config.ts)          remote (cloud)
   (effective remote after           │                              │
    last succeeded apply)            │                              │
          └────────────────────────┬─┴──────────────┬──────────────┘
                                   └───── three-way compare ─────┘

   desired == remote                          → noop
   remote == attribution AND desired ≠ remote → config moved  → converge (update)
   desired ≠ remote AND remote ≠ attribution  → remote moved / both moved → BLOCK (drift/adopt/named-delete)
   remote-only definition, IN the baseline's `owned` set AND remote == attribution
                                              → config-expressed delete  → rides --yes
   remote-only definition, IN `owned` set AND remote ≠ attribution
                                              → edited after baseline → BLOCK (both moved)
   remote-only definition, NOT in an `owned` set
                                              → UI-created → drift (adopt / named delete)
   no baseline (never applied / summary lost) → creates converge; every remote mismatch
                                               and remote-only definition → BLOCK (no attribution)
```

Convergence happens **only when the remote is untouched** (`remote == attribution`). If both config and a concurrent UI edit moved the same field, that field blocks — never let config silently win over a user's edit. Creates converge naturally (both remote and attribution absent). The config-expressed delete tier is conditional: a definition edited in the UI after the baseline is a both-moved block, not a delete.

The baseline is a **versioned `{ desired, attribution, owned }` record** stored in the deployment event's `payload_data`:
- **`desired`** — the redacted desired-state snapshot, the **rollback target** (`lobu rollback` re-applies it; unchanged semantics from today).
- **`attribution`** — the **effective remote values after the apply**, used for the three-way compare. It must capture facets the config never declared — e.g. `eventKinds`/`viewTemplate` that are prune-aware and intentionally preserved remotely but absent from `desired` — so `remote == attribution` correctly means "unchanged since last apply" and an unmanaged facet doesn't permanently block a config-expressed delete.
- **`owned`** — the set of **kind-qualified definition incarnation identities** `{ kind, id }` (kind ∈ entity-type | relationship-type | behavior | connector-definition; ids from independent domains: `entity_types.id`, `entity_relationship_types.id`, `behavior_id`, `connector_definitions.id`) **this config actually applied** (delete-eligible). Qualifying by kind is load-bearing: the ID domains are independent, so an unqualified set can collide across kinds (e.g. `entity_types.id = 5` and `behavior_id = 5`) and misclassify a UI-created definition as owned. Storing `{ kind, id }`, never slugs or connector key+version, is what makes delete eligibility sound: a config-expressed delete that succeeds and then has its summary POST fail leaves the identity in `owned`; if the user re-creates the same slug (or re-installs the same connector key/version — uninstall archives the row, so a reinstall is a **new `connector_definitions.id`**) in the UI, the new row has a **new id** and is therefore **not owned** — it blocks as drift instead of being auto-deleted under `--yes`.

Real applies populate all three; bootstrap populates `attribution` and an **empty `owned` set**.

## Background — what already exists

- **Manifest persistence**: every apply POSTs a summary to `POST /api/<org>/deployments` (`deployment-routes.ts:59`), storing the redacted desired-state snapshot in `payload_data.manifest`. `GET /deployments` (feed, `deployment-routes.ts:178`) returns metadata only; `GET /deployments/:applyId` (`deployment-routes.ts:382`) returns the manifest. CLI already has `client.getDeployment(applyId)` (`client.ts:514`).
- **Baseline gap**: an **all-noop apply does not POST a summary** (`apply-cmd.ts:1535-1538`) — so the baseline does not track the last *endorsed* config unless apply always records it (decision #2). The feed also **mixes deployment events with standalone config changes** and has no status filter — a `limit=1` client-side lookup is ambiguous (PR-1 adds a dedicated latest-succeeded read).
- **Manifest hash**: `computeManifestHash(state)` (`deployment.ts:90`).
- **Diff verbs**: `create | update | noop | drift | delete` (`diff.ts:34`). `diffEntityType` compares whole `properties` via `deepEqual` (`diff.ts:390`) — the reason a UI edit is currently folded into `update` and clobbered.
- **Prune**: `computeDiff({ prune })` emits `delete` for any org-owned remote definition absent from desired (`diff.ts:997`), guarded by `isSystemEntityType` and the org-ownership filter (`ownsDefinition`, `diff.ts:923`).
- **Blast radius**: `confirmDeletions` re-prompts when a plan deletes >3 definitions (`apply-cmd.ts:1554`, `prompt.ts:36`).
- **`event_kinds` / `viewTemplate` are already prune-aware** (`diff.ts:412-428`): declared → diff; omitted + prune → removal; omitted + no prune → unmanaged.

## Locked decisions

1. **Fail-closed drift gate on un-declared state.** If the plan contains blocking drift (a remote-only change to a declared definition, or a remote-only definition), apply prints the report, exits non-zero (`2`, the CLI's `ValidationError` code), and mutates nothing — including under `--yes`. `--yes` never destroys un-declared state.
2. **Three-way attribution via the baseline.** `noop` when desired == remote; **converge only when `remote == attribution`**; **block whenever `remote ≠ attribution AND desired ≠ remote`** (remote-move or both-moved). The compare uses the **`attribution` snapshot (effective remote after the apply)**, never the `desired` state — unmanaged facets (`eventKinds`/`viewTemplate`) live remotely but not in `desired`, so `desired`-based attribution would permanently block config-expressed deletes.    **No-baseline blocks** (creates converge; remote mismatches and remote-only definitions block) — a missing baseline is ambiguous (never applied vs. lost summary) and a config-wins default would silently overwrite UI state. The **baseline advances only on a fully-succeeded run, including all-noop runs** (apply must POST the summary on noops, `apply-cmd.ts:1535`). **Scope-preserving:** a **`--only agents|memory`** run advances the baseline **only for its executed family**, carrying forward the unexecuted families from the prior baseline (a per-family composite). The baseline separates **`attribution`** from **`owned`**: real applies populate both; bootstrap populates attribution with an empty `owned` set. **`lobu rollback` bypasses the drift gate** — it is an explicit operator restore of a recorded `desired` state and force-converges to it (config-wins), then re-records the baseline; rollback must never be blocked as "remote moved" by the no-baseline gate.
3. **Field-level scope: memory schema + Behaviors.** Entity types (properties, required, name, description, backing, metrics, eventKinds, viewTemplate, resolutionPolicy), relationship types, and Behaviors get per-field attribution; a remote-moved field is a blocking item. **Write-only Behavior `reaction_script` is exempt** — the server never returns it, `diffWatcher` always re-pushes it (idempotent), so it is never attributed or blocked. **Connector definitions are excluded from field-level attribution** (their source is re-pushed idempotently — never field-blocked) **but included in the owned-based delete classification** (decision #4), so a UI-created connector is never auto-deleted. Everything else (agents, settings, connections, feeds, auth profiles, providers) keeps today's behavior — converge what's declared, non-blocking drift notes. Rationale: the idempotent/declared paths there emit perpetual "update" rows by design (connector-definition re-push `diff.ts:608`, BYO connection `config` always-changed `diff.ts:736`, write-only provider keys).
4. **Two delete tiers.**
   - **Config-expressed** (the remote definition's **incarnation ID** is in the baseline's **`owned` set**, now absent from config, **and `remote == attribution`**): a `delete` row that **rides `--yes`** — the config PR is the review, matching Terraform's destroy-in-plan. Blast-radius confirm stays. If edited in the UI after the baseline (`remote ≠ attribution`) it is a both-moved block, never a delete. A **same-slug UI recreation carries a new incarnation ID**, so it is never owned and never auto-deleted.
   - **Un-declared** (remote-only, never in an `owned` set): UI-created. **Never a delete row.** Blocking drift; resolved by adopt or a **named delete** (`--confirm-deletes`).
   **Connector definitions follow the same two tiers** — UI-created/unowned connectors are never deleted, previously-applied-and-unchanged ones delete under prune, post-baseline edits block — with the existing protection that a connector still referenced by a remote connection/auth-profile (`liveConnectorKeys`) is never deleted.
5. **`prune` semantics narrow.** `prune: true` means "this config owns deletions" with a delete set of *previously-applied-and-removed only*. It no longer deletes UI-created definitions. Safe-direction breaking change.
6. **Named-delete confirm, plan-bound and origin-bound.** `lobu apply --confirm-deletes "lobu1:tkn_<base64url>"` carries `{ v, plan_hash, api_origin, organization_id, items: [{kind, id, field?, action: delete|revert}] }`. The token's **`plan_hash` covers the entire executable plan** — blocking/destructive rows *and* ordinary config rows — so any recompute mismatch (including an ordinary config update introduced after minting) rejects the **entire** token; the `items` list names the **destructive subset** it authorizes, printed again at execution (the "seeing" step). On a clean hash, apply **executes the complete recomputed plan** — the destructive subset authorized by the token, ordinary config updates as normal config-wins work — so the finalized baseline always matches what ran. No partial execution, ever. The payload is bound to origin + org, so a token cannot authorize the same actions elsewhere. A bare-slug escape hatch stays available.
7. **Adopt = minimal codegen.** Modified field → print the exact delta (e.g. `"x-lobu": { role: "workflowState" }` under `status`). New definition → print a generated `defineEntityType` skeleton plus the remote schema, flagged for review. Resolution is a normal git change to `lobu.config.ts`.
8. **Agent autonomy split by reversibility.** Adopt is a config edit (reversible, git-visible) → the reconciler agent may do it autonomously. Delete/revert is destructive → the agent may *issue* the named delete, but it lands as `pending_approval` and a human approves the exact list via a link before it fires.
9. **No "keep" verb.** Unresolved drift stays red until adopt or delete/revert. A documented ignore list is out of scope unless it nags.
10. **Minimal DB/API footprint, surfaced for approval.** `DEPLOYMENT_STATUSES` widens with `blocked`; blocked applies POST a deployment carrying the candidates + token. New read `GET /deployments/latest` (latest `succeeded` deployment incl. manifest) — the mixed feed cannot answer it reliably. **Mandatory additive partial index** on `events` for that read (see PR-1) — without it the lookup would scan unbounded append-only history. No new columns, no new tables.

## Narrowed contract — documented residual risks

These are the deliberate limits of the narrowed contract, written down so nobody mistakes them for gaps:

- **Plan-to-execute race is config-wins.** A UI edit landing between the plan and the write on a **config-declared** field is overwritten — the config is the declared owner (Terraform semantics). Un-declared state is still never touched in that window because blocking drift halts before any write.
- **Concurrent applies are not serialized.** Two applies on the same org can interleave; this plan assumes a single reconciler path (one Behavior → one apply). A future need for concurrent applies gets its own admission design.
- **Baseline staleness over-blocks, never under-blocks.** A summary POST failure or partial failure leaves the baseline at the last `succeeded` run; subsequent attribution over-blocks (remote-only changes look remote-moved). Residual misattribution is possible but always in the config-wins direction on declared fields — never destruction of un-declared state.
- **`bootstrap` grants attribution only.** `lobu apply --bootstrap` snapshots current remote as the baseline with an **empty `owned` set** — it never makes pre-existing UI-created definitions delete-eligible.

## Phasing

### v1 (this plan) — deterministic core

- Field-level attribution + drift gate: block + non-zero exit on blocking drift; blocked report with adopt snippets and the named-delete token.
- `--confirm-deletes <token|slug...>`; config-expressed deletes ride `--yes`. **(deferred — see "What actually shipped")**
- Baseline advances on every fully-succeeded run including noop.
- Blocked applies POST a `blocked` deployment with the candidates + token.
- No agent loop: the event is emitted and a human (or existing agent tooling) resolves it.

### v2 — reconciler loop

- A `reconcile-config` Behavior watches `blocked` deployments, reads candidates + token, and per item: adopt (edit `lobu.config.ts`, open a PR), delete/revert (issue the named delete → `pending_approval`), or leave.
- Agent PR path for adopt (requires a repo-write/PR tool). Until then, adopt prints the snippet.

## v1 work breakdown — 3 PRs

**Dependency order**: PR-1 (server) lands first; PR-2 and PR-3 build on it.

### What actually shipped (PR #2663 — PR-1 + PR-2 + PR-3 combined)

The three PRs landed as one branch. **Shipped**: `blocked` deployment status + `candidates` payload, `GET /deployments/latest` + its partial index, the connector incarnation id in the catalog, the `{ attribution, owned }` baseline in the manifest, three-way field attribution for entity/relationship types and Behaviors, the owned-based two-tier delete classification (including connectors), the fail-closed drift gate (exit `2`, nothing mutated, blocked deployment POSTed), the `✖ BLOCKED` report, baseline advance on all-noop and `--only`-scoped runs, and the rollback bypass + baseline re-record.

**Deferred to a follow-up** (the gate is complete without them; resolution today is adopt-into-config or delete in the UI/API):

- `--confirm-deletes <token|slug…>` and the mint/verify token (`mintConfirmToken`, `verifyConfirmToken`, `computeBlockingHash`). Blocked deployments record `candidates.items` with no token; the wire type already carries the optional `token` field.
- `--bootstrap` (snapshot current remote as attribution with an empty `owned` set). Existing orgs establish their first baseline the same way this PR does everywhere else: a definition the apply would not change is a noop and enters the baseline; anything else blocks.
- Adopt-snippet codegen. The blocked report names `kind · slug · field` and prints the remote value; it does not generate the `defineEntityType` skeleton.

The token/flag bullets in PR-2 and PR-3 below therefore describe the follow-up, not this branch.

### PR-1 — server: blocked deployments + latest read

**Branch**: `feat/apply-blocked-deployments` · **Risk**: Low · **LOC**: ~60

- `deployment-routes.ts:44` → `DEPLOYMENT_STATUSES` += `"blocked"`.
- `POST /` accepts `candidates` (the token + blocking-item list) and stores it in `payload_data` (mirrors `manifest`).
- `GET /` feed and `GET /:applyId` detail expose `status` + `candidates`. The Deployments tab renders blocked applies distinctly. The connector catalog response **exposes `connector_definitions.id`** (the connector incarnation ID used by `owned` — surfaced for approval).
- **New read `GET /deployments/latest`**: the latest deployment with `status = 'succeeded'` (org-scoped, `category='deployment'`, status filter, `ORDER BY id DESC LIMIT 1`), including its manifest. **API-surface change — surfaced for approval.** **Mandatory additive partial index** on `events`: `(organization_id, id DESC) WHERE semantic_type='change' AND metadata->>'category'='deployment' AND metadata->>'status'='succeeded'` — without it the lookup would scan unbounded newer blocked/config rows through the general index, violating the bounded-indexed-read contract for append-only history. **DB change — surfaced for approval** (index only, no columns/tables). Include an `EXPLAIN`-backed verification that the lookup hits the partial index.
- Tests: POST accepts `blocked` + candidates; rejects unknown statuses as today; detail round-trips candidates; `/latest` returns the newest succeeded deployment with standalone/blocked rows ignored.

### PR-2 — CLI: attribution, drift gate, token

**Branch**: `feat/apply-drift-gate` · **Risk**: Medium · **LOC**: ~400

- `client.ts`: `getLatestDeployment()` (PR-1) → the baseline `{ desired, attribution, owned }`. Only `succeeded` baselines count.
- `deployment.ts`: `loadLastAppliedState()` (parse the baseline), token mint/verify (`mintConfirmToken`, `verifyConfirmToken`), `computeBlockingHash`; rollback path force-converges to `desired` and bypasses the drift gate (decision #2).
- `diff.ts`: replace whole-`properties` deepEqual in `diffEntityType` with per-field comparison (including `resolutionPolicy`); add the three-way attribution pass against the **`attribution` snapshot** (converge only when `remote == attribution`; block when `remote ≠ attribution AND desired ≠ remote`; no-baseline blocks). Blocking-drift row: `{ kind, id, field?, verb: "drift", blocking: true, adoptSnippet, remoteChange }`. Delete rows only for definitions whose **incarnation ID is in the baseline's `owned` set** and whose remote still matches `attribution`; remote-only-absent-from-owned and edited-after-baseline become blocking drift. Preserve org-ownership and `$`-system guards.
- `rollback-cmd.ts`: rollback supplies or bypasses attribution (explicit restore, force-converge to `desired`, re-record the baseline) — never blocked as no-baseline drift.
- `apply-cmd.ts`: after `computeDiff`, if blocking drift exists or un-gated deletes exist → render blocked report, POST the blocked deployment, exit non-zero. `--confirm-deletes <token>`: recompute, **verify the hash against the entire executable plan** (any mismatch — including an ordinary config update introduced after mint — rejects the entire token), print the destructive subset, then **execute the complete recomputed plan**. Config-expressed deletes proceed under `--yes` as today. **POST the summary on every fully-succeeded run including all-noop** — a **`--only` run advances the baseline per its executed family only** (decision #2). `lobu apply --bootstrap` snapshots current remote into `attribution` with an **empty `owned` set**.
- Command surface: `--confirm-deletes <token|slug...>` (single flag), `--bootstrap` (new flag — surfaced for approval).
- Tests: three-way attribution table, token mint/verify, staleness refusal, no-baseline block, edited-after-baseline delete block, prune-narrowing regressions.

### PR-3 — CLI: blocked report + adopt snippets

**Branch**: `feat/apply-drift-report` · **Risk**: Low · **LOC**: ~200

- `render.ts`: `renderBlockedReport(plan)` — the `✖ BLOCKED` transcript: per item `kind · slug · field`, the remote-only change, the adopt snippet, and the named-delete command line. `renderConfirmSummary` for the decode-at-execution step.
- Adopt snippet generator (pure function, snapshot-tested): field delta vs definition skeleton.
- E2E via the personal-agent scenario (see Testing).

## Footguns

1. **Gate only the field-level blocking items**, never the whole plan (the idempotent re-push rows would block forever — decision #3).
2. **Token staleness**: any recompute mismatch rejects the **entire** token — no partial execution.
3. **No-baseline is never config-wins** — block remote mismatches; only `--bootstrap` establishes a baseline.
4. **Manifest is redacted**: never attribute from secret-bearing fields (already always-update).
5. **`prune` narrowing is breaking** — surface loudly; the blast-radius confirm stays.
6. **Never delete `$`-system or foreign-org definitions** (`isSystemEntityType`, `ownsDefinition`).
7. **`event_kinds` / `viewTemplate`**: don't regress the declared-vs-omitted semantics (`diff.ts:412-428`).
8. **Idempotent re-push rows excluded from blocking** (connector defs, BYO connections, provider keys, **write-only Behavior `reaction_script`** — always-repush, never attributed, or they block forever).
9. **Stale baseline**: an all-noop apply must advance the baseline, or a later UI edit is misattributed as config-moved. A stale baseline over-blocks, never under-blocks.
10. **Bootstrap never grants ownership**: delete classification consults `owned`, never raw manifest/`desired` membership.
11. **`--only` advances the baseline per executed family** — whole-baseline replacement snapshots never-executed state; no-advance leaves the executed family stale. Carry forward unexecuted families from the prior baseline (decision #2).
12. **Rollback bypasses the drift gate** — an explicit operator restore of a recorded `desired` state must never be blocked as no-baseline drift (decision #2).
13. **Agent deletes always human-approved** (decision #8).
14. **Connector deletes follow the owned tiers** — never auto-delete a UI-created/unowned connector; keep the `liveConnectorKeys` protection for referenced connectors (decision #4).
15. **`owned` is incarnation IDs, never slugs** — a delete-with-lost-summary followed by a same-slug UI recreation must block as drift (new id), not auto-delete under `--yes` (decision #4).

## Testing strategy

### Unit

- `diff.test.ts`: three-way attribution table — (attribution, desired, remote) × outcome, for entity-type fields (including `resolutionPolicy`), relationship-type fields, Behavior fields, remote-only-in-owned, remote-only-in-owned-but-edited-after-baseline → block, remote-only-not-in-owned, no-baseline → block, both-moved → block, **an unchanged unmanaged facet (`eventKinds`/`viewTemplate`) does not block a config-expressed delete, but a post-baseline edit to one does**, **a same-slug UI recreation (new incarnation ID) after a delete-with-lost-summary is never auto-deleted — it blocks as drift**. **Connector cases**: UI-created/unowned → never deleted; previously-applied-and-unchanged → deleted under prune; post-baseline edit → block; bootstrap grants no connector ownership; a referenced connector (`liveConnectorKeys`) is never deleted; **uninstall → failed summary POST → same-key/same-version UI reinstall yields a new `connector_definitions.id` that is unowned and blocks, never auto-deleted**; **cross-kind ID collisions (e.g. `entity_types.id = behavior_id`) never make a UI-created definition delete-eligible (`{ kind, id }` ownership)**; same-slug relationship-type recreation after a delete-with-lost-summary blocks as drift.
- `deployment.test.ts`: token mint/verify round-trip; tampered/stale token (any item changed) rejects the whole token; cross-org/origin token rejected; **a config update introduced after token mint rejects the token (hash covers the entire executable plan), so nothing executes without fresh confirmation**; mixed-plan confirm (blocking drift + ordinary config update) executes the full recomputed plan and finalizes the baseline to match; **write-only `reaction_script` never blocks (always-repush preserved)**; **rollback force-converges to `desired` and is never blocked as no-baseline drift**; baseline (noop run advances, **a `--only` run advances only its executed family and carries forward the rest**, partial_failure does not, missing baseline over-blocks; bootstrap populates attribution with an empty owned set).
- `render.test.ts`: snapshot the blocked-report transcripts from the personal-agent `task` case.
- Server PR-1: POST/GET round-trip for `blocked` + candidates; `/latest` uses the mandatory partial index (`EXPLAIN`-verified; ignores interleaved standalone/blocked rows).

### End-to-end (this plan's exit criterion)

Boot local cloud (bootstrap path per `lobu-apply.md` E2E). Reference project: `examples/personal-agent` (org `buremba`, `prune: true`).

1. `lobu apply --yes` from a clean tree → all noops; assert a `succeeded` deployment was POSTed (baseline advanced on the noop run) and `GET /deployments/latest` returns it.
2. Add the board annotation in the UI (`manage_entity_schema` on `task.status`) → `lobu apply` → `✖ BLOCKED`, exact transcript, non-zero exit.
3. `lobu apply --confirm-deletes <token>` → decode line, revert of the annotation, exit 0.
4. Re-add annotation → apply blocked → apply the printed adopt snippet to `lobu.config.ts` → `lobu apply` → green.
5. Create `contact` in the UI → apply → blocked (never a delete row) → `--confirm-deletes <token>` → gone.
6. Remove a previously-applied type from `lobu.config.ts` (no UI edits since baseline) → `lobu apply --yes` → config-expressed delete proceeds. Repeat with a UI edit after baseline → blocks as both-moved.
7. `--yes` with blocking drift → exits non-zero, nothing mutated.
8. Blocked → confirm with a stale token (make a second UI edit first) → whole token rejected, nothing mutated.
9. **Mixed plan**: a blocked plan containing both a blocking drift item AND an ordinary config update → `--confirm-deletes <token>` executes the full recomputed plan (destructive item authorized by the token, config update converged), and the finalized baseline matches what ran; the next apply does not misclassify the config update as drift.
10. No-baseline org: `--bootstrap` snapshots current remote (explicit confirm); immediately after, `lobu apply --yes` must NOT prune the pre-existing remote-only definitions (attribution ≠ ownership).
11. `--only` scope: baseline A → `lobu apply --only memory` applies config B (succeeds; memory family advanced, agents family carried forward) → change config to C → a full `lobu apply` **converges C normally** instead of blocking it as both-moved; assert the scoped run is in deployment history. Repeat with `--only agents`.
12. Rollback: apply a config, then `lobu rollback` to an earlier deployment → force-converges to the recorded `desired` state (no drift-gate block), baseline re-recorded; subsequent applies are consistent.
13. Unmanaged facet: a config-declared type with a UI-authored `viewTemplate` (unmanaged) → removing the type from config with no other UI edits performs the config-expressed delete; editing the template after the baseline blocks as both-moved.

## Cross-cutting concerns

- **Auth / org**: blocked deployment POST uses the existing apply-id threading and `requireSessionOrAdminPat`; attribution reads org-scoped deployment events only.
- **Append-only**: a blocked apply is one append-only deployment event; never tombstone or supersede it. The reconciler watches `status: "blocked"` rows.
- **Multi-replica**: no new shared mutable state. Manifest reads are org-scoped single-row lookups (bounded, not a history aggregation). The narrowed contract explicitly does not serialize concurrent applies (documented residual risk) — the reconciler is a single path.
- **Naming**: user/agent-facing surface says **Behavior**, never `watcher`. `--confirm-deletes` covers both delete (definition) and revert (field) — the token decode names each item's action.

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
 (server, (CLI     (CLI
  small)   core,    report,
          medium)  small)
            │
            ▼
     E2E (this session)
            │
            ▼
   v2: reconcile-config Behavior + agent PR path
```

PR-1 lands first; PR-2/PR-3 build on it. v2 (the agent loop) depends on v1's blocked-deployment event + token being live.

## Non-goals (for the avoidance of doubt)

- ❌ Full `lobu pull` (see `lobu-pull.md`) — adopt is targeted write-back, not a converger.
- ❌ LLM judgment *inside* `lobu apply` — the CLI stays deterministic; judgment is the reconciler's.
- ❌ Reconcile-config Behavior / agent PR automation (v2).
- ❌ Per-field "unmanaged" annotations in the schema (adopt-into-config replaces exemptions).
- ❌ Ignore list / "keep" verb.
- ❌ Field-level attribution for settings/connections/providers.
- ❌ **The full fail-closed contract** — org admission, two-phase baseline, per-write optimistic preconditions, crash/partial-failure recovery. Deferred to a separate plan if concurrent applies or adversarial races ever demand it; the narrowed contract's residual risks are documented above.
- ❌ New DB tables or columns (the **mandatory** `/latest` partial index is the entire DB footprint).
- ❌ Bidirectional sync.

If any of these turn out to be hard requirements during real use, they get their own plan and PR; v1 ships small.
