# Events cold-tiering — architecture & spike findings

**Status:** Decision locked, implementation not yet started. 2026-05-28.

## Decision

The cloud edition tiers cold `events` rows from the PG heap to **Apache Iceberg** in object storage, addressed through **pg_lake** so all existing app SQL continues to work transparently. Hot rows stay on the PG heap with their existing indexes. The Iceberg catalog is exposed via the **standard Iceberg REST API from day one** (not pg_lake's internal PG-table catalog), which keeps the format pluggable: any Iceberg-aware engine (Snowflake, Databricks, Spark, Trino, Athena, another DuckDB) can read the same files via the same catalog without going through Lobu's Postgres. The community/OSS edition keeps the plain Postgres `events` table; the lake is a cloud-build-only divergence behind the existing `insertEvent()` chokepoint. Big-org dedicated compute is served by spinning a separate DuckDB worker against the same Iceberg files, **not** by switching the storage format. DuckLake (DuckDB-native lakehouse with its own catalog) was evaluated and rejected as a primary path because the format is DuckDB-only — no Snowflake/Databricks/Spark/Trino reads it.

## Architecture

```
                    APP READS / WRITES (Postgres SQL, unchanged)
                                    │
                                    ▼
                ┌──────────────────────────────────────────┐
                │                Postgres                  │
                │                                          │
                │  events_recent           events_cold     │
                │  ──────────────          ────────────    │
                │  Heap, indexed:          pg_lake FDW     │
                │   • btree (org_id,        ↓ Unix socket  │
                │      occurred_at DESC)    pgduck_server  │
                │   • GIN entity_ids        ↓              │
                │   • GIN metadata          DuckDB         │
                │   • PK id                                │
                │                                          │
                │  CREATE VIEW current_event_records AS    │
                │    SELECT … FROM events_recent           │
                │    UNION ALL                             │
                │    SELECT … FROM events_cold;            │
                └──────────────────────────────────────────┘
                                    │
                                    ▼
                ┌──────────────────────────────────────────┐
                │     Iceberg / parquet on Hetzner S3      │
                │     Partition: month(occurred_at)        │
                │              + bucket(8, org_id)         │
                │     One source of truth for cold data    │
                │     Catalog: Iceberg REST API            │
                │     (standard, multi-engine ready)       │
                └──────────────────────────────────────────┘
                       ▲             ▲                ▲
                       │             │                │
        ┌──────────────┘             │                └────────────────────┐
        │                            │                                     │
  pg_lake on shared PG       Big-org DuckDB worker        Customer Snowflake /
  (Mode 1 — default tier,    (Mode 2 — premium tier,      Databricks / Spark / Trino
   all 48 app sites           reads same Iceberg via       (Mode 3 — BYO-compute,
   unchanged, SQL-only)        REST catalog, bypasses       points at our REST catalog,
                               shared PG entirely)          customer's billing & compute)
```

**Tiering job (background, ~50 lines SQL, single PG transaction):**

```sql
WITH moved AS (
  INSERT INTO events_cold
    SELECT * FROM events_recent
    WHERE occurred_at < now() - interval '90 days'
    RETURNING id
)
DELETE FROM events_recent WHERE id IN (SELECT id FROM moved);
```

That single statement is the entire complexity the engine doesn't handle for us. Atomic move + delete in one MVCC snapshot. No 2PC, no fencing tokens, no reconciliation.

## Why pg_lake (not raw DuckLake)

The decision is grounded in three things: an audit, a 10M-row apples-to-apples bench on identical data, and a planner-pushdown verification.

### Audit: where does the codebase touch `events`?

74 sites total, bucketed by query shape:

- **A — Cold analytical (34 sites)**: aggregates, date_trunc'd stats, full-history scans. Iceberg-friendly. Lake win.
- **B — OLTP (22 sites)**: indexed lookups by (org_id, occurred_at), recent point reads, txn writes. Stay on heap.
- **C — Vector / FTS (7 sites)**: pgvector + tsvector. Stay on PG regardless (separate track, see appendix).
- **D — Exotic SQL (11 sites)**: LATERAL joins for thread context, `entity_ids @> ARRAY[...]`, `metadata->>` identity lookups, correlated count subqueries. Stay on indexed heap.

The decisive number: **48/74 sites read the `current_event_records` view** in raw PG SQL today. Under DuckLake, all 48 need rewriting to a DuckDB connection — months of work, plus loss of transactional joins with hot heap data. Under pg_lake, the view simply gets redefined as `UNION ALL` over heap + Iceberg and every caller keeps working unchanged.

### Spike: 10M-row bench, identical data, same partitioning

Run on `pglake-spike.exe.xyz` (Ubuntu 24.04, 80 GB disk, PG 18.4, pg_lake 3.4 + pgduck_server with DuckDB 1.4.4, MinIO as S3-compatible object store, DuckDB 1.5.3 client for DuckLake). Synthetic events shaped like Lobu's schema: UUID id, UUID org_id, TIMESTAMPTZ occurred_at, semantic_type, source_id, JSONB metadata, TEXT[] entity_ids (1–3 per row), content. Recency-weighted timestamps (50% last 90d, 30% last year, 20% older). 10 orgs with Pareto weights (biggest org = 5M rows). Same TSV loaded into both stacks; same partition: `month(occurred_at) + bucket(8, org_id)`.

```
LOAD  10M rows (2.99 GB TSV → parquet)             time (lower = better)
   pg_lake   ████████████████████████████████████████████████████  109 s   532 MB
   DuckLake  █████████                                              19.7s  556 MB
                                                                    ▲ DuckLake 5.5×
                                                                      (HTTP→MinIO vs
                                                                       local FS, not
                                                                       a hot-path bottleneck)

Q1  HOT RECENT — last 7d, big org (~195k rows in window)
   pg_lake   ████████████████████████████████████████████  156 ms
   DuckLake  ███████████                                    37 ms
                                                            ▲ both prune by month partition
                                                              gap = PG↔pgduck IPC overhead

Q2  ARCHIVE AGGREGATE — month(occurred_at), big org full history (5M rows)
   pg_lake   ████████████████████████████████████████████  721 ms
   DuckLake  ███████████████████████████████████████████   701 ms
                                                            ▲ TIED — same DuckDB engine

Q3  POINT LOOKUP BY id — one UUID in 10M
   pg_lake   ████████████████████████████████              208 ms
   DuckLake  ████████████████████████████████████████      262 ms
                                                            ▲ BOTH BAD
                                                              no row index in Iceberg or
                                                              DuckLake parquet; full
                                                              bucket scan in both
                                                              (DuckLake scanned 1810/1819 files)

Q4  ENTITY CONTAINMENT — entity_ids @> ARRAY[uuid]  (50k of 10M match)
   pg_lake   ████████████████████████████████████████████████████  12,641 ms  ⚠
   DuckLake  ██                                                       490 ms
                                                                   ▲ 25.8× gap
   pg_lake plan:  Foreign Scan ... Filter: entity_ids @> '{...}'
                  Rows Removed by Filter: 9,949,925            ← PG-side filter after
                                                                 pulling all 10M rows
                                                                 via the Unix socket
   DuckLake plan: list_contains() runs INSIDE DuckDB scan, only matching rows surface.
```

Root cause of Q4 confirmed in source: `pg_lake_engine/src/pgduck/shippable_builtin_operators.c:472` deliberately omits `@>` / `<@` for arrays:

```c
{"&&", "pg_catalog", "arrayoverlap", 2, {"anyarray", "anyarray"}, NULL},
/* @> and <@ behave differently for NULL */
```

Filed upstream as [Snowflake-Labs/pg_lake#373](https://github.com/Snowflake-Labs/pg_lake/issues/373) with a proposal: ship `@>` / `<@` when the RHS is a `Const` array with no NULL elements (the overwhelmingly common case). Precedent #198 (push down `initcap`) was accepted by the same shape of fix. If accepted, Q4 closes; if not, the audit's bucket D recommendation (entity_ids @> stays on hot heap) was already the plan regardless.

### UNION ALL pruning — the decisive architectural check

Set up the real production shape on the spike VM: heap `events_recent` (5M rows, last 90 days, btree + GIN indexes) UNION ALL with Iceberg `events_cold` (older rows). Query the view with both an org filter and a recent time predicate. Did Postgres push the outer predicate through the view into the Iceberg arm? Did pg_lake prune the Iceberg side?

Q1 plan via the view:

```
->  Foreign Scan on events_iceberg
    Vectorized SQL:  SELECT "occurred_at" FROM ...
      WHERE (("occurred_at" <= '2026-02-27...')      ◄ view's internal cold-bound
        AND  ("occurred_at" > '2026-05-21...')        ◄ outer "last 7 days" pushed in
        AND  ("org_id" = '...'::uuid))                ◄ outer org filter pushed in
    ->  EMPTY_RESULT                                  ◄ contradictory range detected
    Data Files Scanned: 0                             ◄ zero parquet files touched
```

The cold arm contributed zero work to a "last 7 days" query. The 600 ms total wall time was entirely the heap arm hitting cold disk blocks; on a warm system it would be sub-100 ms. **PG's planner correctly distributes outer predicates across UNION ALL arms, the foreign scan receives them, and pg_lake's partition + file pruning takes it from there.** This is the load-bearing architectural property and it works.

The other three queries through the view:

- **Q2 archive aggregate** (touches both arms by design): 6.3 s, with each arm correctly receiving the org_id filter. Heap scanned 5M, Iceberg pruned to its share. Acceptable for the full-history workload.
- **Q3 point lookup via view**: 174 ms. Heap PK index hit in 0.14 ms; Iceberg arm scanned a bucket in 136 ms. Both arms run because the heap PK doesn't prove uniqueness across the union. Hot-side optimization possible later (rewrite point lookups to hit heap directly when caller knows the id is recent).
- **Q4 entity_ids @> via view**: 6.7 s. Heap arm correctly uses GIN (104 ms, 25k matching rows). Iceberg arm pays the @>-not-shippable tax (6.5 s). This is the workload that must stay on heap-only queries until #373 lands.

## Why not DuckLake

DuckLake is a real alternative and worth being precise about why it lost.

### DuckLake's storage IS comparable but its catalog and read path aren't

DuckLake stores parquet in object storage with metadata in PG catalog tables, queried by DuckDB. Storage is comparable to Iceberg (~556 MB vs pg_lake's 532 MB on the bench). DuckDB-native query is faster (Q1 4×, Q4 25×). For an analytics-first workload that doesn't already have an OLTP-shaped Postgres backbone, it's an excellent choice.

For Lobu specifically, three things knock it out:

**1. App-side read path rewrite.** 48 sites read events in raw PG SQL via the view. DuckLake means each of those becomes a DuckDB connection: a separate driver, separate transaction context, no JOIN with hot PG tables in one statement. Estimated cost: 2–3 months of read-path migration plus loss of transactional joins with `identity_fact`, `interaction`, `notification`, and the supersession manifest.

**2. Cross-engine transactionality.** Hot heap (PG) and cold lake (DuckDB) live in separate transaction worlds. The tiering job goes from "one PG transaction does move + delete" to "lake-write commits, then PG-delete, hope no rows wrote into that range between snapshots, add fencing tokens for replays". Every solution is bookkeeping pg_lake doesn't need.

**3. Format lock-in.** DuckLake's catalog format is DuckDB-specific. Iceberg is an open standard with multiple-engine readers (Spark, Trino, Athena, Snowflake itself). For a future where premium-tier customers want to read their own lake from their own tooling — or where Lobu wants to ingest external Iceberg from a customer's warehouse — Iceberg is the obvious choice.

### DuckLake's "data inlining" doesn't solve our hot-tier needs

DuckLake supports inserting small batches into PG catalog tables (named `ducklake_inlined_data_N_N`) and compacting them to parquet later. Elegant in principle: no tiering job, the engine handles the hot/cold transition, app reads transparently merge.

The catch is what the "hot tier" actually contains. Inlined rows live in DuckLake's catalog tables — DuckLake's schema, not yours. You can't add a GIN index on `entity_ids`, can't add a btree on `(org_id, occurred_at)`, can't add a JSONB GIN on `metadata`, can't add a partial unique constraint on supersession. The hot reads Lobu actually does — chat-thread context, identity-namespace lookup, entity containment — would all turn into seqscans over inlined data. At even modest row counts those are seconds, not milliseconds, and the hot path serves real-time chat traffic.

The "no tiering job" win is real. The cost is giving up all hot-side indexes. The tiering job we'd otherwise write is **50 lines of SQL in one transaction.** That trade is not close.

### Three read modes, one storage, one catalog

This is the part that future-proofs the architecture. The decision was nudged by two questions raised during review: "can per-org isolation be cleaner than shared-PG?" and "could the catalog/cold backend be Snowflake/Databricks in the future?". Both are answered by treating storage, catalog, and compute as separable, with Iceberg's open ecosystem doing the work.

**pg_lake's compute is yoked to the PG instance** (pgduck_server connects via Unix socket only, [#288 open](https://github.com/Snowflake-Labs/pg_lake/issues/288)). To give a big org dedicated compute on the cold tier *through pg_lake*, you'd give them a dedicated PG node — heavier than ideal. **But you don't have to use pg_lake to read the lake.** The Iceberg files in S3 are an open standard, and the Iceberg REST catalog is a standard HTTP protocol. Any engine that speaks Iceberg can read the same data via the same catalog with no involvement from Lobu's PG.

Three modes of read access, one format on disk, one catalog protocol:

| Mode | Compute | Catalog | When |
|---|---|---|---|
| **1 — Default tier** | pg_lake on shared PG | REST catalog (internal) | Always. All 48 app sites read here. |
| **2 — Premium isolation** | Dedicated DuckDB worker pod | REST catalog (internal) | Big orgs on shared infra that need read isolation. Same Iceberg files, no shared-PG load. |
| **3 — BYO-compute** | Customer Snowflake / Databricks / Spark / Trino / Athena | REST catalog (exposed) | Enterprise tier customer wants to run their own queries against their data with their own billing and tooling. |

Writes stay on Mode 1 — pg_lake-mediated for atomicity. **Reads diverge per tier; storage and catalog do not.**

```
                    STORAGE                CATALOG                COMPUTE
                    ─────────              ─────────              ─────────
   What it is       parquet files          Iceberg REST API       engine that
                    in object storage      (snapshot mgmt,        executes SQL/
                    (Hetzner / R2 / S3)     schema, partitions)   reads parquet
   
   Standard?        yes (Apache Iceberg)   yes (REST spec)        any (DuckDB,
                                                                   Snowflake,
                                                                   Spark, Trino…)
   
   Lobu's role      writes (mode 1)        runs the REST          mode 1 (shared)
                                           server                 + mode 2 (per-org)
   
   Customer's role  reads what we wrote    consumes the           mode 3 (their
                                           REST API                own engine)
```

### Why Iceberg REST catalog from day one

pg_lake supports two catalog modes: its **internal PG-table catalog** (metadata sits in your Postgres tables) and a **REST-catalog client** (talks to a separate REST server). The internal catalog is simpler — no extra process. The REST catalog is the standard.

```
                      Internal PG catalog        Iceberg REST catalog
                      ──────────────────────     ─────────────────────────
   Operational        ✅ no extra service        ⚠ run a REST server
                       (one less moving part)     (or use AWS Glue, Polaris,
                                                   Snowflake Polaris, Unity)
   
   pg_lake reads      ✅                          ✅
   
   DuckDB direct      ⚠ via postgres_scanner     ✅ native iceberg_scan()
   read (mode 2)        (slower, brittle)
   
   Snowflake reads    ❌ requires their own      ✅ native
   (mode 3)             federation layer
   
   Databricks reads   ❌                          ✅ via Unity Catalog
                                                   federation to REST
   
   Spark / Trino /    ❌                          ✅ standard
   Athena reads
   
   Future catalog     ⚠ migration                 ✅ swap REST server
   swap                                            (Polaris → Unity → ...)
```

The "use REST catalog from day one" decision is cheap insurance. Concretely, start with an open-source REST catalog implementation (Apache Polaris, Nessie, or even pg_lake-on-top-of-an-existing-pg via a thin REST shim). Cost: one additional service to run. Benefit: mode 2 and mode 3 work without re-architecting.

### What about DuckLake-per-org as the per-tenant story?

User intuition during review was: "for DuckLake we don't even need to write to Postgres — it can be an org-specific sandbox in DuckDB landing in object storage, with entities in PG." Architecturally appealing for isolation. Two reasons this loses to Iceberg-with-mode-2:

**Format compatibility.** DuckLake is DuckDB-only. Snowflake doesn't read DuckLake. Databricks doesn't. Spark doesn't. If a customer ever wants their own engine (mode 3), DuckLake locks you out. Iceberg makes that customer-friendly.

**Default-tier cost.** Per-org DuckDB sandbox would force the 48-site read-path rewrite on **every** tenant (not just premium). Even small orgs would pay the cross-engine cost. Mode-2 dedicated DuckDB worker activates only when a tenant actually needs isolation; everyone else stays on the SQL-transparent default.

### Path summary

| Path | Engine | Why |
|---|---|---|
| App insert → hot heap | PG INSERT (existing) | OLTP, no change |
| Tiering job: heap → lake | pg_lake (PG-mediated SQL) | Atomicity in one PG transaction |
| App read (mode 1, default) | PG view → pg_lake → DuckDB → parquet | SQL-transparent |
| App read (mode 2, big org) | Dedicated DuckDB worker on same Iceberg | Compute isolation, storage shared |
| App read (mode 3, BYO) | Customer Snowflake/Databricks via REST catalog | Customer compute + billing |
| External Iceberg ingest | Direct REST-catalog table registration | Bypass PG for foreign data |

Format = Iceberg throughout. Catalog = REST throughout. Compute = whatever the use case demands.

## Why community keeps plain PG events

The lake adds operational dependencies (pg_lake extension, pgduck_server sidecar, S3-compatible object store, Iceberg REST catalog service, MinIO or hosted bucket). For a self-hosted single-binary `lobu run` install, that's an unacceptable footprint. The cloud edition can absorb the ops; the community edition stays single-PG. The `insertEvent()` chokepoint and the `current_event_records` view are the only seams; community-build defines them to point at the single events table, cloud-build defines them to point at the UNION ALL of heap + Iceberg. No app-layer branching.

## Open items

- **pg_lake#373** filed; waiting on Snowflake response. If accepted, Q4 closes. Either way, the cold path doesn't query entity_ids @> directly.
- **Real-org sample bench.** Synthetic data used recency-weighted timestamps with σ=0.02 noise — close to real but unverified. A one-org export from `summaries-prod` would lock the numbers.
- **Tiering job scheduling.** Cron interval, batch size, what happens if S3 is slow. Operational design, not architectural.
- **Multi-replica concurrency.** Tiering only runs on one replica at a time (advisory lock). Per-org affinity for the tiering pass to keep file consolidation tidy.
- **GC / compaction of small Iceberg files.** pg_lake supports `VACUUM` on Iceberg tables; needs a scheduled pass.
- **Hetzner S3 vs Cloudflare R2 vs Backblaze** for object storage. Latency and egress cost; Hetzner is cheapest, R2 has zero egress. Out of scope here.
- **REST catalog pick.** Apache Polaris, Project Nessie, or a thin Postgres-backed REST shim. Polaris is Snowflake-affiliated and matches the BYO-Snowflake mode-3 story; Nessie has git-style branching but is heavier. Decide before implementation starts.
- **Mode-2 (DuckDB worker) pattern is sketched, not designed.** Specifically: per-org auth to the REST catalog, partition affinity, how it picks up commits made by pg_lake's tiering job (likely just a snapshot refresh). Worth its own design pass when the premium tier is concrete.
- **Mode-3 (BYO-compute) story is a future surface.** When the first enterprise customer asks, design the per-org REST-catalog scoping (credential issuance, read-only role, rate limits, isolation between tenants' catalogs).

## Spike artifacts

Live on `pglake-spike.exe.xyz` (exe.dev VM, 80 GB; tear down when no longer useful):

- `~/spike/gen.py` — 10M-event synthetic generator
- `~/spike/events.tsv` — 2.99 GB generated dataset
- `~/spike/sql/pglake_ddl_v3.sql` — Iceberg DDL
- `~/spike/sql/q_pglake.sql` — pg_lake query bench
- `~/spike/sql/q_ducklake.sql` — DuckLake query bench
- `~/spike/sql/union_test.sql` — UNION ALL pruning test
- `~/spike/copy_iceberg.log` — Iceberg load timing
- `~/spike/copy_ducklake3.log` — DuckLake load timing
- `~/spike/union_test.log` — UNION ALL plan output

Build gotchas worth remembering if anyone reproduces:

- pg_lake's Dockerfile fetches PostGIS from osgeo.org which times out on some networks. Patched to GitHub tag tarball + `./autogen.sh` before configure.
- LocalStack 2026.5.1 is now paywalled ("license activation failed"). Swapped to MinIO via an override compose file; endpoint `minio:9000`, credentials `test`/`testtest123`, bucket `testbucket`. The same DuckDB S3 SECRET shape works.
- pgduck_server vcpkg build needs ≥60 GB free disk (aws-sdk-cpp builds debug + release for all 26 transitive AWS libs). 20 GB blows up on aws-sdk-cpp tar extract. Resize the VM first.

## Implementation outline (not yet started)

Roughly in order; each independently shippable.

1. **Cloud-build feature flag.** `LOBU_CLOUD_LAKE=1` gates lake code paths. Community keeps plain events.
2. **`events_recent` + `events_cold` tables.** Migrations to create the heap (`events_recent` = the existing events table renamed) and the Iceberg shadow.
3. **`current_event_records` view redefinition.** Community: `SELECT … FROM events_recent` only. Cloud: `UNION ALL` over both. Zero app code changes outside the migration.
4. **Tiering job.** Single SQL in a cron-scheduled worker. Advisory-lock per org. Observability: count rows moved per run, snapshot version after each commit.
5. **`insertEvent()` chokepoint.** Unchanged on hot path — always writes to `events_recent`. Tiering is what moves rows.
6. **Iceberg VACUUM schedule.** Daily compaction pass on the Iceberg side via pg_lake's built-in. Trim manifest size.
7. **MinIO or hosted S3 in the cloud chart.** Helm values for object-store endpoint + creds. Probably Hetzner Object Storage given the cost ceiling.
8. **Iceberg REST catalog from day one.** Run a REST catalog service (Apache Polaris, Nessie, or equivalent) alongside pg_lake instead of pg_lake's internal PG-table catalog. Extra service to run; in exchange, mode 2 (dedicated DuckDB worker) and mode 3 (customer BYO compute) work without re-architecting later. The internal-catalog short-cut is technical debt this design refuses up front.
9. **Mode-2 DuckDB worker pattern.** Separate design pass when concrete premium tenants exist. Sketch: per-org DuckDB pod attached to the REST catalog with read-only credentials, scaled independently of the shared PG.
10. **Mode-3 BYO-compute story.** When the first enterprise customer asks. Sketch: surface a REST-catalog endpoint per-org with scoped credentials; document partition layout and schema; customer points their Snowflake/Databricks at it.

---

## Appendix A — Vector engine spike (event_embeddings, separate track)

Same VM, separately benchmarked against 100k and 1M synthetic 768-dim vectors with σ=0.02 cluster noise. Decision-relevant because the biggest org today has ~1.23M embedded rows and the cold-tiering decision intersects with embedding storage (do vectors go to the lake too? Answer: no, stay on hot PG with an index that handles 1M+).

```
n=100,000   recall ≥ 0.95 ?    p50 ms    qps     index    build
─────────────────────────────────────────────────────────────────
pgvector HNSW   ✓ ef=40         3.18      331     410 MB   86 s
VectorChord     ✓ probes=8      1.89      452     467 MB   30 s
pgvectorscale   ✗ max 0.53      —         —        68 MB   62 s   (rescore-config bug)
Qdrant HNSW     ✓ ef=16         1.78      512    1128 MB   35 s

n=1,000,000   recall ≥ 0.95 ?    p50 ms    qps     index    build
─────────────────────────────────────────────────────────────────
pgvector HNSW   ✗ max 0.892     —         —      4096 MB   585 s   ◄── COLLAPSES at default m=16
VectorChord     ✓ probes=16     6.40      137    4378 MB   546 s
pgvectorscale   ✗ max 0.237     —         —       683 MB  1544 s   (rescore-config bug)
Qdrant HNSW     ✓ ef=128        1.93      502    7734 MB   334 s
```

**Reads at 1M:**

- **pgvector default (m=16) recall collapses.** Tunable to m=24/32 with better recall, but out-of-box behavior is what most teams ship with. The biggest org today (1.23M) is past this cliff.
- **VectorChord is the in-place Postgres-native upgrade.** 0.95+ recall at ~6 ms, no sidecar service, same SQL surface (`SELECT … ORDER BY embedding <-> $1 LIMIT N`), drop-in replacement for the existing `event_embeddings` ivfflat. Requires `shared_preload_libraries='vchord'` + a restart (chart change).
- **Qdrant is fastest but adds a service.** ~1.93 ms p50, 502 qps, 7.7 GB index (1.8× VectorChord). Worth it only if payload filtering or dynamic schemas become a real need.
- **pgvectorscale's recall was a config bug on my side** (SBQ single-bit quantization needs `diskann.query_rescore` which I didn't sweep). Its 6× index compression (683 MB vs 4.4 GB) is real and worth a fair re-test before locking VectorChord.

**Tentative call:** VectorChord on `event_embeddings`. Stays in Postgres, no sidecar, fits the "events stays SQL-addressable" stance, handles the scale the biggest org is already at. Pre-merge work owed: rerun pgvectorscale with `diskann.query_rescore=200` for a fair comparison; bench VectorChord against a real-org embedding export, not synthetic; chart-side `shared_preload_libraries` config + restart plan.

This is its own decision and shouldn't block the cold-tiering work. Surfaced here because the spike infrastructure overlapped and the conclusion ("vectors stay on hot PG") informs why the cold-tiering doc only deals with non-vector columns.

Vector spike data: `~/vector-spike/results_pg18_{100k,1m}_4eng.json` and `~/vector-spike/bench.py` on the Mac dev box.

---

## Appendix B — Bench methodology (reproducibility)

10 orgs, weighted (50/20/10/5/5/3/3/2/1/1) so the biggest holds ~5M of 10M rows (mimics a real Pareto distribution). 200 distinct entities per org for `entity_ids` queries; 1–3 entity refs per row. 50k distinct `source_id` values for origin lookups. Timestamps spread across 3 years with recency weighting (50% in last 90d, 30% in last year, 20% older). semantic_type weighted toward `content`. Generator: `~/spike/gen.py`, fixed seed.

Both stacks loaded from the same TSV (`events.tsv`, 2.99 GB) over the same VM, same disk, same network. pg_lake used the official `docker/Dockerfile` from Snowflake-Labs/pg_lake@release-3.4 with the postgis URL patch + MinIO override compose described above. DuckLake used DuckDB 1.5.3 native CLI with `INSTALL ducklake; LOAD ducklake; INSTALL postgres; LOAD postgres; ATTACH 'ducklake:postgres:...';`. Same partition scheme on both: `month(occurred_at) + bucket(8, org_id)` (year separately bucketed in DuckLake because its partition syntax is slightly different but the effect is the same).

Queries ran once each (no warm-cache repeat). 10–15 % run-to-run variation expected on the 100–700 ms queries; the 12.6 s pg_lake Q4 result is far enough above noise to be conclusive. The point of the spike was the **shape** of the gaps and the planner behavior, not benchmark-grade absolute numbers — for those, re-run with real-org embedding data and a warm-cache pass.
