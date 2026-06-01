# Database connectors (Postgres) — design + gating

Bring an external database in as memory (and, for derived entities, as live
metrics). V1 ships **Postgres**; Snowflake/BigQuery are additive (see end).

## Two materialization paths (object-decides — no `mode` toggle)

- **Memory feed** — a `postgres` connection + a `query` feed. The feed runs a
  user-authored read-only `SELECT` on a schedule, wraps it with a keyset
  compound-cursor predicate, and emits one event per row → embedded, searchable
  memory. Incremental via `cursor_column`. (`packages/connectors/src/postgres.ts`)
- **Live derived entity** — `defineEntityType({ backing: { connection, sql } })`.
  The view executes LIVE against the connection's database at read time (no copy)
  via `query_entity_type` → `execute-external-source.ts`. `backing.connection`
  omitted ⇒ the view runs over Lobu's internal `events`/`entities` (unchanged).

Single-database only: every query targets exactly one database; no cross-source
joins. True multi-source federation is deferred to an enterprise engine (DuckDB).

## SSRF / egress trust model (implemented gate)

A DB connector opens **raw TCP** from app/worker pods to the host in
`DATABASE_URL`. The dogfood reaches Lobu's *own private* PG, so the HTTP scrapers'
block-all-private-IPs rule can't be reused.

- **Self-hosted / first-party:** `DATABASE_URL` is an operator-set secret — the
  same trust boundary as any other env secret. Private IPs allowed. Ships now.
- **Untrusted multi-tenant cloud:** a tenant-supplied `DATABASE_URL` pointing at
  `169.254.169.254`, internal CIDRs, or another tenant's DB is an exfil/scan
  vector. **Not allowed yet.** Under `LOBU_CLOUD_MODE=1`, three gates apply:
  1. the postgres connector is hidden from the catalog (`connector-catalog.ts`);
  2. creating a postgres connection is hard-blocked (`manage_connections.ts` via
     `connector-cloud-gate.ts`); and
  3. the live external-read path (`executeExternalSource`) refuses to run — the
     airtight gate, since a derived view could bind to *any* env connection
     carrying a `DATABASE_URL`, not just the postgres connector.

**Before enabling on cloud (the hardening gate):** an egress allowlist;
resolve-then-pin the host IP at connect time with DNS-rebinding protection; block
link-local/metadata + internal CIDRs; per-org policy. Remove the key from
`CLOUD_RESTRICTED_CONNECTOR_KEYS` only once that lands.

## Entitlement boundary (design-only — not yet built)

Gate advanced database connectivity behind a paid tier to upsell. Seam:
`organization.plan` (`free` | `pro` | `enterprise`) + an entitlement check in the
`packages/server/src/workspace/multi-tenant.ts` auth resolver.

| Capability | Tier |
| --- | --- |
| Postgres connector + memory feeds | free / pro |
| Single-source internal derived entities | free / pro |
| External-backed (live) derived entities — `backing.connection` set | pro / enterprise |
| Warehouse connectors (Snowflake, BigQuery) | enterprise |
| Multi-DB / cross-source federation (DuckDB) | enterprise |

Enforcement points when built: connector install (`manage_connections` create),
connection count, and presence of `backing.connection` on an entity type.

## Snowflake / BigQuery forward-compat

No redesign needed. `env_keys` already takes multiple secret fields
(Snowflake account/user/keypair/warehouse/role; BigQuery service-account JSON).
`execute-external-source.ts` is built against a `SqlDialectAdapter` seam — a new
adapter (read-only enforcement, param style, `maximumBytesBilled`) plus a new
bundled connector is additive. Metered warehouses make "live, every read" cost
money → the TTL cache + a bytes cap become mandatory there, pushing big sources
toward materialization (the enterprise/DuckDB tier).
