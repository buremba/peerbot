# Connector authoring

When to write a connector, the two authoring surfaces, and the SDK contract.
The full SDK reference is `packages/connectors/src/README.md` in the repo
(`github.com/lobu-ai/lobu/blob/main/packages/connectors/src/README.md`); the
seed example is `examples/lobu-crm/npm-downloads.connector.ts`.

## When to write a connector

Search the catalog first: `client.catalog.listInstalled({ kinds: ["connectors"] })`,
then `client.catalog.listCatalog(...)` if it is not installed. If a matching
connector exists, connect to it. If none matches the data source, do **not**
conclude "no integration exists" — author a custom connector in the project.

## Two authoring surfaces

1. **Project-local custom connectors** (`connectors/<name>.connector.ts`) —
   registered in `lobu.config.ts` with
   `connectorFromFile("./connectors/<name>.connector.ts")` and compiled by
   `lobu apply`. Model on `examples/lobu-crm/npm-downloads.connector.ts`.
2. **Bundled built-ins** (`packages/connectors/src/<name>.ts`) — compiled into
   the platform catalog and auto-installed per org on first use. Only for
   connectors shipped with the platform itself.

## The contract

A connector is a default-exported class extending `ConnectorRuntime` from
`@lobu/connector-sdk` — or the functional `defineConnector({ ... })` sugar,
which lowers to the same class:

```ts
export default class MyConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "my_connector",          // catalog id; feed/action keys come from the records below
    name: "My Connector",
    version: "1.0.0",
    faviconDomain: "example.com",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      items: {
        key: "items",
        name: "Items",
        eventKinds: { item: { description: "An item from the service" } },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const events: EventEnvelope[] = [];
    return { events, checkpoint: { last_sync_at: new Date().toISOString() } };
  }
}
```

The functional `defineConnector` form derives feed/action keys from the record
keys and dispatches each call to the handler declared on that entry:

```ts
import { defineConnector } from "@lobu/connector-sdk";

export default defineConnector({
  key: "my_connector",
  name: "My Connector",
  version: "1.0.0",
  authSchema: { methods: [{ type: "none" }] },
  feeds: {
    items: {
      name: "Items",
      eventKinds: { item: { description: "An item from the service" } },
      sync: async () => ({
        events: [],
        checkpoint: { last_sync_at: new Date().toISOString() },
      }),
    },
  },
  actions: {
    create_item: {
      name: "Create item",
      requiresApproval: true,
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      execute: async (ctx) => ({
        success: true,
        output: { name: ctx.input.name },
      }),
    },
  },
});
```

Optional top-level handlers (`authenticate`, `query`, `search`,
`reflectMetrics`, `registerWebhook`, `unregisterWebhook`) dispatch through the
corresponding `ConnectorRuntime` methods.

### What a feed sync must get right

- **`origin_id` stability.** Keep `origin_id` identical for the same source item
  across syncs. Ingestion may supersede the prior row and allocate a new
  `events.id`; cross-sync dedupe relies on `origin_id`, never the row id. Change
  it only when source identity genuinely changes.
- **Checkpointing.** Return `checkpoint` (timestamp- or id-based) for incremental
  sync; use `ctx.emitEvents` / `ctx.updateCheckpoint` mid-sync for long runs so a
  crash resumes from the last saved point.
- **`eventKinds`.** Declare the event types the feed can emit. A feed's
  `eventKinds` are also the default Automation trigger catalog: each kind becomes
  a subscribable event type. The first successful non-dry sync establishes the
  feed's baseline without activation; later inserts activate subscribers. The
  derived path fires feed `eventKinds` only — if you declare explicit
  `automationEvents` keys that differ from your feed `eventKinds`, attach matching
  `automation_signals` to each emitted `EventEnvelope`, or those triggers never
  fire (the picker advertises them but ingestion never emits them).
- **No real credentials in code.** Secrets flow through `ctx.credentials` /
  `ctx.config`; workers never receive durable stored credentials.

### Actions (write-back)

Declare `actions` with an `inputSchema`, `requiresApproval`, and annotations
(`destructiveHint`, `openWorldHint`, `idempotentHint`); handle them in
`execute(ctx)`. Omit it entirely if the connector has no actions.

### Auth methods

`none`, `env_keys` (scope `connection` or `organization`), `oauth` (built-in or
custom provider with `clientIdKey`/`clientSecretKey`), and `browser` (`cli`
browser-auth or live `cdp`). Full schemas are in the SDK reference.

### Dependencies and environment

- npm deps go in the project/package `package.json` and are bundled by esbuild;
  native deps go in `runtime.nix.packages` as nixpkgs refs.
- Workers run isolated with a restricted env (`PATH`, `HOME`, `TMPDIR`, `TZ`,
  `NODE_ENV`, `NODE_PATH`, `PLAYWRIGHT_BROWSERS_PATH` only) and no filesystem
  persistence — state lives in `checkpoint`.
- Browser scraping: use the SDK's `launchBrowser` / `runReviewScrape`
  (patchright) for public scraping; use the extension bridge for user-session
  scraping of logged-in sites.

## Full reference

- `packages/connectors/src/README.md` — the complete SDK guide: definition,
  auth, feeds, sync, actions, scoring, worker sandbox.
- `packages/connector-sdk/` — the published contract (`ConnectorRuntime`,
  `defineConnector`, source primitives, browser layer).
- Seeds: `examples/lobu-crm/npm-downloads.connector.ts` (minimal, no auth),
  `examples/brand-intelligence/*.connector.ts` (richer: auth, actions, per-feed
  `eventKinds`).
