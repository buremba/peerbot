# Database connectors (Postgres) — design + gating

Bring an external database in as memory, and read it live (no copy) for derived
entities. V1 ships **Postgres**; Snowflake/BigQuery are additive (see end).

## The model: connectors push compute down; Lobu aggregates

The connector owns the DB connection — for *both* indexing and live reads. The
gateway never opens an external pool.

- **Memory feed (indexed)** — a `postgres` connection + a `query` feed runs a
  read-only `SELECT` on a schedule, keyset-incremental, and emits one event per
  row → embedded, searchable memory. (`packages/connectors/src/postgres.ts`)
- **Live read (no copy)** — the connector's `query()` runs SQL live against the
  source and returns rows, persisting nothing. The platform reaches it through one
  primitive: `runConnectorQuery` (`packages/server/src/lib/connector-pushdown.ts`),
  which invokes the connector in the worker `query` run-mode (the same inline-run
  path as `operations.execute`).
- **`query_sql({ connection })`** is the single door: with a `connection` slug it
  pushes the SQL down via `runConnectorQuery` (internal org-scoping skipped — it's
  the org's own DB); without, it runs the internal org-scoped path. There is no
  separate `query_entity_type` tool.
- **Derived entity** — `defineEntityType({ backing: { sql, connection? } })`. With
  `connection`, the read is `get_type → query_sql({ sql: backing_sql, connection })`
  → pushdown. Without, it's the shipped internal view over `events`/`entities`.

Single-database only: every query targets one database; no cross-source joins
(that's a later DuckDB-class engine).

Slice 2 (next): **virtual feeds** (a `virtual` feed flag → live reads, no events)
and **federated search** (a connector `search()` the platform fans out to and
merges with the vector index). Only the `query()` live-read primitive is in place
today; the `virtual` feed flag, `search()`, and the fan-out are the remaining work.

## SSRF / egress trust model

The DB socket lives in the **connector subprocess**, behind the worker egress
controls — not the gateway. The dogfood reaches Lobu's own private PG, so the HTTP
scrapers' block-all-private-IPs rule can't be reused.

- **Self-hosted / first-party:** `DATABASE_URL` is an operator-set secret — same
  trust boundary as any other env secret. Private IPs allowed. Ships now.
- **Untrusted multi-tenant cloud:** a tenant-supplied `DATABASE_URL` (metadata
  IPs, internal CIDRs, another tenant's DB) is an exfil/scan vector. **Not allowed
  yet.** Under `LOBU_CLOUD_MODE=1` the postgres connector is hidden from the
  catalog (`connector-catalog.ts`) and connection-create is hard-blocked
  (`manage_connections.ts` via `connector-cloud-gate.ts`). Execution is gated
  independently at every run path, not just by catalog-hide: scheduled-sync run
  creation (`queue-helpers.ts`), the production worker poll (`worker-api.ts`), the
  dev-CLI sync (`feed-sync.ts`), and the live pushdown (`connector-pushdown.ts`)
  each refuse a cloud-restricted connector under `LOBU_CLOUD_MODE`.

**Before enabling on cloud:** an egress allowlist; resolve-then-pin the host IP at
connect time with DNS-rebinding protection; block link-local/metadata + internal
CIDRs; per-org policy. Remove the key from `CLOUD_RESTRICTED_CONNECTOR_KEYS` only
once that lands.

## Entitlement boundary (design-only — not yet built)

Gate advanced database connectivity behind a paid tier. Seam: `organization.plan`
(`free` | `pro` | `enterprise`) + a check in the `multi-tenant.ts` auth resolver.

| Capability | Tier |
| --- | --- |
| Postgres connector + memory feeds | free / pro |
| Internal derived entities | free / pro |
| External-backed (live) derived entities — `backing.connection` set | pro / enterprise |
| Warehouse connectors (Snowflake, BigQuery), virtual feeds + federated search | enterprise |

Enforcement points when built: connector install, connection count, and presence
of `backing.connection`.

## Snowflake / BigQuery forward-compat

No redesign needed: each is a new bundled connector implementing `sync()` +
`query()` (+ later `search()`), with `env_keys` carrying its credentials
(Snowflake account/user/keypair/warehouse/role; BigQuery service-account JSON).
The pushdown plumbing (`runConnectorQuery`, the `query` run-mode, `query_sql`'s
`connection`) is dialect-agnostic — only the connector's own `query()` differs.
Metered warehouses make "live, every read" costly → those lean on the indexed
(memory-feed) path or materialization.
