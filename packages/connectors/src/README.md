# Connector SDK

Connectors are TypeScript modules that sync data from external services into Lobu and optionally execute write-back actions. Each connector is a single `.ts` file that exports a class extending `ConnectorRuntime` from `@lobu/connector-sdk`.

## Quick Start

```typescript
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
  type EventEnvelope,
} from '@lobu/connector-sdk';

export default class MyConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'my_connector',
    name: 'My Connector',
    description: 'Fetches data from My Service.',
    version: '1.0.0',
    faviconDomain: 'example.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      items: {
        key: 'items',
        name: 'Items',
        description: 'Sync items from the service.',
        configSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
        },
        eventKinds: {
          item: {
            description: 'An item from the service',
            metadataSchema: {
              type: 'object',
              properties: {
                score: { type: 'number' },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const query = ctx.config.query as string;
    // Fetch data, transform to events...
    const events: EventEnvelope[] = [];

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() },
      metadata: { items_found: events.length },
    };
  }
}
```

## Connector Definition

The `definition` property declares everything about your connector: metadata, auth requirements, available feeds, actions, and configuration schemas.

```typescript
interface ConnectorDefinition {
  key: string;                              // Unique identifier (e.g. 'github', 'rss')
  name: string;                             // Display name
  description?: string;                     // What this connector does
  version: string;                          // Semver
  faviconDomain?: string;                   // Domain for favicon lookup (e.g. 'github.com')
  authSchema?: ConnectorAuthSchema;         // Authentication configuration
  feeds?: Record<string, FeedDefinition>;   // Data sources (keyed by feed_key)
  actions?: Record<string, ActionDefinition>; // Write-back actions
  optionsSchema?: Record<string, unknown>;  // Global connector options (JSON Schema)
  mcpConfig?: { upstreamUrl: string };      // Proxy an upstream MCP server
  openapiConfig?: {                         // Generate actions from an OpenAPI spec
    specUrl: string;
    includeOperations?: string[];
    excludeOperations?: string[];
    includeTags?: string[];
    serverUrl?: string;
  };
}
```

### MCP Config

Set `mcpConfig` to proxy an upstream MCP server through Lobu. The connector acts as a bridge, exposing the MCP server's tools as connector actions. Useful for wrapping existing MCP servers with Lobu's auth, approval, and audit trail.

### OpenAPI Config

Set `openapiConfig` to auto-generate connector actions from an OpenAPI specification. The platform fetches the spec, filters operations by `includeOperations`/`excludeOperations`/`includeTags`, and exposes them as actions. Useful for REST APIs that already have OpenAPI docs.

## Authentication

The `authSchema.methods` array declares which auth methods your connector supports. Users configure credentials via auth profiles in the UI. A connector can support multiple methods (e.g. OAuth primary + env_keys fallback).

### `none` - No authentication

```typescript
authSchema: { methods: [{ type: 'none' }] }
```

### `env_keys` - API keys / tokens

```typescript
authSchema: {
  methods: [{
    type: 'env_keys',
    required: true,
    scope: 'connection',         // 'connection' (default) or 'organization'
    description: 'API key for authentication.',
    fields: [
      {
        key: 'API_KEY',          // Key name, accessed via ctx.credentials
        label: 'API Key',        // UI label
        description: 'Your service API key',
        example: 'sk-...',       // Placeholder hint
        secret: true,            // Mask in UI
        required: true,          // Whether this field is required
      },
    ],
  }],
}
```

When `scope` is `'organization'`, the auth profile is shared across all connections in the org. Default is `'connection'` (per-connection credentials).

### `oauth` - OAuth providers

```typescript
authSchema: {
  methods: [{
    type: 'oauth',
    provider: 'github',           // Built-in: github | google | reddit
    requiredScopes: ['repo', 'read:user'],
    required: false,              // Whether OAuth is mandatory or optional
    scope: 'connection',          // 'connection' or 'organization'
    description: 'Enables private repo access.',
    setupInstructions: 'Create an OAuth App at ... Set callback URL to {{redirect_uri}}.',
    // For custom OAuth providers (not built-in):
    authorizationUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientIdKey: 'EXAMPLE_CLIENT_ID',       // Env key for client ID
    clientSecretKey: 'EXAMPLE_CLIENT_SECRET', // Env key for client secret
  }],
}
```

The OAuth token is available at `ctx.credentials?.accessToken`. The full credentials shape:

```typescript
interface SyncCredentials {
  provider: string;              // e.g. 'github'
  accessToken: string;           // The OAuth access token
  refreshToken?: string | null;  // For token refresh
  expiresAt?: string | null;     // Token expiration (ISO string)
  scope?: string | null;         // Granted scopes
}
```

### `browser` - Browser session (cookies/CDP)

For connectors that scrape authenticated pages:

```typescript
authSchema: {
  methods: [{
    type: 'browser',
    capture: 'cli',             // How auth is captured:
                                //   'cli'  - `lobu memory browser-auth` launches a dedicated Chrome
                                //           with CDP enabled; user signs in once; the connector
                                //           attaches over CDP at sync time (cdp_url stored on the
                                //           auth profile).
                                //   'cdp'  - Connect to a Chrome the user is already running with
                                //           --remote-debugging-port=9222 (no dedicated profile).
    requiredDomains: [           // Domains the connector needs an authenticated session on. Used
      'x.com',                   // to verify the live Chrome session via the `--check` flow.
      '.x.com',
    ],
    defaultCdpUrl: 'auto',       // CDP URL (for 'cdp' capture). 'auto' detects local Chrome.
    description: 'Connect to Chrome for authenticated scraping.',
  }],
}
```

Use `'cdp'` for services like Google that block headless browsers — it connects to the user's already-running Chrome session. Use `'cli'` for sites where attaching to a dedicated, user-signed-in Chrome (per auth profile) is acceptable.

## Feeds

Feeds define the data sources your connector can sync. Each feed has:

```typescript
interface FeedDefinition {
  key: string;                    // Unique identifier within the connector
  name: string;                   // Display name
  description?: string;           // What this feed syncs
  displayNameTemplate?: string;   // Template using config values: "{repo_owner}/{repo_name} issues"
  configSchema?: object;          // JSON Schema for feed-specific configuration
  eventKinds?: Record<string, {   // Event types this feed produces
    description?: string;
    metadataSchema?: object;      // JSON Schema for event metadata
  }>;
}
```

The feed key is passed to `sync()` as `ctx.feedKey`, so a single connector can handle multiple feed types by switching on `ctx.feedKey`.

## Syncing Data

The `sync()` method is called by the worker on a schedule. It receives a `SyncContext` and returns a `SyncResult`.

### SyncContext

```typescript
interface SyncContext {
  feedKey: string;                          // Which feed to sync
  config: Record<string, unknown>;          // Feed + connector config merged
  checkpoint: Record<string, unknown> | null; // Previous checkpoint (null on first sync)
  credentials: SyncCredentials | null;      // OAuth token, env keys, etc.
  entityIds: number[];                      // Linked entity IDs
  sessionState?: Record<string, unknown>;   // Browser session state (cookies, tokens)
  emitEvents?: (events: EventEnvelope[]) => Promise<void>;      // Stream events mid-sync
  updateCheckpoint?: (cp: Record<string, unknown>) => Promise<void>; // Save progress mid-sync
}
```

### SyncResult

```typescript
interface SyncResult {
  events: EventEnvelope[];                  // Events to ingest
  checkpoint: Record<string, unknown> | null; // Updated checkpoint to persist
  auth_update?: Record<string, unknown>;    // Updated session state (browser cookies, etc.)
  metadata?: {
    items_found?: number;
    items_skipped?: number;
    [key: string]: unknown;
  };
}
```

### EventEnvelope

Each piece of content is an `EventEnvelope`:

```typescript
interface EventEnvelope {
  origin_id: string;           // Unique ID from the source platform
  origin_type?: string;        // Source-native type (must match a key in eventKinds)
  payload_text: string;        // Main text content
  title?: string;              // Title / subject
  author_name?: string;        // Author
  source_url?: string;         // Link to original
  occurred_at: Date;           // When the content was created
  semantic_type?: string;      // Semantic type (e.g. 'content', 'note', 'summary', 'fact')
  score?: number;              // Engagement score (0-100)
  origin_parent_id?: string;   // Parent reference for threaded content
  metadata?: Record<string, unknown>; // Matches the eventKind's metadataSchema
  embedding?: number[];        // Pre-computed embedding vector (optional)
}
```

### Checkpointing

Use checkpoints to implement incremental sync. Common patterns:

- **Timestamp-based**: Store `last_sync_at` and use it as a `since` filter on the next sync (see `github.ts`)
- **ID-based**: Store a list of seen IDs for deduplication, trimmed to a max size to prevent unbounded growth (see `rss.ts`)

For long-running syncs, use `ctx.emitEvents()` to stream event batches to the platform as they're collected, and `ctx.updateCheckpoint()` to persist progress. If the sync crashes mid-way, the next run resumes from the last saved checkpoint.

## Actions

Actions let connectors write back to external services (e.g. create a GitHub issue). Define them in `definition.actions`:

```typescript
interface ActionDefinition {
  key: string;                    // Unique identifier
  name: string;                   // Display name
  description?: string;           // What this action does
  requiresApproval: boolean;      // Whether user must approve before execution
  inputSchema?: object;           // JSON Schema for action input
  outputSchema?: object;          // JSON Schema for action output
  annotations?: {                 // MCP tool annotations for client-side UX
    destructiveHint?: boolean;    // Action deletes or modifies data irreversibly
    openWorldHint?: boolean;      // Action interacts with external systems
    idempotentHint?: boolean;     // Safe to retry without side effects
  };
}
```

Example:

```typescript
actions: {
  create_issue: {
    key: 'create_issue',
    name: 'Create Issue',
    description: 'Create a new issue in the repository.',
    requiresApproval: true,
    annotations: {
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        issue_number: { type: 'integer' },
        url: { type: 'string' },
      },
    },
  },
}
```

Handle actions in `execute()`:

```typescript
async execute(ctx: ActionContext): Promise<ActionResult> {
  // ctx.actionKey  - which action to run
  // ctx.input      - validated input matching inputSchema
  // ctx.credentials - auth tokens (SyncCredentials | null)
  // ctx.config     - connector config

  switch (ctx.actionKey) {
    case 'create_issue':
      const result = await createIssue(ctx.input.title, ctx.input.body);
      return { success: true, output: { issue_number: result.number, url: result.url } };
    default:
      return { success: false, error: `Unknown action: ${ctx.actionKey}` };
  }
}
```

If your connector doesn't support actions, do nothing — the base
`ConnectorRuntime` class ships a default `execute()` that returns
`{ success: false, error: 'Actions not supported' }`. Omit the method
entirely.

## Options Schema

The `optionsSchema` defines global connector-level configuration (JSON Schema) that applies across all feeds. This is typically a superset of the common fields shared across feeds. It powers the connection setup UI — when a user creates a new connection, they fill out a form generated from this schema.

## Engagement Scoring

The SDK exports `calculateEngagementScore()` for normalizing platform-specific engagement metrics to a 0-100 score:

```typescript
import { calculateEngagementScore } from '@lobu/connector-sdk';

const score = calculateEngagementScore('reddit', {
  score: 1500,       // Reddit karma (upvotes - downvotes)
  upvotes: 1600,
  downvotes: 100,
  reply_count: 42,
});
// => 15 (capped at 100)

const score2 = calculateEngagementScore('trustpilot', {
  rating: 4,         // Star rating (1-5)
  helpful_count: 10, // Helpful votes
});
// => 45 (rating * 10 + helpful * 0.5)
```

Signature:

```typescript
function calculateEngagementScore(
  connectorKey: string,
  engagementData: {
    score?: number;
    upvotes?: number;
    downvotes?: number;
    rating?: number;
    helpful_count?: number;
    reply_count?: number;
  }
): number; // 0-100
```

Platform-specific logic:
- **reddit**: `min(max(score, 0), 10000) / 100`
- **Rating-based** (reviews): `rating * 10 + helpful_count * 0.5`, capped at 100
- **Score-based** (default): `min(score, 100)`

## Browser-Based Connectors

For headless public scraping, use `@lobu/connector-sdk` (`launchBrowser`, `runReviewScrape`,
`validateUrlDomain`, `validatePublicUrl`). Bundled connectors import timing/checkpoint helpers
from `./scraper-utils.ts` (re-exports from the SDK).

Review-site scrapers (Trustpilot, G2, etc.) live in `examples/brand-intelligence/` — they are
not bundled because scraping may violate third-party terms of service.

```typescript
import { launchBrowser, runReviewScrape } from '@lobu/connector-sdk';

async sync(ctx: SyncContext): Promise<SyncResult> {
  return runReviewScrape(ctx, {
    connectorKey: 'my-connector-sync',
    baseUrl: 'https://www.example.com/reviews',
    expectedDomain: 'example.com',
    cookieConsentSelector: '[data-cookie-consent-accept]',
    reviewCardSelector: '[data-review-card]',
    gotoTimeoutMs: 30000,
    extract: async (page, cardsFound) => ({ /* ... */ }),
  });
}
```

For user-session scraping (logged-in sites), use the Chrome extension bridge
(`extensionDomScrape` / `extensionNetworkSync`) instead of headless Playwright.

### Browser packages

Browser connectors use `patchright` (an npm alias for Playwright). The SDK exports
`launchBrowser()` and `captureErrorArtifacts()` for lower-level control.

## Worker Sandbox Environment

Connector code runs in a worker subprocess with a restricted environment. Key things to know:

- **Minimal env vars**: Only `PATH`, `HOME`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, and `PLAYWRIGHT_BROWSERS_PATH` are available. No access to the host's env vars.
- **Secrets via ctx**: API keys and tokens flow through `ctx.credentials` and `ctx.config`, not environment variables. The `env_keys` auth method stores secrets on auth profiles, and the platform injects them into `ctx.config` at sync time.
- **No filesystem persistence**: Don't write to disk expecting it to survive between syncs. Use `checkpoint` for state.

## npm Dependencies

You can import npm packages inline using the `npm:` protocol:

```typescript
import TurndownService from 'turndown';
```

Always pin the version to avoid unexpected breakage.

## Build & Installation

### Generating the catalog

```bash
npx tsx scripts/generate-connector-catalog.ts
```

This compiles each `.ts` file in this directory via esbuild, extracts the `definition` metadata, and writes `connectors/catalog.json`. The catalog is a metadata-only index — it does not contain compiled code.

### Auto-install per org

Connectors are **not** pre-installed globally. When an org first uses a connector, `ensureConnectorInstalled()` checks if the org already has it. If not, it:

1. Reads the `.ts` source from `connectors/` on disk
2. Compiles it temporarily via esbuild to extract metadata (key, name, feeds, etc.)
3. Stores the metadata in `connector_definitions` scoped to that org
4. Stores a `source_path` reference (e.g. `github.ts`) in `connector_versions` — **compiled code is NOT stored**

Connectors can also be installed manually via `client.connections.installConnector(...)` from inside an `execute` script (or the equivalent admin REST endpoint), passing a `source_url` or inline `source_code`. Manual installs store compiled code in the database as before.

### How connector code runs

1. For fleet workers and embedded-mode hosts (worker + gateway share a host), the gateway sends only `connector_key` in the worker-poll response — both pods have the `.ts` source on disk, and the worker compiles locally via the shared pipeline at `@lobu/connector-worker/compile`. For DB-only / device workers without source on disk, the gateway sends `compiled_code` inline.
2. The compiled bundle is written to a temp file (`.connector-child-{pid}-{rand}.mjs`) under cwd and loaded via dynamic `import()` inside a forked child process.
3. The parent and child speak `ExecutorJob` / `ExecutorResult` over IPC — the same V1 SDK shapes (`SyncContext` / `ActionContext` / `AuthContext` in, `SyncResult` / `ActionResult` / `AuthResult` out, no envelope). Sync events stream via `event_chunk` IPC messages as the connector emits them.
4. Each sync/action runs in an **isolated child process** with a 10-minute timeout and 512MB memory limit.
5. The child process has a restricted environment — only `PATH`, `HOME`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, and `PLAYWRIGHT_BROWSERS_PATH` are available as env vars.
6. Secrets flow through `ctx.credentials` and `ctx.config`, not environment variables.

This means edits to `.ts` files in `connectors/` take effect on the next sync without reinstalling.

## Existing Connectors

| Connector | Auth | Feeds | Actions |
|-----------|------|-------|---------|
| `github` | oauth/env_keys | issues, PRs, comments, discussions | create/close/reopen issues, PRs |
| `hackernews` | none | stories, comments | - |
| `producthunt` | env_keys | posts & comments | - |
| `reddit` | oauth/none | posts, comments | - |
| `rss` | none | articles | - |
| `x` | browser (CLI) | tweets | - |
| `youtube` | oauth (Google) | liked videos, playlists, keyword search (sync) | search, get_video, search_liked_videos, list_playlists, get_playlist |
