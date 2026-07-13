# context-layer — a governed "why" over a live warehouse

A **semantic layer** governs the *what* of a metric: the SQL, the joins, the
canonical definition of `churn_rate`. It answers "what is the number." It does
not answer "why did the number move," "which months are garbage," or "which
definition was in effect when this was computed." Those live in people's heads,
in Slack threads, in a Linear incident nobody linked.

A **context layer** governs the *why*. This example builds one for a fictional
coffee-subscription company (Kelder Coffee) on **stock Lobu** — no custom
server, no forked connectors. It reads a live warehouse, overlays the governed
business context, and composes an "adjusted churn" series where every anomaly is
explained by a dated, sourced record instead of a guess.

## The story the data tells

The fake warehouse (`subscriptions` table, ~2000 rows) has a deliberately messy
churn series:

- **30 organic cancellations/month**, steady, Jul 2025 → Jun 2026.
- **20 payment-failure cancellations/month** — a card fails and the sub is
  auto-cancelled. Each carries a `dunning_started_at` (when card retries began).
  ~12/month are cancelled *inside* the 28-day dunning grace (retry-window
  artifacts churn v2 excludes); ~8/month fall *outside* it (real churn v2 keeps).
  This cohort is what makes the definition change *move the number*, not label it.
- **+500 cancellations on 2026-03-12/13** — a bad Recharge billing migration
  wrote false cancellation rows. The numbers are *wrong*.
- **+45 cancellations on 2026-05-19..21** — a real courier strike. The numbers
  are *right* but the cause is external and temporary.
- **A definition change on 2026-05-01** — churn moves to v2 (a 28-day dunning
  grace excludes payment-failure cancellations inside the grace).

Raw churn shows a terrifying **550 in March** and an elevated **95 in May**.
Neither is "churn getting worse." A context layer makes that legible without
archaeology — and under v2 a plain month reads **38**, not the raw **50**,
because the definition change actually changed *which cancellations count*.

## How the pieces map

| Concept | Where it lives | What it governs |
|---------|----------------|-----------------|
| **Business events** | `business-event` entities | The dated, sourced *why* behind an anomaly — a data incident, a definition change, an external shock. Each carries a `source_link` (Linear ticket, decision doc, Slack thread), a human `expected_effect`, and — for a data incident — a machine-usable structured `adjustment` (e.g. `{op:"subtract_reason", cancel_reason:"billing_migration_artifact"}`) that `compose.ts` applies. |
| **Definition changelog** | `metric-definition` entity + a supersede chain of `definition` events | The versioned meaning of the metric. Each version carries a machine-usable `governing_predicate` (v1: count everything; v2: exclude payment-failures inside the 28-day dunning grace). A new version **supersedes** the previous one, so the current definition is the one unsuperseded event and the whole chain is the changelog — append-only, never edited. |
| **Governed composition over a live warehouse** | `compose.ts` → a `run_sdk` read + a generated `query_sql` pushdown | Phase 1 reads the context layer (definitions + events) via the sandbox. Phase 2 **generates** the rollup SQL *from* those predicates + adjustments and runs it **live** against the warehouse through the stock `query_sql` connection pushdown — nothing copied into Lobu. The definition version in effect for a month picks that month's `WHERE`, and a data-incident subtracts exactly the rows it names. The definition **governs the query**, it does not merely label the output. No LLM. |
| **Agent eval** | `eval.ts` | Asks a real agent the March question twice — WITH the governed context pushed vs a WITHOUT baseline — and asserts the pushed context changed the answer (cites the migration, corrects ~550 → ~50). Runs a live agent when a model provider is configured; falls back to a labelled deterministic proxy when the local install has no model. |
| **Verified-query drift canary** | `verified-query` entity + `drift-check.ts` | A human-approved answer (the exact SQL + the rows it produced at approval time) is pinned. Re-running the query and diffing against the pinned answer is the canary: a mismatch means the warehouse (or a definition) moved and the answer needs re-verification — *before* someone repeats a stale number in a board deck. |

The connection, auth profile, and entity schema are declared in
`lobu.config.ts` (config-as-constructor) and created by `lobu run`. The seed
script adds the virtual feed, the definition chain (with governing predicates),
the business events (with structured adjustments), and the pinned verified
answer on top.

```
context-layer/
├── lobu.config.ts              # agent, entity types, warehouse connection + auth profile
├── IDENTITY.md                 # the analyst agent's identity
├── env.example                 # copy to .env
└── scripts/
    ├── seed-warehouse.ts        # provision the fake warehouse (deterministic; incl. payment-failure cohort)
    ├── seed.ts                  # seed the context layer (feed, definitions+predicates, events+adjustments, pinned answer)
    ├── compose.ts               # THE MONEY SHOT — governed adjusted-churn narrative (definition governs the SQL)
    ├── eval.ts                  # agent eval — does pushing the context change the answer? (real agent or labelled proxy)
    ├── simulate-drift.ts        # mutate the warehouse so the canary has something to catch
    ├── drift-check.ts           # re-run the pinned query, diff vs the approved answer
    └── lib/{env,gateway}.ts     # shared env + a tiny local-gateway client
```

## Run it

Requires [Bun](https://bun.sh). Everything runs against an **isolated embedded
Postgres** that `lobu run` boots under `./.lobu-data` — no external database, no
shared dev/prod DB.

```sh
cd examples/context-layer
cp env.example .env

# 1. Boot the embedded Lobu stack (applies lobu.config.ts: installs the postgres
#    connector, creates the warehouse connection, registers the entity types).
#    Leave this running in one terminal.
bunx @lobu/cli run

# In a second terminal:
bun run seed:warehouse   # provision the fake Kelder warehouse (~2000 subscriptions)
bun run seed             # seed the context layer on top of it
bun run compose          # compose the governed adjusted-churn narrative  ← the money shot
bun run eval             # prove pushing the context changes an agent's answer
bun run drift:simulate   # add one cancellation so the canary has drift to catch
bun run drift            # re-run the pinned query and report the drift
```

## Sample output

Real output captured from an end-to-end run against the embedded stack.

### `bun run compose`

```
Connected to local gateway (org: local-install)

=== Adjusted churn for churn_rate ===

┌────┬─────────┬─────┬──────────┬─────┬───────────────────────────────────┐
│    │ month   │ raw │ adjusted │ def │ flags                             │
├────┼─────────┼─────┼──────────┼─────┼───────────────────────────────────┤
│  0 │ 2025-07 │ 50  │ 50       │ v1  │                                   │
│  1 │ 2025-08 │ 50  │ 50       │ v1  │                                   │
│  2 │ 2025-09 │ 50  │ 50       │ v1  │                                   │
│  3 │ 2025-10 │ 50  │ 50       │ v1  │                                   │
│  4 │ 2025-11 │ 50  │ 50       │ v1  │                                   │
│  5 │ 2025-12 │ 50  │ 50       │ v1  │                                   │
│  6 │ 2026-01 │ 50  │ 50       │ v1  │                                   │
│  7 │ 2026-02 │ 50  │ 50       │ v1  │                                   │
│  8 │ 2026-03 │ 550 │ 50       │ v1  │ data_incident                     │
│  9 │ 2026-04 │ 50  │ 50       │ v1  │                                   │
│ 10 │ 2026-05 │ 95  │ 83       │ v2  │ external_shock, definition_change │
│ 11 │ 2026-06 │ 50  │ 38       │ v2  │                                   │
└────┴─────────┴─────┴──────────┴─────┴───────────────────────────────────┘

=== Definition changelog (governs the query) ===
  v1 (from 2025-07-01): churn_rate v1 = … Every cancellation counts. [predicate: count every cancellation]
  v2 (from 2026-05-01) [current]: churn_rate v2 = … [predicate: exclude payment_failure inside 28-day grace]

=== Definition governs the number (not just the label) ===
  2026-06: raw 50 counted under v1 would be 50; under the v2 predicate the governed count is 38. Same warehouse, different number — because the definition changed the WHERE.

=== Narrative ===
  • 2026-03: raw 550 REPAIRED to 50 — Recharge billing migration wrote false cancellations (https://linear.app/kelder/issue/DATA-142). Subtracted 500 artifact rows; the real cancellations that month still stand.
  • 2026-05: raw 95 genuinely elevated — Courier strike (Randstad region) (https://kelder.slack.com/archives/C042/p1747650000). Real but flagged; do not extrapolate.
  • 2026-05: definition moved to v2 — Churn definition v2: dunning grace period (https://notion.so/kelder/churn-v2). Post-boundary months are counted under the new predicate.

Adjusted churn is computed by letting the governed context drive the query: each month is counted under the definition version in effect, data-incident artifacts are subtracted (not nulled), and external shocks are kept but flagged. Every deviation cites its source of truth.
```

The March spike (a data incident) is **repaired** — the ~500 migration
artifacts are *subtracted* (550 → ~50), not the whole month thrown away. The May
elevation (a real courier strike) is **kept but flagged** — real, temporary,
don't extrapolate. And the definition change **governs the count**: every month
from 2026-05 is computed under v2, so a plain month reads **38** where v1 would
read **50** — the same warehouse, a different number, because v2's predicate
changed the `WHERE`. No LLM ran; `compose.ts` generates the rollup SQL *from* the
governed predicates + adjustments and runs it live against the warehouse.

### `bun run eval`

Asks the March question WITH the governed context pushed vs a WITHOUT baseline
and asserts the pushed context changed the answer. When the local install has a
model provider wired, both arms are real agent turns; otherwise it runs the
labelled deterministic proxy (below) — asserting the pushed context bundle
carries the migration citation + corrected number and the baseline does not.

```
=== Agent eval (deterministic-proxy) ===

(A) WITH context layer:
    GOVERNED CONTEXT (business events affecting churn_rate):
    - [data_incident] Recharge billing migration wrote false cancellations (on 2026-03-12, source https://linear.app/kelder/issue/DATA-142)
        Repair 2026-03: ~500 cancellations … are migration artifacts …
        structured adjustment: {"op":"subtract_reason","cancel_reason":"billing_migration_artifact"}
    Composed adjusted series for 2026-03: raw 550, adjusted 50 (billing_migration_artifact rows subtracted).
  → cites migration + corrects to ~50? YES ✅

(B) WITHOUT context layer (baseline):
    The warehouse reports 550 cancellations for 2026-03. No other context is available.
  → correctly LACKS the governed correction? YES ✅

PASS ✅ — pushing the context layer changed the answer.
```

The proxy is honest about being a proxy: wire a model provider
(`lobu agents inference-providers`) and re-run for the live-agent version.

### `bun run drift:simulate` then `bun run drift`

Before any mutation the pinned answer matches the live warehouse:

```
Verified query: "How many cancellations did we have per month?"
Approved by head-of-data on 2026-07-12 (12 pinned rows vs 12 live rows)

✅ No drift — the pinned answer still matches the live warehouse.
```

`bun run drift:simulate` inserts one new cancellation into 2026-06:

```
Inserted 1 new cancellation (id 2001) into 2026-06. Warehouse now reports 51 cancellations for that month.
Run `bun run drift` — the canary should now report drift.
```

Now the canary fires (and exits non-zero, so CI catches it):

```
Verified query: "How many cancellations did we have per month?"
Approved by head-of-data on 2026-07-12 (12 pinned rows vs 12 live rows)

⚠️  DRIFT DETECTED in 1 month(s):
┌───┬─────────┬────────┬─────────┐
│   │ month   │ pinned │ current │
├───┼─────────┼────────┼─────────┤
│ 0 │ 2026-06 │ 50     │ 51      │
└───┴─────────┴────────┴─────────┘

The pinned answer is stale. Re-verify before quoting either side.
```

## Notes

- Runs on **stock Lobu**. `compose.ts` reads the context layer via the standard
  `run_sdk` sandbox (`client.entities.list`, `client.knowledge.read`) and runs
  the governed rollup live through the stock `query_sql` connection pushdown —
  no server changes, nothing copied into Lobu. `eval.ts` invokes a real agent
  through `lobu chat` when a model provider is configured.
- The **agent eval falls back to a labelled deterministic proxy** when the local
  install has no model provider (the default `lobu run` ships none). The proxy
  proves the pushed context carries the governed correction and the baseline
  does not; running it against a real model (wire one via
  `lobu agents inference-providers`) is the honest next step.
- The warehouse is deterministic — re-running `bun run seed:warehouse` resets it
  to the approved state (and clears any simulated drift).
- The context-layer seed is idempotent: it refuses to double-seed. To reseed,
  stop `lobu run`, delete `./.lobu-data`, and start over.
