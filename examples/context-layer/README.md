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
- **+500 cancellations on 2026-03-12/13** — a bad Recharge billing migration
  wrote false cancellation rows. The numbers are *wrong*.
- **+45 cancellations on 2026-05-19..21** — a real courier strike. The numbers
  are *right* but the cause is external and temporary.
- **A definition change on 2026-05-01** — churn moves to v2 (a 28-day dunning
  grace excludes payment-failure cancellations).

Raw churn shows a terrifying 530 in March and an elevated 75 in May. Neither is
"churn getting worse." A context layer makes that legible without archaeology.

## How the pieces map

| Concept | Where it lives | What it governs |
|---------|----------------|-----------------|
| **Business events** | `business-event` entities | The dated, sourced *why* behind an anomaly — a data incident, a definition change, an external shock. Each carries a `source_link` (Linear ticket, decision doc, Slack thread) and an `expected_effect` instruction. |
| **Definition changelog** | `metric-definition` entity + a supersede chain of `definition` events | The versioned meaning of the metric. A new version **supersedes** the previous one, so the current definition is the one unsuperseded event and the whole chain is the changelog — append-only, never edited. |
| **Live warehouse federation** | a `postgres` connection + a **virtual feed** | The monthly rollup is pushed down to the warehouse and read **live** at request time through the connector — nothing is copied into Lobu. The numbers are whatever the warehouse says right now. |
| **Deterministic composition** | `compose.ts` → one sandboxed `run_sdk` script | Joins the live series + business events + definition versions **in JS, no LLM**, into a raw-vs-adjusted series with a flag and a governing version per month. |
| **Verified-query drift canary** | `verified-query` entity + `drift-check.ts` | A human-approved answer (the exact SQL + the rows it produced at approval time) is pinned. Re-running the query and diffing against the pinned answer is the canary: a mismatch means the warehouse (or a definition) moved and the answer needs re-verification — *before* someone repeats a stale number in a board deck. |

The connection, auth profile, and entity schema are declared in
`lobu.config.ts` (config-as-constructor) and created by `lobu run`. The seed
script adds the virtual feed, the definition chain, the business events, and the
pinned verified answer on top.

```
context-layer/
├── lobu.config.ts              # agent, entity types, warehouse connection + auth profile
├── IDENTITY.md                 # the analyst agent's identity
├── env.example                 # copy to .env
└── scripts/
    ├── seed-warehouse.ts        # provision the fake warehouse (deterministic)
    ├── seed.ts                  # seed the context layer (feed, definitions, events, pinned answer)
    ├── compose.ts               # THE MONEY SHOT — adjusted churn narrative
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
bun run compose          # compose the adjusted-churn narrative  ← the money shot
bun run drift:simulate   # add one cancellation so the canary has drift to catch
bun run drift            # re-run the pinned query and report the drift
```

## Sample output

Real output captured from an end-to-end run against the embedded stack.

### `bun run compose`

```
Connected to local gateway (org: local-install)
  (run_sdk: 5 SDK calls in 254ms, sandboxed)

=== Adjusted churn for churn_rate ===

┌────┬─────────┬─────┬──────────┬─────┬───────────────────────────────────┐
│    │ month   │ raw │ adjusted │ def │ flags                             │
├────┼─────────┼─────┼──────────┼─────┼───────────────────────────────────┤
│  0 │ 2025-07 │ 30  │ 30       │ v1  │                                   │
│  1 │ 2025-08 │ 30  │ 30       │ v1  │                                   │
│  2 │ 2025-09 │ 30  │ 30       │ v1  │                                   │
│  3 │ 2025-10 │ 30  │ 30       │ v1  │                                   │
│  4 │ 2025-11 │ 30  │ 30       │ v1  │                                   │
│  5 │ 2025-12 │ 30  │ 30       │ v1  │                                   │
│  6 │ 2026-01 │ 30  │ 30       │ v1  │                                   │
│  7 │ 2026-02 │ 30  │ 30       │ v1  │                                   │
│  8 │ 2026-03 │ 530 │ —        │ v1  │ data_incident                     │
│  9 │ 2026-04 │ 30  │ 30       │ v1  │                                   │
│ 10 │ 2026-05 │ 75  │ 75       │ v2  │ external_shock, definition_change │
│ 11 │ 2026-06 │ 30  │ 30       │ v2  │                                   │
└────┴─────────┴─────┴──────────┴─────┴───────────────────────────────────┘

=== Definition changelog ===
  v1 (from 2025-07-01): churn_rate v1 = subscriptions cancelled in month / active subscriptions at month start. A subscription churns the day cancelled_at is set.
  v2 (from 2026-05-01) [current]: churn_rate v2 = cancellations excluding payment-failure cancellations inside a 28-day dunning grace / active subscriptions at month start.

=== Narrative ===
  • 2026-03: raw 530 EXCLUDED — Recharge billing migration wrote false cancellations (https://linear.app/kelder/issue/DATA-142). Adjusted series drops this month.
  • 2026-05: raw 75 genuinely elevated — Courier strike (Randstad region) (https://kelder.slack.com/archives/C042/p1747650000). Real but flagged; do not extrapolate.
  • 2026-05: definition moved to v2 — Churn definition v2: dunning grace period (https://notion.so/kelder/churn-v2). Do not compare raw across the boundary.

Adjusted churn excludes months distorted by data incidents and labels each month with the governed definition version in effect. Every flag cites its source of truth.
```

The March spike (a data incident) is **excluded** from the adjusted series. The
May elevation (a real courier strike) is **kept but flagged** — real, temporary,
don't extrapolate. Every month from 2026-05 is labelled **v2**; earlier months
**v1**. No LLM ran; the composition is a deterministic join over the live
warehouse and the governed records.

### `bun run drift:simulate` then `bun run drift`

Before any mutation the pinned answer matches the live warehouse:

```
Verified query: "How many cancellations did we have per month?"
Approved by head-of-data on 2026-07-12 (12 pinned rows vs 12 live rows)

✅ No drift — the pinned answer still matches the live warehouse.
```

`bun run drift:simulate` inserts one new cancellation into 2026-06:

```
Inserted 1 new cancellation (id 2001) into 2026-06. Warehouse now reports 31 cancellations for that month.
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
│ 0 │ 2026-06 │ 30     │ 31      │
└───┴─────────┴────────┴─────────┘

The pinned answer is stale. Re-verify before quoting either side.
```

## Notes

- Runs on **stock Lobu**. The composition and drift scripts use the standard
  `run_sdk` sandbox (`client.feeds.readMany`, `client.entities.list`,
  `client.knowledge.read`) — no server changes. Rendering this context directly
  inside an agent's prompt/answer is a separate enhancement, not required here.
- The warehouse is deterministic — re-running `bun run seed:warehouse` resets it
  to the approved state (and clears any simulated drift).
- The context-layer seed is idempotent: it refuses to double-seed. To reseed,
  stop `lobu run`, delete `./.lobu-data`, and start over.
