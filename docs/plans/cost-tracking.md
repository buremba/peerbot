# PLAN — Cost & Usage Tracking for Agents / Watchers / Users / Orgs

Status: **backend built and validated, then PAUSED — PR #1410 closed without merge (2026-06-21).** The capture + pricing + `run_usage` ledger + backfill shipped green and was validated by two independent reviews (no better design found), but it's a backend with no UI consumer yet — we chose to stop rather than keep building ahead of validated need. See §15 for the outcome, what's recoverable on the closed branch, and the lean path to resume.
Line refs below are **as supplied by research and may have drifted** — the implementer verifies each against `origin/main` before touching it.

---

## 1. Goal & locked scope (from interview)

Purpose: **internal cost VISIBILITY + per-dimension SHOWBACK**, plus **soft + hard spend caps over a sliding window**. Explicitly **no external billing/invoicing now** (maybe later — design must not preclude it).

Locked product decisions:
- Breakdowns surfaced: **per-org, per-agent, per-watcher, per-user/per-thread** (all four).
- Money: **tokens always; USD where the model registry has a real price, else NULL + `unpriced` flag** (never a fake $0).
- Caps: **soft (alert) AND hard (block)**, over a sliding interval.
- Hard-cap dimensions in v1: **org + watcher** (most-restrictive configured cap wins). Agent/user get visibility + soft alerts, not blocking, in v1.
- Over-budget UX: **block + tell the user** — headless/watcher runs terminalize with a "budget exceeded" error event; chat turns get a user-facing over-budget reply via the existing terminal-delivery path.
- In-flight runs: **only gate the NEXT admission** — never kill a running worker; bounded overshoot accepted (Cloudflare/Vercel model).
- Gate failure mode: **fail OPEN** — on infra error (DB blip, lock timeout, unparseable usage) the run proceeds; block only on a cleanly-computed breach. Matches Lobu's guardrail doctrine.

## 2. Build-vs-buy verdict (Orb etc.)

**Build in-house. Adopt no metering/billing platform now.** Orb, Metronome (now Stripe), Stripe Billing, Lago, OpenMeter, Amberflo, m3ter are all billing/revenue engines whose pricing is revenue-coupled (meaningless at zero invoices), and — decisively — **none of them block a request for you**: every one meters → fires a webhook / exposes a balance → and your code does the cutoff. The one hard part (the sliding-window gate) is ours to write regardless. Adopting one now adds a vendor, a second source of truth, and new infra (ClickHouse+Kafka for OpenMeter, Postgres+Redis for Lago) to duplicate a `SUM(usd)` we already can run at the run-claim seam in our own Postgres.

- Copy **OpenMeter's design** (usage-record shape, meter-with-aggregation, soft/hard thresholds, grace periods) — not its dependency.
- **Future trigger to revisit buy:** the day Lobu sends a real external invoice to a paying tenant (needs auditable rating, tax, dunning, credit-notes). Then Orb or Stripe Billing. The frozen-price `run_usage` row is already the correct "meter event" shape to replay to them — no re-instrumentation.

## 3. Architecture overview

The data already exists: pi's `SessionManager` writes every assistant turn's full `Usage` (input / output / cacheRead / cacheWrite / totalTokens + nested per-bucket `cost`) **and** the per-message `model`/`provider` into the worker's `.openclaw/session.jsonl` (`@mariozechner/pi-ai/dist/types.d.ts:80-110`). Everything downstream throws it away. The feature is: **stop discarding it, persist a per-run ledger row, freeze the price, roll it up by dimension, and gate the next admission against a windowed sum.**

Three slices, shipped in order:
1. **Ledger + visibility/showback** (MVP, low risk).
2. **Soft caps** (alert-only, low–medium risk).
3. **Hard caps** (reserve→reconcile gate, medium–high risk).

## 4. Data model

### 4.1 `run_usage` (new table — the authoritative ledger)
One row per run. Denormalize every dimension so all rollups are a plain `GROUP BY` (no JSONB extraction, no new migration per dimension):
- Identity: `org_id`, `agent_id`, `conversation_id`, `user_id`, `watcher_id`, `run_id`, `source` (chat/watcher/scheduled/connector-repair/internal), `model`, `provider`.
- Tokens (distinct buckets — **never one `input_tokens`**): `input`, `output`, `cache_read`, `cache_write`. (Cache-read ≈0.1× input on Anthropic; collapsing overstates cache-heavy watcher loops ~5–10×.)
- Money: `usd` (nullable), `unpriced` (bool), and the **resolved unit rates frozen onto the row** at write time so a later price-table edit never restates history.
- Caps support (slice 3): `state` (`reserved` | `final`), `estimate_usd` (the reservation amount), `occurred_at`.
- Keys: `UNIQUE(run_id)` (or reuse the snapshot key `UNIQUE(org, agent, conv, run_id)`), `ON CONFLICT DO NOTHING` for ret/duplicate safety. Indexes on `(org_id, occurred_at)` and each capped dimension `(watcher_id, occurred_at)`.
- Add to `QUERYABLE_SCHEMA` (`packages/server/src/utils/table-schema.ts:32-344`) so `metric_series` / `query_sql` can chart it. **Cost/USD views gate to admin** — see §8.
- **Backfillable from `agent_transcript_snapshot`** — that table already stores every past run's full `session.jsonl` blob (keyed org/agent/conversation/run_id + terminal_status). So `run_usage` is not a new place we start collecting; we parse the blobs we already keep into queryable columns, and can **reconstruct retroactive cost history** for all prior runs in one backfill job. (Decided: **B — separate lean table**, not columns on the snapshot table, because retention decouples — prune fat blobs early, keep cheap cost rows ~13mo — and non-transcript runs (device-CLI watchers, connectors) have no snapshot but still need a cost row.)
- Migration must pass the **squawk CI gate** (`CREATE TABLE IF NOT EXISTS`, fold unique into a constraint, `squawk-ignore` for concurrent-index/ban-drop; verify locally — `make review`/pi don't run squawk).

Why a new table (rejected alternatives, fatal flaw each):
- **Mutable running total on an `events` row** — impossible: `events` is hard append-only (DELETE trigger, `migrations/20260610040000_events_append_only_guard.sql:34-38`).
- **`events` as the primary store** — every read routes through `current_event_records`, which force-joins full `event_embeddings` and is unprunable (perf trap, `baseline.sql:951-992`); fine for periodic sparkline SUMs, wrong for a hot-path cost lookup / the caps gate.
- **Columns on `runs`** — `runs` is a transient queue purged on retention (`runs-queue.ts:865-922`) and is deliberately absent from `QUERYABLE_SCHEMA`, so it can't be durable history nor charted.

### 4.2 Append-only `events` row (per run, for sparklines)
Additionally emit **one immutable `events` row per run** (`metadata.category='usage'`, tokens/usd under `extra`) via the `recordLifecycleEvent` sibling helper (`packages/server/src/utils/insert-event.ts:530-570`). This buys the existing `metric_series` sparkline + metric-layer machinery for free. It's a per-run snapshot, never a running total — exactly what append-only allows.

### 4.3 Price source (managed map + per-org overrides)
**The canonical price map is `@pydantic/genai-prices`** (vendored offline + daily `updatePrices()` refresh — see §6), which covers Anthropic/OpenAI/Bedrock/many providers *with* context-tier + cache pricing, so we do **not** hand-maintain a price JSON. On top, a small **per-org price-override table** (`org_id, provider, model_id → {input, output, cache_read, cache_write}`) wins for BYO/self-hosted/zero-catalog models — the org sets the rate. (Slice 1 can ship pricing the common catalog-priced paths + the `unpriced` flag; the override table is the fast-follow that makes BYO honest.)

Do **not** adopt a billing/metering SDK for the ledger or caps. Surveyed (Flowglad, Autumn, OpenMeter, Lago, Orb, Metronome, Schematic) — all are customer-billing tools that assume a Stripe customer + invoice and bring their own backend/infra (ClickHouse+Kafka for OpenMeter, Ruby+Redis for Lago) or are pure SaaS clients; Tier.run is archived. None runs as a SQL library in our Postgres. The ledger + rollup + caps are a hand-rolled `SUM(cost_usd) ... GROUP BY` (multi-replica-correct, ~30 lines) and double as the meter-event stream to replay into Stripe/Lago/OpenMeter *if* external billing ever lands.

### 4.4 User-defined config (budgets + price overrides)

Capture and showback need **no** user config — every run is metered automatically; dashboards just read `run_usage`. Users define only two things, each in a small dedicated table (Lobu's `user_model_preferences`-style pattern — queried on the hot path by the caps gate / pricing fn, so not a jsonb blob):

```
cost_budgets(organization_id, scope, scope_id, window,
             soft_limit_usd, hard_limit_usd, enabled, created_by, created_at, updated_at,
             UNIQUE(organization_id, scope, scope_id, window))
  -- scope: 'org' | 'watcher' (scope_id null = org-wide); window: 'daily'|'weekly'|'monthly'
  -- null hard_limit = visibility-only; null soft_limit = no alert

model_price_overrides(organization_id, provider, model,
             input_mtok, output_mtok, cache_read_mtok, cache_write_mtok, created_by, created_at, updated_at,
             UNIQUE(organization_id, provider, model))
```

**Definition surfaces (two, admin-gated):**
1. **owletto web UI — primary.** A "Cost" settings page: a *Budgets* editor (add a cap: scope · window · soft/hard $) and a *Price overrides* editor (model → rates). For non-technical workforce admins. Gated to owner/admin (§8).
2. **CLI — `lobu.config.ts` → `lobu apply`.** Code-first orgs declare budgets/overrides in config; `apply` reconciles them into the two tables via the existing desired-state path (same as agents/watchers/connections). **No MCP tool** (decided).

**Watcher overlap:** the existing `watchers.execution_config.max_budget_usd` is a *per-run* ceiling (claude-CLI flag), kept as-is. The new *sliding-window* watcher cap lives in `cost_budgets` (`scope='watcher'`); the watcher panel surfaces/links the budget editor — one budgets model, no two-places-to-set-a-cap.

## 5. Capture

### 5.1 Prerequisite PR — widen the parsed schema (blocker)
`SessionEntry.message.usage` is declared as only `{ inputTokens?, outputTokens? }` — **wrong field names** (upstream is `input`/`output`), and it drops cacheRead/cacheWrite/totalTokens/cost and the per-message model (`packages/core/src/utils/session-file.ts:35-58`). Until fixed, every reader under-reads what's on disk (`agent-history.ts:214-223` compensates with `u.inputTokens || u.input` casts). **Widen to the four buckets + per-message `model`/`provider` + the cost sub-object.** Update the duplicated `/session/stats` readers (`agent-history.ts:214-233`, `packages/agent-worker/src/server.ts:165-184`). After editing `packages/agent-worker/*` run `make clean-workers`.

### 5.2 Spike FIRST — verify cache tokens per provider (accuracy gate)
Confirm `cacheRead`/`cacheWrite` are actually populated in captured `Usage` for **Anthropic vs openai-completions vs third-party openai-compat** (z.ai/gemini/nvidia/together often return 0). This gates the whole accuracy story; do it before building persistence.

### 5.3 Write point & transport
Natural persist-once seam: `OpenClawWorker.cleanup()` on the success path holds the runId, the full JSONL, and a per-run JWT (`packages/agent-worker/src/openclaw/worker.ts:406-429`; snapshot via `transcript-snapshot.ts:137-151`). Workers have **no `DATABASE_URL`** — persistence rides the authenticated `/worker/*` hop.

**Transport decision:** worker aggregates per-turn usage from its own `session.jsonl` at cleanup and includes a **structured `usage` field in the completion response** (`signalCompletion`/`buildBaseResponse`, `packages/agent-worker/src/gateway/gateway-integration.ts:162-184`), so the gateway has usage at the completion seam without re-parsing the opaque `snapshot_jsonl` blob cross-pod. The gateway computes USD (price table) and writes `run_usage` **inside the claimant-gated completion UPDATE** (§9). One row per run + a `turn_breakdown` JSONB column to preserve mixed-model detail (each turn stamps its own model; a `model_change` entry marks mid-session swaps — `session-file.ts:120-129`).

### 5.4 Known capture gaps to handle
- Usage currently reaches PG only on `terminalStatus==='completed'` (`worker.ts:291-297`). **Capture on ALL terminal states incl. failure/timeout/cancelled** — a timed-out 200k-token run still cost money, and runaway loops live exactly there.
- A **provider change deletes `session.jsonl` and purges snapshots** (`session-runner.ts:710-760`) — another reason to capture per-run at completion, not rely on the file surviving.
- **Device-worker CLI watcher runs** (Owletto local claude/codex) report back **no cost** today (`run-lifecycle.ts:604-622`) and have no `session.jsonl` on the gateway side. Cloud watcher runs (OpenClaw worker) are covered; the device-CLI path needs separate handling (claude/codex CLIs can emit cost JSON) — scope as a follow-up, flag in v1 that device-CLI watcher spend is not captured.

## 6. Cost computation (tokens → USD)

**Adopt `@pydantic/genai-prices` as the price map — do NOT hand-maintain pricing, and do NOT price via pi-ai's `calculateCost` alone.** Verified this session: pi-ai's `calculateCost` (`node_modules/@mariozechner/pi-ai/dist/models.js:22`) is a **flat 4-field formula** (`cost.{input,output,cacheRead,cacheWrite}/1e6 × usage.*`) with **no context-tier and no cache-write split** — `getModel("anthropic","claude-sonnet-4-5")` returns `{input:3,output:15,cacheRead:0.3,cacheWrite:3.75}`, zero tier fields. For a 1M-context backend, **every run crossing 200k input is systematically undercharged** (Sonnet input 3→6, cache-read 0.3→0.6, cache-write 3.75→7.5 above 200k). pi-ai inherits this from models.dev, so tokenlens (same upstream) shares the gap.

- **`@pydantic/genai-prices`** (MIT, pydantic-ai team, active — npm v0.0.66, 2026-06) is the only TS-native lib that models the shapes we hit: `cache_read`/`cache_write`, **tiered prices** (>200k cliff), and **time-versioned rates** (a backfilled run prices at the rate in effect on its date). Synchronous, offline pure fn `calcPrice(usage, modelId, {providerId})` over a vendored catalog — safe in the completion seam under N>1. **Vendor the catalog offline; wire `updatePrices()` as a low-frequency daily background refresh** into a file / small PG table so new models track without a dep bump while `calcPrice` stays sync/offline in the hot path.
- **VERIFIED this session** (installed + ran the npm package): it's a genuine JS port (ESM+CJS, typed, only dep `yargs`, `node>=20`) — *not* a Python wrapper. It imports and computes in Node, and its catalog carries the real tiers, e.g. `claude-sonnet-4-5 input_mtok = {base:3, tiers:[{start:200000, price:6}]}`. Measured a 250k-in/50k-out run: **pi-ai flat `$1.50` vs genai-prices tiered `$2.625` — a 43% undercharge** that pi-ai would silently bake in. Below 200k both return identical `$0.30`, so the swap only changes large-context runs (exactly the watcher/agent loops we care about). It's `v0.0.x` (young) → **pin the exact version + vendor the catalog + wrap behind our own `priceUsage()` adapter** so it's swappable.
- **TOKEN-SEMANTICS MISMATCH — must normalize in the adapter (found this session):** genai-prices treats `input_tokens` as the **grand total** prompt tokens with `cache_read_tokens`/`cache_write_tokens` as **subsets** (it computes uncached = input − cache_read − cache_write, and *throws* `"Uncached … cannot be negative"` if you pass them as separate counts). Anthropic's API returns them **separately** (`input_tokens` = uncached only, plus `cache_read_input_tokens`, plus `cache_creation_input_tokens`). The `priceUsage()` adapter MUST map our captured buckets into genai-prices' total+subset convention (`input_tokens = uncached + cache_read + cache_write`) and unit-test both conventions, or cache-heavy runs mis-price or error.
- **Greedy specific-then-default:** price `cacheRead`/`cacheWrite` at their own rates first, then `input`/`output` on the remainder (genai-prices handles this) — cache tokens never double-counted. Cache nuance differs per provider (Anthropic: uncached / cache-read ≈0.1× / cache-creation ≈1.25–2×; OpenAI: cache reads only) — another reason to use a lib that encodes it rather than the flat formula.
- **Per-org override table stays** for genuinely BYO/self-hosted/$0-in-catalog models (§4.3); genai-prices also exposes a custom-pricing hook for unknown-but-real models. The `model-resolver` zero-price trap (`model-resolver.ts:148`, dynamic openai-compat/Bedrock fabricate `cost:{0,0,0,0}`; alias `z-ai`→`zai`, `model-resolver.ts:49-51`) is exactly what routes a model to the override table.
- **Freeze the resolved rates + USD onto the `run_usage` row at write; unknown model → store tokens, `usd=NULL`, `unpriced=true`.** Never silently emit $0.
- **Integration risk to validate (spike, see §11 PR-0):** mapping Lobu's stored `provider`+`model` → genai-prices' `providerId`+`modelId`, especially Bedrock `us.anthropic.*` and z.ai/GLM self-hosted (those route to the override table). pi-ai's `getModel().cost` remains a zero-dep fallback for any model genai-prices lacks; LiteLLM's `model_prices_and_context_window.json` is a secondary cross-check source (no TS calculator — don't build on it).

## 7. Granularity / rollups

`organization_id` is the only reliably non-null dim across run types; for chat/agent/schedule runs `agent_id`/`user_id`/`conversation_id` live **only inside `runs.action_input` JSONB**, and there is **no `agent_id` column on `runs`** (`runs-queue.ts:353-387`). `watcher_id` IS first-class on `runs` for watcher runs (`queue-service.ts:357-387`). → **Denormalize all dims onto `run_usage` at write time** so every rollup is a cheap `GROUP BY` and a future dimension (per-skill, per-connector) is never a migration. All six rollups (per-run/thread/agent/user/org/watcher) become cheap.

## 8. Surfacing (owletto)

- **Per-org spend chip** on Agents landing `StatsStrip` ("Spend (14d)") — add a `Stat` at `packages/owletto/src/app/$owner/agents/index.tsx:43-64`, fed by a new `metric_series` SQL mirroring `lifecycleCumulativeStatsSql`; reuses `POST /api/{slug}/metric_series`.
- **Per-org spend tile** on workspace home — `DashboardMetricCard` at `packages/owletto/src/components/workspace-dashboard-home.tsx:390-421`.
- **Per-agent usage/cost tab** — register in `AGENT_TABS` at `packages/owletto/src/components/agents/agents-workbench.tsx:45-56`.
- **Per-watcher** spend over time on the watcher detail/tab.
- **Per-user** has no home today (Members page redirects to the `$member` entity, `members/index.tsx:54-65`) — needs a new members stat strip.
- DESIGN_GUIDELINES: chip reserves a skeleton (`series:[]`), landing loader awaits nothing, `<Card>` is the only elevated container, `metric_series` queries bucketed ≤365 rows / ≤5s / ≤2000 rows. Read `packages/owletto/DESIGN_GUIDELINES.md` before UI work.

**Gating — RECOMMENDED, confirm before building UI:** `metric_series` is read-tier (any member can chart it, `tool-access.ts:160-171`) and the only UI gate today is `canManageWorkspace` = membership, not admin/owner. Spend is sensitive in a workforce backend → **gate dollar/cost views to workspace owner/admin** (move `run_usage` into `ADMIN_ONLY_QUERYABLE_TABLES`, `table-schema.ts:354`, + a role check). This is the one decision not yet explicitly confirmed in the interview — default to admin-only given the showback goal.

## 9. Caps / enforcement architecture (slice 3)

Distills to: **a per-dimension running spend counter over a sliding window, gated at claim→spawn, reconciled at completion — all via Postgres, no in-memory accumulator.** (Running-counter-at-admission, the Cloudflare/Vercel model; LiteLLM's inline pre-call reserve is only partly applicable since Lobu has no inline hop inside the worker.)

- **Gate location:** immediately AFTER a successful claim, BEFORE spawn — at `RunsQueue.claimOne()` (`runs-queue.ts`, chat/agent) and `poll.ts` claim (connector/watcher/auth); chat ingest at the `message-consumer.ts` admission point (where the input-guardrail trip already terminalizes).
- **Counter = the `run_usage` table itself:** hard cap = `SUM(usd) WHERE <dim>=$x AND occurred_at > now() - $window` over raw rows (exact; per-window run cardinality is low). Dashboard gauge can use pre-aggregated per-(dim,hour) buckets + partial-bucket interpolation (~6% error, fine).
- **Algorithm:** sliding-window-counter. Reject fixed-window (boundary doubling unacceptable for money) and token/leaky-bucket (built for rate, not a cumulative $ ceiling).
- **Reserve→reconcile (post-hoc cost):** at the gate insert a `state='reserved', usd=estimate` row (estimate = recent avg actual usd for this agent/watcher/source over last K completed runs; cold-start fallback = `max_output_tokens × registry price`). The committed row is visible to the next claim's SUM — that's what stops N concurrent under-budget claims from collectively blowing the cap. Wrap read-decide-reserve in `n_xact_lock(BUDGET_NS, hash(dim_key))` (mirrors `insert-event.ts` dedup lock) so same-dimension claims serialize and different dimensions never contend. At completion, in the won-`RETURNING` branch, `UPDATE` the reserved row → `state='final'` with real buckets + frozen usd; over/under-shoot self-heals.
- **Reconcile seams:** `finalizeRun()` (`run-lifecycle.ts:55-77`) and `RunsQueue.markCompleted()` (`runs-queue.ts:681-692`) — both guarded `UPDATE ... WHERE status=... AND claimed_by=$me RETURNING`; write usage only in the branch the RETURNING proves you won → exactly-once per pod.
- **Orphan settlement (highest-consequence bug):** when a run is reaped (worker crash / 2h timeout / stale-claim sweep / `check-stalled-executions.ts` / `recoverStaleClaimedRowsOnStartup`), the **same sweep settles its reserved row** (delete or mark final $0) — else leaked reservations permanently inflate the window and false-positive-wedge the cap. Test crash/timeout/reaper paths explicitly.
- **Soft cap = pure alert lane (slice 2):** a single-claimant Postgres threshold sweep (`connection-health`-style) emits a `budget-trip` event (guardrail-trip-style) + notify at 85%/95%; never blocks. A periodic sweep is sufficient (Langfuse confirms inline isn't needed); debounce per dimension+window to avoid flapping.
- **Hard cap = refuse to spawn (slice 3):** over cap → don't dispatch; terminalize with a "budget exceeded" terminal error routed through the existing `thread_response` terminal-delivery path; chat gets a user-facing over-budget reply. Write the `budget-trip` event.
- **Fail-open / fail-closed:** fail OPEN on any infra error in the SUM/lock/reserve/parse step (log + spawn anyway). Fail CLOSED only on an explicit cleanly-computed breach. Bounded concurrent overshoot is accepted (Cloudflare/Vercel parity).
- **First concrete cap dimension:** finally enforce `watchers.execution_config.max_budget_usd` (stored-only today, `watcher-execution-config.ts:25-30,77-90`; `sandbox/namespaces/watchers.ts:35`) as a sliding-window watcher cap.

## 10. Multi-replica & idempotency

- No in-memory accumulator anywhere — each replica computes cost independently from the (cached) price table and writes its own row; the SUM is read from Postgres. Satisfies the N>1 invariant cleanly.
- Exactly-once writes via the won-`RETURNING` claimant gate + `UNIQUE(run_id) ON CONFLICT DO NOTHING`.
- All worker→gateway persistence over the JWT `/worker/*` hop (org/agent/conv from JWT, runId in body verified against scope).

## 11. Phasing → PRs

1. **PR-0 (spike, no merge):** verify cache-token population per provider (§5.2), AND feed 3–4 real usage shapes (a >200k Anthropic run, a cache-heavy run, a Bedrock `us.anthropic.*` run, a z.ai/GLM run) through `@pydantic/genai-prices` `calcPrice` — diff USD vs pi-ai `calculateCost` to quantify the >200k undercharge and confirm provider/model-ID matching (the main pricing integration risk). Gate.
2. **PR-1 (core):** widen `SessionEntry.message.usage` schema + fix the two `/session/stats` readers (§5.1). `make clean-workers`.
3. **PR-2 (ledger):** `run_usage` migration (squawk-clean) + add to `QUERYABLE_SCHEMA`; worker emits structured `usage` in completion response; gateway computes USD via `@pydantic/genai-prices` (§6) (+`unpriced` flag) and writes `run_usage` + append-only `events` row at `finalizeRun`/`markCompleted`, incl. failed/timeout terminal states. Idempotency under re-claim is the load-bearing test.
4. **PR-3 (showback UI):** per-org chip + dashboard tile, per-agent tab, per-watcher view, per-user members strip — admin-gated (§8).
5. **PR-4 (price overrides):** per-org price-override table so BYO/self-hosted models price correctly.
6. **PR-5 (soft caps):** threshold sweep + `budget-trip` events + notify at 85/95% for org + watcher.
7. **PR-6 (hard caps):** reserve→reconcile gate at claim seams + `message-consumer` admission; orphan-reservation settlement in the stale sweep; fail-open/fail-closed wired; enforce watcher `max_budget_usd` + org cap; over-budget terminal error + chat reply.

Each PR: `make review BASE=origin/main` in a worktree (`make task-setup NAME=<slug>` first); **E2E before merge is a hard gate** for the behavioral PRs (red→green reproducer in the body).

## 12. Risks & open items

Risks (by slice): ledger — double-count on re-claim/retry (mitigated by won-RETURNING + UNIQUE); soft caps — alert flapping (debounce); hard caps — estimate quality (start conservative, tune K), **leaked reservations wedging the cap** (test reaper paths — highest consequence), concurrent-overshoot bound (measure + document), first time the subsystem can *deny* (fail-open is the safety valve, make it a reviewed choice).

Open items to confirm during build (sensible defaults chosen, not yet blessed):
- **Who can see cost** — recommend admin/owner-only for dollar views (§8). The one interview question not yet explicitly answered.
- **Window vocabulary** — recommend user-facing `daily/weekly/monthly` (rolling `WHERE occurred_at > now()-interval`) with a raw-interval escape hatch in config, not UI.
- **Estimate K** (lookback runs for the reservation estimate) — tune empirically; reconcile makes a mediocre estimate self-correcting, don't over-engineer v1.
- **Device-CLI watcher cost capture** (§5.4) — follow-up; flag as uncaptured in v1.

## 13. Confidence

Design synthesis: **high (~85)**. Build-vs-buy verdict and the "every platform is alert-only" fact independently confirmed across vendor docs; seam/lifecycle mapping grounded in cited code paths. Lower confidence on exact line numbers (verify against `origin/main`) and on cache-token population per third-party provider (PR-0 spike resolves it).

## 14. Unknowns & go-ahead

| # | Unknown | Status / resolution | Gates start? |
|---|---|---|---|
| 1 | Is genai-prices real JS, not Python? | **RESOLVED** this session — genuine npm JS port (ESM+CJS, typed, dep=`yargs`, `node>=20`), imports + computes in Node. Python-*origin* project, `v0.0.x` young → pin + vendor catalog + `priceUsage()` adapter. | No |
| 2 | Does pi-ai undercharge >200k? | **RESOLVED** — measured `$1.50` (flat) vs `$2.625` (tiered) on a 250k/50k run = 43% under; identical below 200k. Justifies the swap. | No |
| 3 | Token-count semantics (total+subset vs separate) | **NEW, found this session** — genai-prices `input_tokens`=grand total, cache_read/write are subsets (throws if passed separately); Anthropic returns them separately. Adapter must normalize + unit-test. | Pricing accuracy → resolve in PR-2 adapter |
| 4 | `provider`+`model` → catalog id mapping | **Spike (PR-0)** — feed real ids (Bedrock `us.anthropic.*`, z.ai/GLM, dynamic openai-compat); match logic is `starts_with`/`regex`; unmatched → override table + `unpriced` flag. | Accuracy, not the ledger |
| 5 | Cache tokens populated per provider? | **Spike (PR-0)** — inspect real `session.jsonl`: do third-party openai-compat endpoints fill `cache_read`/`cache_write` or return 0? | Accuracy |
| 6 | Always a `runs` row at completion with the dims? | **Verify before PR-2** — `org_id` always; `watcher_id` first-class for watcher runs; `agent_id`/`user_id`/`conversation_id` live in `action_input` JSONB → denormalize onto `run_usage`. Confirm chat/agent runs always create a `runs` row. | Ledger correctness |
| 7 | Threading structured `usage` through completion response | **Build detail (PR-1/PR-2)** — worker aggregates from its own `session.jsonl` at cleanup, adds `usage` to `signalCompletion`/`buildBaseResponse`. | No |
| 8 | Device-CLI watcher runs (Owletto) cost | **Out of scope v1** — no gateway-side `session.jsonl`, report no cost today; flag as uncaptured; later via claude/codex CLI cost output. Cloud watcher path unaffected. | No |
| 9 | Caps estimate source (cold start) | **Sequencing** — caps (slice 3) ship *after* the ledger has accrued history; cold-start fallback = model worst-case (`max_output × tiered price`). | No (later slice) |
| 10 | Who-can-see gating + window vocab | **Product confirm** — defaults admin-only / `daily·weekly·monthly` (§8, §12). | No (UI slice) |

**Go-ahead sequence (nothing blocks starting):**
1. **PR-0 spike** — resolves #4, #5; quantifies #2 on real rows; validates the #3 adapter against real Anthropic + openai-compat + Bedrock payloads. The one de-risking step worth doing first.
2. **Decide pricing impl** — recommended: adopt genai-prices behind a `priceUsage()` adapter (pin exact version, vendor catalog, LiteLLM-JSON as the documented fallback). Reversible by design.
3. **PR-1** — widen `SessionEntry` usage schema (smallest, unblocks all capture).
4. **PR-2** — `run_usage` ledger + adapter (incl. #3 normalization) + #6 verification.
5. **PR-3…PR-6** — UI → overrides → soft caps → hard caps, per §11.

The only items that gate *correctness* (not *starting*) are #3 (adapter normalization — unit-tested) and #6 (runs-row presence — a grep away). Both are settled inside PR-0/PR-2; PR-0 and PR-1 can begin immediately.

## 15. Build outcome & resume plan (2026-06-21)

**What was built (branch `feat/cost-tracking`, PR #1410 — CLOSED, not merged):**
- Capture: `session.jsonl` parser widened to the real on-disk usage (input/output/cacheRead/cacheWrite + cost + per-message model); both `/session/stats` readers folded into one `computeSessionStats`.
- Pricing: `@pydantic/genai-prices` adapter (tiered >200k + cache; `zai/z-ai → zhipuai`; unknown → usd NULL + unpriced).
- Ledger: `run_usage` table + 4 rollup indexes, written at the transcript-snapshot seam (parse → price-per-model → denormalize dims from `runs` → upsert ON CONFLICT(run_id)); fail-open; self-heals on the 409 path. Backfill from existing snapshots. Registered in `QUERYABLE_SCHEMA` (admin-only) + a `buildScopedQuery` org-scope branch.
- Gates at close: typecheck=0, unit=0, integration=0; squawk 0; knip adds no unused files; bug_free verdict 76. Real-PG e2e of the insert path (price/dims/jsonb/idempotency).

**Why closed instead of merged:** the design is right (validated by an adversarial Claude review + a codex/pi review — both said keep `run_usage`, don't reuse `events`/`runs`/snapshots/the entity-metric layer). But it's **infrastructure ahead of its consumer** — nothing renders or enforces the data yet, so realized value is zero until a UI/caps slice lands. Decision: stop, ship a thin validated slice first rather than the full plan.

**Lean resume path (do this first, not §11 PR-3..6):**
- One **per-org "Spend (14d)" tile** off `run_usage` via the existing `metric_series` endpoint. Ship it, see if anyone looks. Only then build per-agent/watcher/user breakdowns and caps.

**Gaps/refinements to fold in when resuming (from the reviews — all cheap, free pre-merge):**
- Add a `pricing_version` column to `run_usage` (genai-prices pinned `0.0.66`) so reprice-vs-frozen is decidable later. `priced_at ≈ created_at`.
- Add index `(organization_id, user_id, occurred_at)` — per-user is a wanted breakdown; only org/agent/watcher indexes exist.
- Scale-when-needed (not now): `usd_micros bigint` for hot-path sums; time-partition + BRIN on `occurred_at`; normalize `run_usage_model_segments` only if per-model becomes a queried dimension (jsonb is audit-only today).

**Caps design (confirmed independently by codex/pi AND the earlier research — do NOT use raw `SUM(run_usage)` for hard caps):**
- Reserve-at-admission → settle-at-completion: `spend_cap_policy` + `spend_cap_reservation` (+ optional per-window `spend_cap_usage_bucket`). Admission txn: lock the cap subject (`FOR UPDATE` or `pg_advisory_xact_lock`), sum settled (`run_usage`) + pending reservations, admit/block, settle on completion, release on failure.
- Hard caps from post-run actuals alone are impossible → the honest guarantee is "hard admission cap with **bounded overshoot**" unless a per-run ceiling or per-call gate is added.
- **Unpriced models leak caps** → a capped tenant needs a policy: block unknown-price models, require a configured rate, or reserve a conservative ceiling.

**Dogfooding (cleaner framing from pi):** don't fake entities, and don't abuse the external-warehouse "reflected" seam. Make the metric layer **entity-backed OR fact-backed**, with a first-class **fact-backed measure source** over `run_usage` (dims: org/agent/watcher/user/provider/model/source; measures: spend, tokens, unpriced count, run count) so cost shows up in `list_metrics`/`query_metric` like any governed metric.

**Honest verdict:** the *design* wasn't over-engineered (validated minimal-correct), but the *scope/sequencing* was — we built the full multi-dimension, caps-ready backend before validating anyone wants the numbers. The process (multiple workflows + 3 review rounds + 2 external reviews) was heavy but caught real bugs (silent GLM mispricing, unqueryable ledger, migration blocker). Resume only if the per-org tile proves the need.
