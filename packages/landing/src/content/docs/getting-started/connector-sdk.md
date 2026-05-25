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

## A typed connector, end to end

The example below pulls issues from a GitHub repository, polls incrementally with a typed checkpoint, and emits one `EventEnvelope` per issue. Every field has a real type — no `as any` casts, no `// biome-ignore` directives.

```ts
import {
  ConnectorRuntime,
  type ConnectorDefinition,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// User-supplied connection config (rendered as a form in the admin UI).
interface GitHubConfig {
  owner: string;
  repo: string;
}

// The shape we persist between runs. Cursor-based pagination so re-runs
// only fetch issues updated after the last successful sync.
interface GitHubCheckpoint {
  last_updated_at: string | null;
}

// Minimal subset of the GitHub REST API issue payload we actually read.
interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  user: { login: string } | null;
}

// Tiny typed helper so we never reach into `ctx.checkpoint` raw.
function readCheckpoint(raw: SyncContext["checkpoint"]): GitHubCheckpoint {
  const cp = (raw ?? {}) as Partial<GitHubCheckpoint>;
  return { last_updated_at: cp.last_updated_at ?? null };
}

export default class GitHubIssuesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "github-issues",
    name: "GitHub issues",
    version: "1.0.0",
    // Personal access token is collected once per connection and stored
    // encrypted; the worker only ever sees a `lobu_secret_<uuid>` placeholder.
    authSchema: {
      methods: [
        {
          type: "env_keys",
          fields: [
            { key: "token", label: "GitHub PAT", secret: true, required: true },
          ],
        },
      ],
    },
    feeds: {
      issues: { key: "issues", name: "Issues" },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    // For `env_keys` auth, the values land in `ctx.config` keyed by the
    // `key` you declared on the auth field. OAuth tokens (for `oauth` auth)
    // arrive on `ctx.credentials.accessToken` instead.
    const config = ctx.config as unknown as GitHubConfig & { token?: string };
    const checkpoint = readCheckpoint(ctx.checkpoint);
    const token = config.token ?? "";

    // GitHub returns issues updated *at or after* `since`; we want
    // strictly after, so we filter by id below.
    const since = checkpoint.last_updated_at ?? "1970-01-01T00:00:00Z";
    const url =
      `https://api.github.com/repos/${config.owner}/${config.repo}/issues` +
      `?state=all&sort=updated&direction=asc&per_page=100&since=${since}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${response.status}: ${await response.text()}`);
    }

    const issues = (await response.json()) as GitHubIssue[];
    const fresh = issues.filter((i) => i.updated_at !== checkpoint.last_updated_at);

    const events: EventEnvelope[] = fresh.map((issue) => ({
      origin_id: String(issue.id),
      origin_type: "issue",
      title: `#${issue.number} ${issue.title}`,
      payload_text: issue.body ?? "",
      source_url: issue.html_url,
      author_name: issue.user?.login,
      occurred_at: new Date(issue.updated_at),
    }));

    return {
      events,
      // Always advance the checkpoint to the newest `updated_at` we saw.
      // If the page was empty, return the previous value verbatim so the
      // next run is still idempotent.
      checkpoint: {
        last_updated_at:
          fresh.at(-1)?.updated_at ?? checkpoint.last_updated_at,
      } satisfies GitHubCheckpoint,
    };
  }

  async execute(): Promise<{ success: false; error: string }> {
    return { success: false, error: "github-issues is read-only" };
  }
}
```

A few things to notice:

- **`SyncContext["checkpoint"]` is `Record<string, unknown> | null`.** Wrap it once in a tiny typed reader (`readCheckpoint`) instead of casting at every call site.
- **`env_keys` credentials live on `ctx.config`, not `ctx.credentials`.** Lobu merges the values the user filled into the `env_keys` form into `ctx.config` under the keys you declared (`token` here). `ctx.credentials` is reserved for `oauth` auth — `accessToken`, `refreshToken`, `scope`, `expiresAt`.
- **The PAT is a `lobu_secret_<uuid>` placeholder at runtime.** The gateway's secret proxy swaps it for the real value when the outbound HTTPS request leaves the worker, so the secret never lives in the worker's memory.
- **Pagination via the `since` query param.** The GitHub `Link` header is the alternative for cursor-style paging when you need to walk a stable, ordered list; `since` is simpler when the source already gives you a monotonic timestamp.

Save this file in your Lobu project (e.g. `github-issues.connector.ts` next to `lobu.config.ts`) and list it in your config:

```ts
import { connectorFromFile, defineConfig } from "@lobu/cli/config";

export default defineConfig({
  connectors: [connectorFromFile("./github-issues.connector.ts")],
  // ...agents, connections, etc.
});
```

`lobu apply` ships the source to the gateway, which compiles and registers it; from there each `feeds.<key>` entry shows up as something a user can create a connection for in the admin UI.

## Concepts

### `ConnectorDefinition`

The static metadata for your connector. Filed under `connector_definitions` in the gateway DB after `lobu apply`.

| Field | Required | Description |
|------|----------|-------------|
| `key` | yes | Unique global key, e.g. `google.gmail`, `github-issues` |
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
| `credentials` | OAuth tokens (`accessToken`, `refreshToken`, …) for `oauth` auth; `null` for everything else. `env_keys` values land on `ctx.config` under the declared `key`. |
| `entityIds` | Entities this feed is linked to (rarely needed; useful for scoping the sync) |
| `sessionState` | Browser cookies / tokens captured by `lobu memory browser-auth` for `browser` auth |
| `emitEvents(events)` | Optional streaming hook — flush a chunk before the run ends |
| `updateCheckpoint(cp)` | Optional progress-checkpoint hook for long-running syncs |

`SyncContext` does not currently expose generics for `config` / `checkpoint`. Declare your own interfaces and convert at the boundary, as the example above does with `readCheckpoint`.

### `EventEnvelope`

The shape of one event in the stream. Each envelope becomes a row in the `events` table.

```ts
interface EventEnvelope {
  origin_id: string; // platform's unique ID for this item
  origin_type?: string; // source-native type (post, message, charge)
  payload_text: string; // main content
  payload_type?: "text" | "markdown" | "json_template" | "media" | "empty";
  title?: string;
  author_name?: string;
  source_url?: string; // permalink back to the original
  occurred_at: Date; // when the event actually happened
  semantic_type?: string; // content, note, summary, fact, etc.
  score?: number; // 0-100 engagement / relevance
  metadata?: Record<string, unknown>;
}
```

Only `origin_id`, `payload_text`, and `occurred_at` are required. The full surface is documented in [`reference/connector-sdk` › EventEnvelope](/reference/connector-sdk/#eventenvelope).

### `SyncResult`

```ts
interface SyncResult {
  events: EventEnvelope[];
  checkpoint: Record<string, unknown> | null;
  auth_update?: Record<string, unknown> | null;
  metadata?: {
    items_found?: number;
    items_skipped?: number;
    [key: string]: unknown;
  };
}
```

Return `events: []` plus the same `checkpoint` you received on a no-new-data tick — runs stay idempotent.

### `ActionContext` / `ActionResult`

If your connector also writes back (e.g. `assign_issue`, `send_email`), declare an `actions` map on the definition and implement `execute(ctx)`:

```ts
import type { ActionContext, ActionResult } from "@lobu/connector-sdk";

interface AssignIssueInput {
  issueId: string;
  assignee: string;
}

async execute(ctx: ActionContext): Promise<ActionResult> {
  if (ctx.actionKey !== "assign_issue") {
    return { success: false, error: `unknown action ${ctx.actionKey}` };
  }
  const { issueId, assignee } = ctx.input as unknown as AssignIssueInput;
  // Same `env_keys` field as sync() — execute()'s ctx.config carries it too.
  const token = String((ctx.config as { token?: string }).token ?? "");

  await fetch(`https://api.example.com/issues/${issueId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assignee }),
  });
  return { success: true, output: { issueId, assignee } };
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

Workers never see the raw secret on the wire: the gateway's `secret-proxy` swaps `lobu_secret_<uuid>` placeholders for real values at egress, so the string you pull from `ctx.config.<field>` (env_keys) or `ctx.credentials.accessToken` (oauth) looks like a normal token from your code, but it's only resolved when the outbound request leaves the proxy.

Full breakdown at [`reference/connector-sdk` › ConnectorAuthSchema](/reference/connector-sdk/#connectorauthschema).

## Checkpoints

The checkpoint is your bookmark. It's persisted on the `feeds` row after every successful sync and handed back as `ctx.checkpoint` on the next run. Three common shapes:

```ts
// Timestamp cursor (GitHub `since`, Stripe `created[gt]`):
interface TimestampCheckpoint {
  last_updated_at: string | null;
}

// Page token (Google APIs):
interface PageTokenCheckpoint {
  next_page_token: string | null;
}

// Bounded ID set (idempotency, no native cursor):
interface IdSetCheckpoint {
  seen_ids: string[];
}
```

Rules of thumb:

- **Always return a checkpoint**, even on the no-new-data case — return the previous one verbatim. Returning `null` tells the gateway to treat the next run as a fresh start.
- **Cap unbounded structures** (ID sets, in-flight queues) before persisting. Keep the last 1000 IDs — enough to dedupe across a sync window without bloating the row.
- **Long-running syncs** can call `ctx.updateCheckpoint(...)` mid-flight so a crash doesn't lose progress.

## Where the file lives

A `*.connector.ts` file can live anywhere in your Lobu project; reference each one explicitly with `connectorFromFile` in `defineConfig({ connectors })`:

```
my-agent/
├── lobu.config.ts          # connectors: [connectorFromFile("./github-issues.connector.ts")]
├── github-issues.connector.ts
├── stripe-charges.connector.ts
└── agents/my-agent/...
```

`lobu apply` type-checks and ships only the listed connectors (there is no `./connectors` auto-discovery). Update the `version` field whenever the event shape changes so the gateway forces a fresh checkpoint.

## Dependencies

A connector can pull in two kinds of dependency, and they are provisioned differently.

**npm packages are bundled at compile time.** Add them to the `package.json` next to your `lobu.config.ts` and import them normally:

```ts
import { parse } from "csv-parse/sync";
```

`lobu apply` runs `bun install --ignore-scripts` in the project, then esbuild bundles each connector with the project's `node_modules` and uploads the artifact. The server only ever receives the bundle, so npm deps ship inside it. `--ignore-scripts` keeps install-time supply-chain surface off your machine, which is also why packages that need native build steps do not belong here.

**Native tools are provisioned at run time via nix.** Declare them as nixpkgs attribute refs in `runtime.nix.packages` on the connector definition:

```ts
export default class VideoConnector extends ConnectorRuntime {
  definition: ConnectorDefinition = {
    key: "media.video",
    name: "Video",
    version: "1.0.0",
    runtime: {
      platforms: ["linux", "macos"],
      nix: { packages: ["ffmpeg", "imagemagick"] },
    },
    // ...feeds, actions
  };
  // ...sync / execute can now shell out to ffmpeg
}
```

At execution the runtime wraps the connector's subprocess in `nix-shell -p <packages>` so the declared tools are on `PATH`. Backends that cannot run native deps reject a connector that declares them, and a host without `nix-shell` errors with a clear message rather than failing mid-run.

The rule of thumb: **npm is bundled (compile-time), native is nix (run-time).** Never put a native tool in `package.json` expecting it to ship, and never list an npm package in `runtime.nix.packages`. See the [`ConnectorRuntimeInfo` reference](/reference/connector-sdk/#connectorruntimeinfo) for the field shape.

## See it in production

- [`examples/ecommerce/stripe-charges.connector.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/ecommerce/stripe-charges.connector.ts) — REST API, `env_keys` auth, timestamp checkpoint.
- [`examples/lobu-crm/funnel-form.connector.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/lobu-crm/funnel-form.connector.ts) — small custom HTTP API, ID-set dedupe.

## See also

- [Reactions](/getting-started/reaction-sdk/) — the typed hook (part of this same package) for code that runs after watchers extract data.
- [`@lobu/connector-sdk` API reference](/reference/connector-sdk/) — every exported symbol with types.
- [Memory](/getting-started/memory/) — how connector events become durable entity memory.
