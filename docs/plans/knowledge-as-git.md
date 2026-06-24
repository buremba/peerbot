# Knowledge-as-Git: Architecture Brief

*Turning the Lobu org knowledge graph into a branchable, cloneable filesystem that agents and humans both read and write.*

Status: design synthesis (decisions locked where noted; spikes in flight). Audience: Lobu eng + founders.

---

## TL;DR — the bet

Stop thinking of it as "a filesystem product" and think of it as **git for your org's knowledge**: markdown is the working tree, agents are the primary committers, and an agent's work is a *transaction* you review as a diff and approve in one go. Lobu already **is** most of this — `events` (append-only) is the commit log, `current_event_records` is the working-tree HEAD, connectors are mounts, `./workspaces/{agentId}/` is scratch, supersession is a commit. The product is the missing *noun and wire format* over primitives that already exist.

The one rule that keeps it coherent: **Postgres/`events` stays canonical; the filesystem (and git) is a projection — a rebuildable read model, never the source of truth.**

---

## 1. The model in one paragraph

- **Projection, not storage.** Entities render from Postgres into markdown; the FS holds no durable state.
- **A branch is a runtime filter, not a copy.** All writes land in the one `events` table tagged with the producing run; a session sees `committed OR owning_run = me`; everyone else sees `committed`. No new ID namespace — the **run id is the branch id, the transaction id, and the provenance link**, all three.
- **A commit is a status flip.** Approve = flip the run's staged events to live (atomic append; visible to all replicas instantly). Discard = GC. Append-only stays intact.
- **run = commit.** One git commit per approved run/transaction. The curated git log is human-scale; the raw event firehose stays in Postgres.

This dodges the single biggest trap in the agent-filesystem literature: every reference copy-on-write impl (BranchFS, AgentFS, overlayfs, Mirage) keeps the per-session delta in *pod-local* state and needs Redis/FUSE to share it. Putting the staged events in Postgres and branching via a read filter is multi-replica-correct for free.

---

## 2. Decisions locked (with the prior-art receipt)

| Decision | Choice | Why / who proved it |
|---|---|---|
| Source of truth | **Postgres canonical, FS/git = projection** | Plan 9, sysfs, Datasette; Dolt camp beats Keystatic camp for event-sourced data (rate limits, drift, single-writer, textual merge all avoided) |
| Branch mechanism | **Runtime visibility filter over one `events` table** | Neon (branch = WAL watermark), git (branch = 40-byte ref); extends `current_event_records` masking |
| Transaction id | **Reuse the run id** (no new txn id) | OpenLineage: every fact references the run that produced it — same id is branch + txn + lineage |
| Commit | **Status flip on staged events; discard = GC** | irmin append-only `base ∪ branch_appends`; Lobu supersession already encodes it |
| Agent write unit | **Freeform file edit; structure imposed at the commit boundary** — frontmatter parses deterministically into typed field events (YAML keys = schema fields), body → a note event | markform (patch-ops + per-field role); "raw byte-write-as-update is where data loss lives" is unanimous, but deterministic frontmatter parse sidesteps it |
| Reads | **Files (grep/cat/ls)** | Vercel: $1.00 → $0.25/call + quality up by swapping retrieval tools for grep; Mintlify ~460x over RAG |
| Side-effects | **Out of the atomic commit** (Mirage Class A only); write-back = Class B; world-actions = Class C as tracked post-commit | Plan 9 ctl convention; Mirage #138 defers Class B/C |
| Write-back to source | **Per-connector opt-in** (internal-only default) | hardest problem; two-way-sync vendors say echo-suppression + optimistic concurrency are non-optional |
| Approval granularity | **Atomic per transaction** (cherry-pick falls out as "flip a subset") | matches "commit in one go" |
| Conflict policy | **Optimistic; surface, never silent LWW** | git ref CAS gives it free; same-field collision → conflict card, keep the loser value |

---

## 3. The layered architecture

Maps onto the History / Memory / Scratchpad triad the agent-memory literature converged on:

- **History** = `events` (immutable, append-only) — the commit log.
- **Memory** = `current_event_records` projection — the read filesystem (HEAD).
- **Scratchpad** = a run's `.scratch/` — ephemeral, never promotable.

The projected tree:

```
/                              # committed HEAD — projection of current_event_records
  people/<slug>.md             # typed YAML frontmatter + prose body + ## Timeline (with provenance)
  people/<slug>.events         # this entity's append-only log → git-blame / lineage source
  companies/<slug>.md
  .types/person.yaml           # schema-as-code: typed fields, relations, computed
  .types/person.migrations/    # a type change is its own reviewed transaction (migrates existing files)
  .sources/jira/PROJ-412.md    # connector mount, read-only by default
  .sources/jira/.ctl           # write 'sync' / 'push' here → side-effects on control files, not data saves
  .runs/run-7f3a/              # open transaction = runtime-filtered overlay
    people/<slug>.md           # HEAD + this run's staged edits (read-your-own-write)
    .diff                      # the proposed changeset — approve/reject surface
    .conflicts                 # populated only if HEAD moved under the branch
    .scratch/                  # ephemeral; never promoted
```

Reference fields key on **stable immutable entity IDs**, not slugs/filenames (every file tool that keyed on slug — Keystatic, Foam — silently breaks on rename). The link in frontmatter is a display projection of an FK Lobu already has.

---

## 4. What's reused vs net-new (from the code grounding)

**Already there (reused):**

| Primitive | Maps to | Where |
|---|---|---|
| Entity types + `entities` (JSONB metadata) | dirs + files + frontmatter | `entity-management.ts`, baseline.sql |
| `events` append-only + `supersedes_event_id` | commit log + commit/squash | `insert-event.ts`, baseline.sql |
| `current_event_records` view (masks superseded) | working-tree HEAD | baseline.sql |
| Connectors (`ConnectorRuntime`, `sync()`, run checkpoints) | mounts + incremental cursors | `connector-runtime.ts` |
| `./workspaces/{agentId}/` (per-conversation dir) | scratch FS | `workspace.ts` |
| `save_memory`/`save_knowledge` (insertEvent) | the write op | `save_content.ts` |
| `search_memory` (FTS + pgvector) | content/semantic index | `search.ts` |
| `entity_relationships` (directional tuples) | links between files | `entity-management.ts` |
| `metadata_schema` / `event_kinds` on entity types | frontmatter contract | `member-entity-type.ts`, `entity-schema.ts` |

**Net-new to build:**
1. The **`entity_current` rollup table** — the canonical render store, maintained on run-commit (~4.7ms/entity; whole-org render 82ms→1.3ms, single 0.005ms; measured). Clones render from it, never from `current_event_records` (which force-joins the 1.25 GB `event_embeddings` into every read).
2. The **branch filter + `.diff` + approve(flip)/discard(GC)** transaction loop, keyed on run id.
3. **`.types/` schema-as-code** + validation-at-commit + migrations (today validation is insert-time, additive only).
4. The **synthetic git remote** (clone = projection; push = event translation) — see §5.
5. The **conflict/merge** path (optimistic base-event check; field-aware 3-way merge; conflict-as-data).
6. Per-connector **write-back** (two-way sync; deferred).

**Hardest problems (given multi-replica + Postgres-only + append-only):** rendering perf at scale (the `current_event_records` hot spot — needs rollups), concurrent supersession of the same event, and write-back echo/conflict.

---

## 5. Git as the external interface — verdict

**Feasible; build-risky, not research-risky.** Every contested decision resolves cleanly and reinforces the model.

- **The seam is a custom object/ref backend, not a custom HTTP transport.** pkt-line / want-have negotiation / packfile generation are repo-agnostic; the only repo-specific surface is ~8 methods mapping `sha ↔ Postgres` (list refs, resolve ref→sha, has/read/write object, ref CAS).
- **Language friction → a Go sidecar.** No Node/Bun library generates packfiles server-side from a custom object source (isomorphic-git is client-only; every Node "git http backend" shells out to on-disk git). The clean seam exists only in Go (`go-git`'s `storage.Storer`) or libgit2. Recommendation: a small **stateless Go sidecar** (go-git v6 + Postgres-backed Storer), fronted by Bun for auth/routing. Cheap v0 proof: materialize a transient bare repo per request and shell to `git` (demo only — no scratch-free statelessness, no push translation).
- **Clone = a pure projection.** Materialize current entity markdown, content-address into git objects.
- **Push = the hard half (product design).** Parse the pushed tree, diff vs the synthesized current tree, translate each changed markdown blob → append-only events. Policies needed for rename / delete→tombstone / foreign-frontmatter edits / unknown keys / invalid YAML. *(Spike (c) is specifying this.)*
- **Git hands you primitives for free:** ref **CAS = your optimistic concurrency** (stale push → non-fast-forward = surfaced conflict); **content-addressing = multi-replica dedup with zero shared object store** (every replica synthesizes identical objects). The price is **determinism** — derive the commit author/time from event data (the run), never wall-clock; canonical YAML key order, stable tree ordering, fixed line endings.
- **Merge server-side in the engine, git just records the blob.** Git's merge drivers only fire on `git merge`/rebase, never on the independent-commits-then-reconcile hot path. Parse frontmatter(map)/body, deterministic per-field 3-way merge (disjoint fields auto-merge; same-field → structured conflict, never silent LWW), canonical re-serialize. **Mergiraf** (tree-sitter + GumTree + commutative-parent) is the best off-the-shelf engine; isomorphic-git's `mergeDriver` callback for all-Node.
- **Scale:** curated log (one commit per approved run) on `refs/heads`; connector syncs as bot commits on `refs/connectors/*` filtered out of the default advertisement via protocol-v2 `ls-refs`; blobless partial clone (`--filter=blob:none`) for cheap current-state; provenance via `refs/notes/*` (no SHA churn). Avoid shallow (trap) and treeless (kills log/blame). The single hardest engineering piece: **stateless fetch negotiation** (want/have reachability across replicas) — reconstruct from Postgres or cache commit-graph/bitmaps; bundle-URI for the bootstrap.
- **Source-of-truth, settled:** Dolt camp (DB-canonical, git-as-skin), **not** Keystatic/Tina (git-canonical + derived index). Steal Dolt's **conflicts-as-data** and **cell-level lineage** as the shape of a structured diff/history API; do not adopt git's line-merge.

---

## 6. Nearest prior art

- **strukto-ai/Mirage** — closest sibling. Unified virtual FS mounting ~50 backends as one bash-drivable filesystem; issue #138 is `branch()/diff()/commit()/abort()` — our exact transaction loop, independently arrived at (strong validation). **But:** the backends *are* its source of truth (live passthrough, no canonical store), so it has no provenance/lineage/time-travel; its overlay is in-process (Redis to share); it chose bash-over-FUSE, **not** git. Our moat is the append-only substrate it lacks: Mirage can stage and commit, but can't tell you where a fact came from or what you believed last month.
- **Dolt** — git semantics over a SQL DB; the model to steal (prolly trees, conflicts-as-data, cell lineage), not the engine.
- **Steampipe** — zero-ETL "live source as a typed surface"; validates connectors-as-projection (but cache; don't live-query on every file read).
- **Obsidian/Astro/Keystatic/markform** — schema-as-versioned-code + frontmatter discipline; the reliability line between validated-at-commit and "drifts."
- **The 2025–26 agent-filesystem consensus** (Claude Skills, Vercel bash-tool, agent-memory benchmarks) — external air cover for the whole thesis, and for the open-infra positioning ("your org's knowledge is a repo you can clone and own").

---

## 7. Sequencing / build plan

Value-first; front-load only the cheapest test of the scariest unknown (rendering perf).

1. **Read projection alone** — render a real org as a browsable, greppable markdown tree from `current_event_records`. Independently shippable; tests the rollup perf claim; gives the read-side win immediately. **Time-travel is free** here (HEAD = a watermark over the log).
2. **Branch/commit loop** — run-scoped staged events + read filter + `.diff` + approve/discard. Data-only, internal-only, atomic approval. The differentiator.
3. **Conflict detection + schema-as-code** — optimistic supersession check + `.conflicts`; `.types/` with validation + migrations.
4. **Write-back, per-connector** (Jira first) — the hard two-way sync, done last so nothing before it is blocked.

**Git track:** **power interface first** — UI/API is the front door, git is the dev/agent clone escape hatch, proven via the v0 shell-to-git hack. Elevate git to *primary* once the Go-sidecar synthesizer exists and demand is real (going primary front-loads the two hardest builds: stateless synthesizer + push translation).

---

## 8. Risks & open decisions

- **Adopt a Go sidecar?** The clean git-server seam is Go-only; pure-Node means owning the pack protocol. Real "add Go to the deploy" call.
- **Stateless fetch negotiation** — the one component that's genuinely "feasible-but-hard"; spike against the real prod DB before committing.
- **Push→events** — specced (`SPEC-push-to-events.md`); mostly reuse of existing supersession primitives. Open *product* calls: `lobu_id` mint round-trip (offline writability) + `run_id` provenance.
- **Rendering perf — RESOLVED (measured).** Whole-org render needs an `entity_current` rollup (82ms→1.3ms, 64×; ~4.7ms/entity maintenance); single-entity already fine (1.55ms); branch filter measured free. Free win: split `event_embeddings` out of the read view.
- **Git primary vs power interface** — taste call; recommendation is power-first.

---

## 9. Spike results (validated 2026-06-22)

All ran for real (real Postgres + EXPLAIN; real metered `claude -p` agents). Honest seams noted inline.

**Read projection + v0 git clone** — works end-to-end: buremba-shaped entities → markdown tree → real `git clone` + grep. **Determinism PASSES** — build twice → byte-identical commit SHA (data-derived timestamp/run-id, no `Date.now()`), proving stateless replicas synthesize identical objects. Render template is cheap (~15ms/org).

**Push→events spec** — `SPEC-push-to-events.md`. Key finding: the write path is mostly *reuse* — origin-keyed dedup (`onConflictUpdate`/`findCurrentEventByOrigin`) does supersession automatically, and `idx_events_superseded_by` UNIQUE is already a per-field optimistic-concurrency guard (`23505` on concurrent supersession). Two genuinely-open *product* decisions: `lobu_id` mint round-trip (offline writability) and `run_id` provenance.

**Perf** (real PG 17.7 + pgvector, 155k rows, EXPLAIN-verified):
- Single-entity render from the real view: **1.55ms** — fine; no rollup needed for one-at-a-time reads.
- Whole-org render (what a clone does): **82ms** → with an `entity_current` **rollup**: **1.3ms (64×)**, single-entity **0.005ms (300×)**, maintenance **4.7ms/entity on commit**.
- **Branch = free (measured):** a branch read and a HEAD read touch *identical* buffers; the `run_id` predicate adds zero I/O; 50→200 concurrent branches = **+12%** (table growth, not per-branch cross-talk).
- Standing bug surfaced: `current_event_records` force-joins the **1.25 GB** `event_embeddings` into every read (~1.8× tax, can seq-scan) — split it out; helps the product today, independent of this feature.

**Easiness** (real `claude -p` Opus + real diff):
- A real off-the-shelf agent edited the cloned markdown cleanly with **zero special instructions** ($0.27 / 7 turns / 36s); translator produced exactly the 2 correct events; 23/23 hard-path tests; no-op clone→push = **0 events**; bad edits rejected fail-closed with specific, actionable messages.
- New requirement: body `<!-- event:N -->` markers are server-owned — strip/advisory + a block→event-id manifest (agents *will* fabricate ids; one did).

**Filesystem vs per-provider MCP benchmark** (real `claude -p`, same model both arms, 11 questions; run on **Haiku 4.5 AND Sonnet 4.6**):
- **Accuracy: tie** — 91%/91% (Haiku), 100%/100% (Sonnet).
- **The cost gap is mostly a weak-model effect.** Haiku: filesystem **~5× cheaper** ($0.69 vs $3.38) — but most of that is Haiku rabbit-holing through MCP tool calls (one fusion question hit 302 round-trips). **Sonnet collapses the gap to ~1.2×** ($2.10 vs $2.52): a strong model uses MCP tools efficiently, so MCP cost falls while filesystem cost rises (Sonnet is pricier per token). **"5× cheaper" is not a durable headline.**
- **What survives the model (the real wedge):** (a) **per-provider schema tax** — each added MCP provider injects ~4k tokens into *every* task, load-time, model-independent; the filesystem is one flat interface regardless of #sources. (b) **round-trip count is structural** — MCP needs ~the same many round-trips for fusion on both models (375 vs 380); the filesystem fuses in one grep. (c) **operational simplicity** — one greppable surface vs N servers to run/auth/maintain.
- **Honest conclusion:** with a capable model it's ~a wash on raw cost and a tie on accuracy; the filesystem's defensible advantages are **scaling with #integrations** and **simplicity**, not a flashy cost multiple. (Single-source lookups still favor a direct MCP tool ~2×, either model.)

**Format / access-pattern sweep** (Sonnet, 7 questions, all 100% accuracy) — *the access pattern matters more than the file format:*
- Total cost over 7 q, cheapest→dearest: **query-Postgres $0.51** · fs-TSV $0.56 · fs-JSONL $0.63 · query-Parquet $0.64 · fs-markdown $1.31 · **MCP $2.02**.
- **A single query tool over the unified store is the most token-efficient agent interface** (1 round-trip, compact results, fuses in one query). **Parquet does *not* beat Postgres** ($0.64 vs $0.51) — you already have the DB; Parquet only matters for the detached/offline copy (no DB in the loop).
- File formats: **TSV < JSONL < markdown** — TSV ~11% cheaper than JSONL (keys-every-line waste is real); markdown is 2× (it's the *human/navigation* surface, not the agent-token surface).
- Refined scaling tax: **~820 tokens/provider** on Sonnet (clean, linear) — smaller than the Haiku-inflated ~4k (that was round-trip amplification), but real and structural; flat for any unified interface.
- **Architectural takeaway: the winner isn't "grep files" — it's *unify + one query interface*.** One query tool over the unified Postgres beats both raw-file-grep *and* N per-provider MCPs. Markdown/files = the human + portable surface; the query tool = the token-efficient agent surface; per-provider MCPs lose on both cost and (catastrophically) on fusion.

**Gap-closing spikes (real DB + real code, 2026-06-22):**
- **DB write path + concurrency — CLOSED.** Real PG18, byte-faithful schema; 25 three-way races (75 tx) = exactly 1 winner, losers get `23505` + whole-tx rollback (0 partial). The optimistic-concurrency backstop for git ref-CAS is proven.
- **Schema enforcement — CLOSED (validated).** LLM-inferred schemas pushed through the REAL `manageEntitySchema` + `validateSaveContentSemanticType` against embedded PG (9 tests / 31 assertions green): they COMPILE + create entity types and ENFORCE (wrong-type / unknown-key / missing-required / bad event-kind all fail-closed). Requires a deterministic **YAML→JSON-Schema adapter**, and you MUST inject **`additionalProperties:false`** for strict enforcement (the LLM doesn't emit it). Found 2 prod bugs: masked error message for entity-type-scoped kinds + a 60s event-kinds cache with no invalidation.
- **Two-way sync — CLOSED (mechanisms).** Echo-suppression, conflict (optimistic concurrency), partial-writability, retry-idempotency all proven (reproduced+fixed a double-apply bug). NOT production-ready: echo/idempotency ledger must move to Postgres (multi-replica); write-back is per-field non-atomic; conflict-resolution UX unbuilt. Nothing *fundamental* wrong with two-way.
- **Partitioned-events lake — tested, verdict NEGATIVE server-side.** Hive pruning is real (source+date → 1/4328 files) but the lake LOSES to PG+rollup at every selective query (lake 354ms · PG 81ms · rollup 0.5ms); fine per-entity granularity is pathological (183k files, write OOMs, 80–125× slower). **Don't build a server-side file lake; reserve a compacted sorted Parquet for offline export only.**
- Agent hard paths translate correctly (rename/delete/new/multi-file) with 2 fixes owed (diff the staged index; reject client-supplied ids). Messy-provider (Jira) inference holds with a review pass; surfaced a restricted-content visibility gate.

**Decisions (user-confirmed 2026-06-22):** identity = **natural key** (email/url/source-id), agent never mints (hidden server id only as fallback); restricted content = **store, never auto-search**; git = **power interface** (UI first, synthesizer last); auto-index = **light 1-screen review**.

---

## 10. Auto-indexing / zero-custom-code onboarding (validated 2026-06-22)

The "connect any provider → indexed knowledge, no custom code" gap — tested with a real `claude-opus-4-8` schema-inference pass on raw GitHub + Linear API payloads:
- **The model derives senior-quality entity models from raw API JSON** — ~100% entity coverage, ~95% field typing, ~90% on the hard identity-vs-event calls (counters → snapshot *events* not fields; lifecycle timestamps → transition events). Where unsure it writes an explicit `ambiguities:` block instead of guessing — which is what makes light review viable.
- **The moat fix is cheap and works:** inject the org's existing canonical types into the prompt → `github_user` and Linear `user` collapse onto the shared **`person`** (email as cross-source merge key; provider fields kept as namespaced `person` sub-profile extensions; repos/projects stay provider-specific). Verified on both providers. Without the registry it silos per-provider; *with* it you get one unified entity graph — i.e. cross-source fusion, the durable wedge.
- **Verdict:** zero-custom-code auto-indexing is **real within a provider**, and **near-zero-touch with the registry injected** — gated by a light 1-screen review (confirm canonical merges + the org→company edge it self-flagged + prune snapshot-event spam + flag events needing a second API call/webhook). Confidence ~85 (format-matched, not yet executed through `manage_entity_schema`).
- **MVP onboarding:** connect source → LLM proposes the model *with the live registry injected* → 1-screen review → index. The front door for "pull from any provider, no custom connector."

## 11. Build verdict — what to build vs what already ships (grounded code audit, 2026-06-22)

Read-only audit of the real stack (`query_sql.ts`, `save_content.ts`, `search.ts`, connectors, `manage_entity_schema.ts`, `insert-event.ts`, `entity-link-upsert.ts`; grepped for inference paths — none found).

**Already ships — do NOT rebuild:**
- Unified query interface — `query_sql` over org-scoped tables (the benchmark's winning "query-Postgres").
- Agent read/write/search — `save_memory`, `search_memory` (structured + vector), `query_sdk`/`run_sdk` (typed SDK).
- Append-only + supersession (`idx_events_superseded_by`); exact-match cross-source identity unification (`entity_identities`).
- → A filesystem / git / partition-lake / unified-graph rebuild is **redundant or worse**. Audit quote: *"a filesystem interface would reinvent what query_sql + run_sdk + search_memory already solve."* The agent-surface "gaps" are convenience layers (caching, batching, graph sugar), not core.

**Genuinely net-new — the real build list (ranked):**
1. **Auto-indexing / zero-custom-code onboarding** — connectors are 100% hand-coded today; *no* schema-inference path exists. The connect → LLM-infers-schema → validated via `manage_entity_schema` (proven to compile+enforce) → indexed flow is the one big thing to build.
2. **Governed batch writes** — `save_memory` commits immediately; the `interaction_status='pending_approval'` primitive exists but is only wired for explicit tool ops. Wire a stage→review-diff→commit/discard loop for knowledge writes (the "branch/commit" value, no files).
3. **Time-travel / as-of queries** — data exists (append-only + timestamps + supersession chains); no query API exposes "what did we know on date X." Thin layer, differentiated feature.
4. *(Optional)* **Smarter entity merge** — LLM canonical mapping on the merge-candidate warnings the system already logs (exact-match only today).

**Best rate (config, not build):** GLM 5.2 + `query_sql` + TSV results ≈ **$0.05/task-set at 100% accuracy** (~40× cheaper than Sonnet+MCP). The cheap model needs the clean query interface to stay accurate — MCP drops GLM to 73%, query_sql keeps it at 100%.

---

*Grounding: 11 parallel research sweeps (virtual FS, git-for-data, markdown-entities, agent sandboxes, connector/lineage, + 5 git-feasibility) plus a code grounding pass over `events` / `current_event_records` / `insert-event.ts` / `entity-management.ts`, then 8 spikes run for real (projection+clone, push spec, perf on real PG, agent loop, ergonomics, fs-vs-MCP benchmark incl. Haiku/Sonnet + format/Parquet sweep, LLM schema-inference + registry-injection). Org sample: `buremba` — 976 people, 42 companies, 5 assets, 3 topics, 2 products.*
