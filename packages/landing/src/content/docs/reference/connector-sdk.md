---
title: "@lobu/connector-sdk"
description: Type reference for the Connector SDK — ConnectorRuntime, ConnectorDefinition, EventEnvelope, and the sync/action/auth surface.
sidebar:
  order: 5
---

API reference for [`@lobu/connector-sdk`](https://www.npmjs.com/package/@lobu/connector-sdk). For a tutorial-style introduction see the [Connector SDK guide](/getting-started/connector-sdk/); for the reactions surface (also exported from this package) see the [Reactions reference](/reference/reaction-sdk/).

Every symbol below is a re-export from the package's top-level entry point:

```ts
import {
  ConnectorRuntime,
  type ConnectorDefinition,
  type SyncContext,
  type SyncResult,
  type EventEnvelope,
  type ActionContext,
  type ActionResult,
} from "@lobu/connector-sdk";
```

---

## `ConnectorRuntime`

Abstract base class. Every connector extends it.

```ts
abstract class ConnectorRuntime {
  abstract readonly definition: ConnectorDefinition;
  abstract sync(ctx: SyncContext): Promise<SyncResult>;
  abstract execute(ctx: ActionContext): Promise<ActionResult>;
  authenticate(ctx: AuthContext): Promise<AuthResult>; // default throws
}
```

| Member | Required | Description |
|--------|----------|-------------|
| `definition` | yes | Static metadata: key, name, version, auth, feeds, actions. See [`ConnectorDefinition`](#connectordefinition). |
| `sync(ctx)` | yes | Pull data. Receives last checkpoint, returns events + new checkpoint. |
| `execute(ctx)` | yes | Run an action. Stub it with `{ success: false, error: "no actions" }` for read-only connectors. |
| `authenticate(ctx)` | no | Only required when `authSchema.methods` includes `{ type: "interactive" }`. Stream `AuthArtifact`s, await UI signals. |

---

## `ConnectorDefinition`

```ts
interface ConnectorDefinition {
  key: string;                                   // 'google.gmail'
  name: string;
  description?: string;
  version: string;                               // semver
  authSchema?: ConnectorAuthSchema;
  feeds?: Record<string, FeedDefinition>;
  actions?: Record<string, ActionDefinition>;
  optionsSchema?: Record<string, unknown>;       // JSON Schema for global options
  faviconDomain?: string;                        // e.g. 'x.com'
  mcpConfig?: { upstreamUrl: string };           // proxy to an upstream MCP server
  openapiConfig?: {                              // auto-generate from OpenAPI
    specUrl: string;
    includeOperations?: string[];
    excludeOperations?: string[];
    includeTags?: string[];
    serverUrl?: string;
  };
  requiredCapability?: string;                   // e.g. 'screentime' (device-only)
  runtime?: ConnectorRuntimeInfo;                // pin to a device platform
}
```

### `ConnectorRuntimeInfo`

```ts
interface ConnectorRuntimeInfo {
  platforms: Array<"ios" | "android" | "macos" | "windows" | "linux">;
  scopes?: string[];            // forwarded to the native platform adapter
  nix?: { packages: string[] }; // native deps provisioned at run time
}
```

`platforms` and `scopes` describe device-bound connectors; omit the `runtime` block for cloud-fleet connectors that do not pin to a device.

`nix.packages` lists native system dependencies as nixpkgs attribute refs (for example `["ffmpeg", "imagemagick"]`) the connector needs on PATH at execution time. npm dependencies are bundled into the connector at compile time and do **not** go here. Backends that can run native deps (embedded, container, machine) provision them via `nix-shell`; backends that cannot (for example edge workers) reject a connector that declares them. See [Dependencies](/getting-started/connector-sdk/#dependencies) in the guide for the npm-vs-native split.

---

## `ConnectorAuthSchema`

```ts
interface ConnectorAuthSchema {
  methods: ConnectorAuthMethod[];
}

type ConnectorAuthMethod =
  | ConnectorAuthNone
  | ConnectorAuthEnvKeys
  | ConnectorAuthOAuth
  | ConnectorAuthBrowser
  | ConnectorAuthInteractive;
```

### `ConnectorAuthNone`

```ts
{ type: "none" }
```

### `ConnectorAuthEnvKeys`

```ts
interface ConnectorAuthEnvKeys {
  type: "env_keys";
  required?: boolean;
  scope?: "connection" | "organization";
  fields: ConnectorAuthEnvField[];
  description?: string;
}

interface ConnectorAuthEnvField {
  key: string;
  label?: string;
  description?: string;
  example?: string;
  secret?: boolean;
  required?: boolean;
}
```

### `ConnectorAuthOAuth`

```ts
interface ConnectorAuthOAuth {
  type: "oauth";
  provider: string;
  requiredScopes: string[];
  optionalScopes?: string[];
  required?: boolean;
  description?: string;
  scope?: "connection" | "organization";
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
  usePkce?: boolean;
  loginScopes?: string[];
  clientIdKey?: string;
  clientSecretKey?: string;
  setupInstructions?: string;
  loginProvisioning?: { autoCreateConnection?: boolean };
}
```

### `ConnectorAuthBrowser`

```ts
interface ConnectorAuthBrowser {
  type: "browser";
  required?: boolean;
  description?: string;
  capture?: "cli" | "cdp"; // cli = lobu memory browser-auth; cdp = remote debug
  requiredDomains?: string[];
  defaultCdpUrl?: string; // default: http://127.0.0.1:9222
}
```

### `ConnectorAuthInteractive`

```ts
interface ConnectorAuthInteractive {
  type: "interactive";
  required?: boolean;
  description?: string;
  scope?: "connection" | "organization";
  expectedArtifact?: "qr" | "code" | "redirect" | "prompt" | "status";
  timeoutSec?: number; // default 300
}
```

Connectors declaring this method must implement `authenticate(ctx)` and stream [`AuthArtifact`s](#authartifact).

---

## `FeedDefinition`

```ts
interface FeedDefinition {
  key: string;
  name: string;
  description?: string;
  requiredScopes?: string[];                // OAuth scopes that must be held
  displayNameTemplate?: string;             // "{subreddit} - {content_type}"
  configSchema?: Record<string, unknown>;   // JSON Schema for per-feed config
  userManaged?: boolean;                    // skip auto-wire creation
  eventKinds?: Record<string, {
    description?: string;
    metadataSchema?: Record<string, unknown>;
    entityLinks?: EntityLinkRule[];         // declarative entity wiring
  }>;
}
```

### `EntityLinkRule`

Declares how events emitted by a feed link to dimension entities.

```ts
interface EntityLinkRule {
  entityType: string;                       // target slug, e.g. "$member"
  autoCreate?: boolean;
  titlePath?: string;
  identities: EntityIdentitySpec[];
  traits?: Record<string, EntityTraitSpec>;
}

interface EntityIdentitySpec {
  namespace: string;                        // 'phone', 'email', or custom
  eventPath: string;                        // dot path into the event
  matchOnly?: boolean;
}

interface EntityTraitSpec {
  eventPath: string;
  behavior: "init_only" | "prefer_non_empty" | "overwrite";
}
```

### `EntityLinkOverride`

Per-install override stored on `connector_definitions`:

```ts
interface EntityLinkOverride {
  disable?: boolean;
  retargetEntityType?: string;
  autoCreate?: boolean;
  maskIdentities?: string[];
}

type EntityLinkOverrides = Record<string, EntityLinkOverride>;
```

### `IDENTITY` constants

Canonical namespaces for cross-connector identity. Use these when targeting `$member` so identities align automatically:

```ts
const IDENTITY = {
  PHONE: "phone",
  EMAIL: "email",
  WA_JID: "wa_jid",
  SLACK_USER_ID: "slack_user_id",
  GITHUB_LOGIN: "github_login",
  GITHUB_USER_ID: "github_user_id",
  GITHUB_REPO_ID: "github_repo_id",
  GITHUB_REPO_FULL_NAME: "github_repo_full_name",
  AUTH_USER_ID: "auth_user_id",
  GOOGLE_CONTACT_ID: "google_contact_id",
} as const;

type IdentityNamespace = (typeof IDENTITY)[keyof typeof IDENTITY];
```

### `FeedMode`

```ts
enum FeedMode {
  sync = "sync",       // connector code runs on a worker
  virtual = "virtual", // backed by saved queries (future)
}
```

---

## `ActionDefinition`

```ts
interface ActionDefinition {
  key: string;
  name: string;
  description?: string;
  requiresApproval: boolean;
  annotations?: {
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  inputSchema?: Record<string, unknown>;   // JSON Schema
  outputSchema?: Record<string, unknown>;
}
```

---

## `SyncContext`

```ts
interface SyncContext {
  feedKey: string;
  config: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  credentials: SyncCredentials | null;
  entityIds: number[];
  sessionState?: Record<string, unknown> | null;
  emitEvents?: (events: EventEnvelope[]) => Promise<void>;
  updateCheckpoint?: (checkpoint: Record<string, unknown> | null) => Promise<void>;
}

interface SyncCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}
```

`emitEvents` and `updateCheckpoint` are present only on the long-running sync path. For short syncs return the full result and ignore both hooks.

**Where credentials land.** `ctx.credentials` is populated only for `oauth` auth (the gateway hands you the resolved `SyncCredentials`). For `env_keys` auth, the values the user filled into the form are merged into `ctx.config` under the keys you declared on each `ConnectorAuthEnvField`. For `browser` auth, captured cookies arrive on `ctx.sessionState`. For `none`, all three are `null`/empty. Same rules apply to `ActionContext`.

---

## `SyncResult`

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

`auth_update` is for connectors whose credentials rotate during sync (browser cookies, opaque session tokens). The gateway persists it back onto the linked auth profile.

---

## `EventEnvelope`

The output shape of every connector-emitted event. Each envelope becomes a row in `events`.

```ts
interface EventEnvelope {
  origin_id: string;                                // required: platform's unique ID
  origin_type?: string;                             // source-native item type
  payload_type?: "text" | "markdown" | "json_template" | "media" | "empty";
  payload_text: string;                             // required: main content
  payload_data?: Record<string, unknown>;           // structured data
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[];
  title?: string;
  author_name?: string;
  source_url?: string;
  occurred_at: Date;                                // required: when it happened
  semantic_type?: string;                           // content/note/summary/fact/…
  score?: number;                                   // 0-100 engagement
  origin_parent_id?: string;                        // hierarchical content
  metadata?: Record<string, unknown>;
  embedding?: number[];                             // pre-computed
}
```

---

## `ActionContext` / `ActionResult`

```ts
interface ActionContext {
  actionKey: string;
  input: Record<string, unknown>;
  credentials: SyncCredentials | null;
  config: Record<string, unknown>;
}

interface ActionResult {
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
}
```

---

## `AuthContext` / `AuthArtifact` / `AuthResult`

For connectors with `{ type: "interactive" }` auth.

```ts
interface AuthContext {
  config: Record<string, unknown>;
  previousCredentials: Record<string, unknown> | null;
  emit: (artifact: AuthArtifact) => Promise<void>;
  awaitSignal: (
    name: string,
    options?: { timeoutMs?: number }
  ) => Promise<Record<string, unknown>>;
  signal: AbortSignal;
}

type AuthArtifact =
  | { type: "qr"; value: string; expiresAt?: string; instructions?: string }
  | { type: "code"; value: string; expiresAt?: string; instructions?: string }
  | {
      type: "redirect";
      url: string;
      mode: "popup" | "same-tab";
      awaitSignal: string;
      instructions?: string;
    }
  | {
      type: "prompt";
      fields: Array<{
        key: string;
        label: string;
        kind: "text" | "password" | "otp";
        required?: boolean;
      }>;
      submitSignal: string;
      instructions?: string;
    }
  | { type: "status"; message: string };

interface AuthResult {
  credentials: Record<string, unknown>;
  metadata?: {
    account_id?: string;
    display_name?: string;
    expires_at?: string;
    [key: string]: unknown;
  };
}
```

`ctx.emit(artifact)` streams the next thing the UI should show. Each emit replaces the previously active artifact. Pause on `ctx.awaitSignal("name")` until the UI POSTs the matching signal.

---

## `Connection` / `Feed` / `Run`

DB-backed types the runtime hands you in admin contexts. Reads only — connectors never write these.

```ts
interface Connection {
  id: number;
  organizationId: string;
  connectorKey: string;
  displayName?: string;
  status: "active" | "paused" | "error" | "revoked";
  accountId?: string;
  credentials?: Record<string, unknown>;
  entityIds?: number[];
  config?: Record<string, unknown>;
  errorMessage?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Feed {
  id: number;
  organizationId: string;
  connectionId: number;
  feedKey: string;
  status: "active" | "paused" | "error";
  entityIds?: number[];
  config?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  syncIntervalMs?: number;
  nextSyncAt?: Date;
  lastSyncAt?: Date;
  lastSyncStatus?: string;
  lastError?: string;
  consecutiveFailures: number;
  itemsCollected: number;
  createdAt: Date;
  updatedAt: Date;
}

type RunType = "sync" | "action" | "code" | "watcher" | "auth";
type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout";
type ApprovalStatus = "pending" | "approved" | "rejected" | "auto";

interface Run {
  id: number;
  organizationId: string;
  runType: RunType;
  feedId?: number;
  connectionId?: number;
  actionKey?: string;
  actionInput?: Record<string, unknown>;
  actionOutput?: Record<string, unknown>;
  approvalStatus: ApprovalStatus;
  status: RunStatus;
  claimedBy?: string;
  claimedAt?: Date;
  lastHeartbeatAt?: Date;
  completedAt?: Date;
  connectorKey?: string;
  connectorVersion?: string;
  checkpoint?: Record<string, unknown>;
  itemsCollected: number;
  errorMessage?: string;
  createdAt: Date;
}
```

---

## Helpers

The package also re-exports a few utilities so connectors share one implementation:

| Export | Purpose |
|--------|---------|
| `ky`, `HTTPError`, `KyInstance`, `Options` | Shared HTTP client. |
| `withHttpRetry(fn, opts?)` | Retry-with-backoff wrapper for transient HTTP failures. |
| `calculateEngagementScore(signals)` | Maps raw engagement metrics into a normalised 0–100 `score`. |
| `Type`, `Static` | Re-exported TypeBox builders for `configSchema` / `inputSchema` / `outputSchema`. |
| `sdkLogger` (alias `logger`) | Connector-scoped logger; output is captured by the run record. |
| `normalizeEmail`, `normalizePhone`, `normalizeGithubLogin`, … | Identifier normalisers — call these before populating `EntityIdentitySpec` paths. |
| `SOURCE_NATIVE_EVENT_TYPES`, `isSourceNativeEventType` | The canonical event-type taxonomy. |
| `WATCHER_TIME_GRANULARITIES`, `alignToWatcherWindowStart`, … | Time helpers used by watcher scheduling. |
| Browser SDK: `acquireBrowser`, `launchBrowser`, `launchStealthBrowser`, `CdpPage`, `browserNetworkSync`, etc. | Headless / CDP / stealth browser primitives for `browser` and `cdp` capture. |

See the [source on GitHub](https://github.com/lobu-ai/lobu/tree/main/packages/connector-sdk/src) for the full helper surface.
