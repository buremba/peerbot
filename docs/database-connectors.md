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
  path as `operations.execute`). Virtual feeds use the same connector pushdown via
  `readVirtualFeed`: a stored feed query is read live and still persists nothing.
- **`query_sql({ connection })`** is the single door: with a `connection` slug it
  pushes the SQL down via `runConnectorQuery` (internal org-scoping skipped — it's
  the org's own DB); without, it runs the internal org-scoped path. There is no
  separate `query_entity_type` tool.
- **`query_sql({ feed })`** reads one virtual feed live by numeric feed id or
  `"connection_slug/feed_key"`. The feed's stored `config.query` is the source
  query; caller `sql` is ignored. `search_term` narrows through the connector
  `search()` pushdown when available.
- **`SELECT FROM events` is persisted-only.** It reads synced/materialized content,
  not live virtual feeds. When the internal SQL references `events`, `query_sql`
  best-effort returns `coverage.source = 'persisted_events_only'` with up to five
  visibility-fenced `suggested_virtual_feeds`, `more_available`, and a ready
  `query_sdk` example using `client.feeds.readMany`. Coverage lookup failures log
  and omit the block; they never fail the SQL query.
- **Derived entity** — `defineEntityType({ backing: { sql, connection? } })`. With
  `connection`, the read is `get_type → query_sql({ sql: backing_sql, connection })`
  → pushdown. Without, it's the shipped internal view over `events`/`entities`.

Single-database only: every query targets one database; no cross-source joins
(that's a later DuckDB-class engine).

Slice 2 (shipped): **virtual feeds** (`feeds.kind = 'virtual'` / legacy
`virtual = true` → live reads, no events) and connector `search()` for live recall.
What is still not built is transparent SQL federation or server-side cross-source
fan-out for `events` queries. Agents decompose explicitly: use `query_sql` for
persisted rows, then read suggested live feeds in parallel with `query_sdk` or
`manage_feeds`.

## Agent-facing live feed reads

Agents can batch live feed reads through `manage_feeds({ action: 'read_feeds' })`
or the read-only SDK method:

```ts
export default async (_ctx, client) => {
  return client.feeds.readMany({ feed_ids: [123, 456], limit: 25 });
};
```

`readMany` reads up to 10 feeds in parallel. Each feed returns independently as
`{ ok: true, result }` or `{ ok: false, error }`, so a missing or visibility-fenced
feed does not fail the whole batch. The per-feed response timeout defaults to 10s
and clamps at 30s; it bounds the batch response, not necessarily the underlying
connector work.

## SSRF / egress trust model

The DB socket lives in the **connector subprocess**, behind the worker egress
controls — not the gateway. The dogfood reaches Lobu's own private PG, so the HTTP
scrapers' block-all-private-IPs rule can't be reused.

- **Self-hosted / first-party:** `DATABASE_URL` is an operator-set secret — same
  trust boundary as any other env secret. Private IPs allowed. Ships now.
- **Untrusted multi-tenant cloud:** a tenant-supplied `DATABASE_URL` (metadata
  IPs, internal CIDRs, another tenant's DB) is an exfil/scan vector. **Not allowed
  yet.** Under `LOBU_CLOUD_MODE=1` the postgres connector is hidden from the
  catalog (`LOBU_CATALOG_URIS` / `manage_catalog list_catalog`) and connection-create is hard-blocked
  (`manage_connections.ts` via `connector-cloud-gate.ts`). Execution is gated
  independently at every run path, not just by catalog-hide: scheduled-sync run
  creation (`runs/queue-service.ts`), the production worker poll (`worker-api.ts`), the
  dev-CLI sync (`feed-sync.ts`), and the live pushdown (`connector-pushdown.ts`)
  each refuse a cloud-restricted connector under `LOBU_CLOUD_MODE`.

**Egress guard (`packages/connectors/src/db-egress-guard.ts`).** The connector
runs a pre-connect host check on both `sync()` and `query()`. Policy comes from
`ctx.config.LOBU_DB_EGRESS_POLICY`, injected by the server from cloud mode:

- `allow-private` (self-hosted, the default) — allows loopback / RFC1918 / CGNAT
  / ULA, but still blocks link-local + cloud metadata (`169.254/16`), multicast,
  and the unspecified address (no DB lives there).
- `block-private` (cloud) — blocks **every** non-public address. A hostname is
  resolved and rejected if ANY returned address is blocked (multi-record rebind),
  with IPv4-mapped / NAT64 / zone-id normalization and fail-closed on malformed
  literals.

**Remaining before enabling on cloud** (then remove the key from
`CLOUD_RESTRICTED_CONNECTOR_KEYS`): pin the resolved IP into the socket to close
the DNS-rebind TOCTOU across the pool, force TLS when the URL omits it, and a
per-org allowlist. The classifier + reject is in place and tested; the gate is
what currently keeps untrusted tenants out.

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
