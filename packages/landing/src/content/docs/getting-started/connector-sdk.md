---
title: Connector SDK
description: Write TypeScript connectors that turn REST APIs, webhooks, and files into the Lobu event stream.
---

Connectors are how Lobu turns external systems — REST APIs, GraphQL, webhooks, files, OAuth-protected services — into the typed event stream that watchers shape into entities and memory.

A connector is a TypeScript class that extends [`ConnectorRuntime`](/reference/connector-sdk/#connectorruntime) and ships three things:

- a **`definition`** describing the connector (key, name, version, auth, feeds, actions),
- a **`sync(ctx)`** method that pulls the next slice of data and returns events,
- an optional **`execute(ctx)`** method that runs writes back to the source (create issue, send email).

Sync runs are idempotent: each run returns a `checkpoint` (cursor, timestamp, ID set) that the next run reads back via `ctx.checkpoint`.

## Install

```bash
bun add @lobu/connector-sdk
# or
npm install @lobu/connector-sdk
# or
pnpm add @lobu/connector-sdk
```

The package is published from this repo and tracks the same release line as `@lobu/cli` and the gateway.

## Minimal connector

A complete, working connector — fetches a list of form submissions from a small JSON endpoint, dedupes by ID, and emits one event per new submission:

```ts
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class FunnelFormConnector extends ConnectorRuntime {
  readonly definition = {
    key: "funnel-form",
    name: "Funnel form",
    version: "1.0.0",
    authSchema: { methods: [{ type: "none" as const }] },
    feeds: { submissions: { key: "submissions", name: "Form submissions" } },
  };

  async sync(ctx: SyncContext) {
    const seen = new Set<string>((ctx.checkpoint as any)?.seen_ids ?? []);
    const subs: any[] =
      (await (await fetch(String(ctx.config.endpoint))).json()).submissions ?? [];
    const fresh = subs.filter((s) => s?.id && !seen.has(s.id));

    return {
      events: fresh.map((s) => ({
        origin_id: s.id,
        origin_type: "form_submission",
        title: s.company ? `Demo — ${s.company}` : `Demo — ${s.email}`,
        payload_text: s.message ?? "",
        author_name: s.name,
        occurred_at: s.submitted_at ? new Date(s.submitted_at) : new Date(),
        metadata: { company: s.company, email: s.email },
      })),
      checkpoint: { seen_ids: [...seen, ...fresh.map((s) => s.id)].slice(-1000) },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
```

Drop this file at `connectors/funnel-form.connector.ts` in your Lobu project. `lobu apply` ships the source to the gateway, which compiles and registers it; from there each `feeds.<key>` entry shows up as something a user can create a connection for in the admin UI.

## Concepts

### `ConnectorDefinition`

The static metadata for your connector. Filed under `connector_definitions` in the gateway DB after `lobu apply`.

| Field | Required | Description |
|------|----------|-------------|
| `key` | yes | Unique global key, e.g. `google.gmail`, `funnel-form` |
| `name` | yes | Human-readable label |
| `version` | yes | Semver — bump to invalidate per-feed checkpoints if the event shape changes |
| `authSchema` | no | How users authenticate this connector (see below) |
| `feeds` | no | Map of feed key → `FeedDefinition` (a connector typically has one or more feeds) |
| `actions` | no | Map of action key → `ActionDefinition` (only needed if you also implement `execute`) |
| `requiredCapability` | no | When set, only worker pods/devices advertising this capability serve runs (e.g. `screentime` for the Mac app) |
| `runtime` | no | Pin to a device platform (iOS, macOS, …) — omit for cloud-side connectors |

See the full type at [`reference/connector-sdk` › ConnectorDefinition](/reference/connector-sdk/#connectordefinition).

### `SyncContext`

What `sync()` receives. Every field is read-only.

| Field | Description |
|------|-------------|
| `feedKey` | Which feed Lobu is asking you to run |
| `config` | The connection-level config the user filled in (typed by your `FeedDefinition.configSchema`) |
| `checkpoint` | The last successful run's checkpoint, or `null` on the first run |
| `credentials` | OAuth tokens for `oauth` auth, `null` otherwise |
| `entityIds` | Entities this feed is linked to (rarely needed; useful for scoping the sync) |
| `sessionState` | Browser cookies / tokens captured by `lobu memory browser-auth` for `browser` auth |
| `emitEvents(events)` | Optional streaming hook — flush a chunk before the run ends |
| `updateCheckpoint(cp)` | Optional progress-checkpoint hook for long-running syncs |

### `EventEnvelope`

The shape of one event in the stream. Each envelope becomes a row in the `events` table.

```ts
interface EventEnvelope {
  origin_id: string;          // platform's unique ID for this item
  origin_type?: string;       // source-native type (post, message, charge)
  payload_text: string;       // main content
  payload_type?: "text" | "markdown" | "json_template" | "media" | "empty";
  title?: string;
  author_name?: string;
  source_url?: string;        // permalink back to the original
  occurred_at: Date;          // when the event actually happened
  semantic_type?: string;     // content, note, summary, fact, etc.
  score?: number;             // 0-100 engagement / relevance
  metadata?: Record<string, unknown>;
}
```

Only `origin_id`, `payload_text`, and `occurred_at` are required. The full surface is documented in [`reference/connector-sdk` › EventEnvelope](/reference/connector-sdk/#eventenvelope).

### `SyncResult`

```ts
interface SyncResult {
  events: EventEnvelope[];
  checkpoint: Record<string, unknown> | null;
  auth_update?: Record<string, unknown> | null; // for browser cookie rotation
  metadata?: { items_found?: number; items_skipped?: number; [k: string]: unknown };
}
```

Return `events: []` plus the same `checkpoint` you received on a no-new-data tick — runs stay idempotent.

### `ActionContext` / `ActionResult`

If your connector also writes back (e.g. `assign_issue`, `send_email`), declare an `actions` map on the definition and implement `execute(ctx)`:

```ts
async execute(ctx: ActionContext): Promise<ActionResult> {
  if (ctx.actionKey === "assign_issue") {
    const { issueId, assignee } = ctx.input as { issueId: string; assignee: string };
    await fetch(`https://api.example.com/issues/${issueId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ctx.credentials?.accessToken}` },
      body: JSON.stringify({ assignee }),
    });
    return { success: true, output: { issueId, assignee } };
  }
  return { success: false, error: `unknown action ${ctx.actionKey}` };
}
```

Each `ActionDefinition` declares `requiresApproval: true | false` plus MCP-style `annotations` (`destructiveHint`, `idempotentHint`). The gateway routes high-risk actions through the approval queue before the worker runs them.

## Auth models

Declare on `definition.authSchema`. A connector can list multiple methods; the gateway lets the user pick.

| `type` | Use when |
|--------|----------|
| `none` | Public endpoint, no credentials needed |
| `env_keys` | Static API keys (Stripe secret key, PAT) — fields rendered as form inputs, stored encrypted |
| `oauth` | Standard OAuth 2.0 — Lobu handles the dance, refresh, and per-user token isolation |
| `browser` | Session cookies captured via `lobu memory browser-auth` from a logged-in Chrome profile (or CDP) |
| `interactive` | Custom auth flow (QR pairing, OTP, signed device handshake) — implement `authenticate(ctx)` and stream `AuthArtifact`s |

Workers never see the raw secret on the wire: the gateway's `secret-proxy` swaps `lobu_secret_<uuid>` placeholders for real values at egress, so `ctx.credentials.accessToken` looks like a normal string from your code, but it's only resolved when the outbound request leaves the proxy.

Full breakdown at [`reference/connector-sdk` › ConnectorAuthSchema](/reference/connector-sdk/#connectorauthschema).

## Checkpoints

The checkpoint is your bookmark. It's persisted on the `feeds` row after every successful sync and handed back as `ctx.checkpoint` on the next run. Three common shapes:

```ts
// Timestamp cursor (Stripe, GitHub):
checkpoint: { last_created: data.at(-1)?.created ?? cursor }

// Page token (Google APIs):
checkpoint: { next_page_token: resp.nextPageToken ?? null }

// Bounded ID set (idempotency, no native cursor):
checkpoint: { seen_ids: [...seen, ...fresh.map((s) => s.id)].slice(-1000) }
```

Rules of thumb:

- **Always return a checkpoint**, even on the no-new-data case — return the previous one verbatim. Returning `null` tells the gateway to treat the next run as a fresh start.
- **Cap unbounded structures** (ID sets, in-flight queues) before persisting. The example above keeps the last 1000 IDs — enough to dedupe across a sync window without bloating the row.
- **Long-running syncs** can call `ctx.updateCheckpoint(...)` mid-flight so a crash doesn't lose progress.

## Where the file lives

In your Lobu project, drop `*.connector.ts` files under `connectors/`:

```
my-agent/
├── lobu.toml
├── connectors/
│   ├── funnel-form.connector.ts
│   └── stripe-charges.connector.ts
└── agents/my-agent/...
```

`lobu apply` discovers, type-checks, and ships them. Update the `version` field whenever the event shape changes so the gateway forces a fresh checkpoint.

## Real-world examples

- [`examples/lobu-crm/connectors/funnel-form.connector.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/lobu-crm/connectors/funnel-form.connector.ts) — small custom HTTP API, ID-set dedupe.
- [`examples/ecommerce/connectors/stripe-charges.connector.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/ecommerce/connectors/stripe-charges.connector.ts) — REST API, `env_keys` auth, timestamp checkpoint.

## See also

- [Reaction SDK](/getting-started/reaction-sdk/) — code that runs after watchers extract data.
- [`@lobu/connector-sdk` API reference](/reference/connector-sdk/) — every exported symbol with types.
- [Memory](/getting-started/memory/) — how connector events become durable entity memory.
