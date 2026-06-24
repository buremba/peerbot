/**
 * Connector Types
 *
 * Type definitions for the V1 integration platform.
 * Defines the contract between connectors, the runtime, and the platform.
 */

// Metric-reflection contract shapes live in ./metrics.ts (the persisted metric
// contract — see that file for why connector-sdk, not core). Imported for local
// use (ReflectResult) and re-exported below for connector authors.
import type { EntityTypeContribution, ReflectedMeasure } from './metrics.js';

// =============================================================================
// Connector Definition
// =============================================================================

export interface ConnectorDefinition {
  /** Unique connector key, e.g. 'google.gmail' */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description of what this connector does */
  description?: string;
  /** Semantic version */
  version: string;
  /** Auth configuration */
  authSchema?: ConnectorAuthSchema;
  /** Available feed definitions (keyed by feed_key) */
  feeds?: Record<string, FeedDefinition>;
  /** Available action definitions (keyed by action_key) */
  actions?: Record<string, ActionDefinition>;
  /**
   * Declarative inbound-webhook config. Presence means this connector receives
   * real-time provider deliveries at `POST /api/v1/webhooks/:connectionId`,
   * which are landed RAW into `events` (extract-load — the agent/downstream
   * stages interpret them; no transform on the ingest hot path). The gateway
   * verifies the signature IN-PROCESS using this schema + the secret stored on
   * the connection, so the hot path never loads connector code. Pair with
   * {@link ConnectorRuntime.registerWebhook}, which subscribes with the provider
   * at connect time and stamps the signing secret onto the connection.
   */
  webhook?: ConnectorWebhookSchema;
  /** Global connector options schema (JSON Schema) */
  optionsSchema?: Record<string, unknown>;
  /** Domain for favicon lookup (e.g. 'x.com') */
  faviconDomain?: string;
  /** Optional upstream MCP configuration */
  mcpConfig?: {
    upstreamUrl: string;
  };
  /** Optional OpenAPI operation source */
  openapiConfig?: {
    specUrl: string;
    includeOperations?: string[];
    excludeOperations?: string[];
    includeTags?: string[];
    serverUrl?: string;
  };
  /**
   * Optional worker capability required to run this connector. Workers advertise
   * capabilities on poll; the runs scheduler only hands a connector run to a
   * worker whose capabilities array includes this value. Unset = any worker
   * (default API/browser fleet). Example: `'screentime'` for apple.screen_time
   * (only Lobu for Mac, with Full Disk Access, can read the Knowledge store).
   */
  requiredCapability?: string;
  /**
   * Present only for device-bound connectors. Omitting this field means the
   * connector runs on the server-side worker fleet (cloud). `platforms` lists
   * the host platforms a device worker (e.g. Lobu for Mac) must be running on
   * to serve this connector's runs.
   */
  runtime?: ConnectorRuntimeInfo;
}

export interface ConnectorRuntimeInfo {
  /** Platforms this connector can run on. */
  platforms: Array<'ios' | 'android' | 'macos' | 'windows' | 'linux'>;
  /**
   * Permission/auth scopes forwarded verbatim to the native platform adapter.
   * Optional — omit when the platform adapter needs no fine-grained scope list.
   */
  scopes?: string[];
  /**
   * Native system dependencies this connector needs on PATH at execution time,
   * as nixpkgs attribute references (e.g. `["ffmpeg", "imagemagick"]`). npm
   * dependencies are bundled into the connector at compile time and do NOT go
   * here — only native tools the runtime must provision. Backends that can run
   * native deps (embedded, container, machine) satisfy these via nix; backends
   * that can't (e.g. edge workers) reject a connector that declares them.
   */
  nix?: { packages: string[] };
}

/**
 * Declarative scheme the gateway uses to verify an inbound provider webhook in
 * the request hot path — no connector code runs before the 202 ack. The shared
 * secret is NOT here: it is minted by {@link ConnectorRuntime.registerWebhook}
 * at connect time and stored on the connection.
 */
export interface ConnectorWebhookSchema {
  /**
   * Request header carrying the provider's HMAC signature over the raw body,
   * e.g. `x-hub-signature-256` (GitHub), `linear-signature`. Omit for providers
   * that don't sign — verification is then skipped (relies on the unguessable
   * per-connection URL + token), so prefer signing whenever the provider offers it.
   */
  signatureHeader?: string;
  /** HMAC digest algorithm used to compute the signature. Default `sha256`. */
  algorithm?: 'sha256' | 'sha1';
  /**
   * Prefix the provider prepends to the hex digest in the signature header,
   * e.g. `sha256=`. Stripped before the constant-time compare. Default none.
   */
  signaturePrefix?: string;
  /**
   * Request header carrying the provider's unique delivery id, used for
   * idempotent dedupe (e.g. `x-github-delivery`, `linear-delivery`). Falls back
   * to a body hash when unset.
   */
  dedupeHeader?: string;
  /**
   * How the gateway routes inbound deliveries to a connection.
   * - `'registered'` (default — back-compat): per-connection webhook URL
   *   (`/api/v1/webhooks/:connectionId`) created by
   *   {@link ConnectorRuntime.registerWebhook}; the connection id is in the path.
   * - `'app_installation'`: shared provider endpoint
   *   (`/api/v1/app-webhooks/:provider`) for an org/workspace-scoped App install.
   *   In this mode {@link ConnectorRuntime.registerWebhook} /
   *   `unregisterWebhook` are NO-OPS (the App subscription is provisioned at
   *   install time, not per connection), and delivery routing + signature
   *   verification are performed by a server-side provider plugin (verifier +
   *   tenant extractor) — NOT by `routingKeyPath` or this schema's HMAC fields
   *   alone, which are insufficient for provider-specific signing (GitHub
   *   raw-body HMAC, Slack `v0:{ts}:{rawBody}` with timestamp freshness, etc.).
   */
  delivery?: 'registered' | 'app_installation';
  /**
   * `app_installation` mode only: JSON path to the external tenant id within the
   * delivery body, e.g. `'installation.id'`. Informational/UI hint; the actual
   * tenant extraction + verification is owned by the provider plugin (§4.3),
   * which may read headers/site-URL that this single path cannot express.
   */
  routingKeyPath?: string;
}

// =============================================================================
// Auth
// =============================================================================

export interface ConnectorAuthSchema {
  methods: ConnectorAuthMethod[];
}

export type ConnectorAuthMethod =
  | ConnectorAuthNone
  | ConnectorAuthEnvKeys
  | ConnectorAuthOAuth
  | ConnectorAuthBrowser
  | ConnectorAuthInteractive
  | ConnectorAuthAppInstallation;

export interface ConnectorAuthNone {
  type: 'none';
}

export interface ConnectorAuthEnvField {
  key: string;
  label?: string;
  description?: string;
  example?: string;
  secret?: boolean;
  required?: boolean;
}

export interface ConnectorAuthEnvKeys {
  type: 'env_keys';
  required?: boolean;
  scope?: 'connection' | 'organization';
  fields: ConnectorAuthEnvField[];
  description?: string;
}

export interface OAuthLoginProvisioningConfig {
  /** Auto-create/reuse a connector connection when the user logs in with this provider. */
  autoCreateConnection?: boolean;
}

export interface ConnectorAuthOAuth {
  type: 'oauth';
  provider: string;
  requiredScopes: string[];
  optionalScopes?: string[];
  required?: boolean;
  description?: string;
  scope?: 'connection' | 'organization';
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  loginScopes?: string[];
  clientIdKey?: string;
  clientSecretKey?: string;
  setupInstructions?: string;
  loginProvisioning?: OAuthLoginProvisioningConfig;
}

/**
 * Declares that this connector runs an interactive auth flow via
 * `ConnectorRuntime.authenticate()`. The UI responds by enqueuing an auth run
 * and rendering the artifacts it emits (QR, pairing code, redirect, prompt).
 */
export interface ConnectorAuthInteractive {
  type: 'interactive';
  required?: boolean;
  description?: string;
  scope?: 'connection' | 'organization';
  /**
   * Hint for the UI about the primary artifact kind the connector emits first.
   * Used to pick a sensible loading state before the first artifact arrives.
   */
  expectedArtifact?: 'qr' | 'code' | 'redirect' | 'prompt' | 'status';
  /** Max seconds the whole auth flow is allowed to run. Default 300. */
  timeoutSec?: number;
}

export interface ConnectorAuthBrowser {
  type: 'browser';
  required?: boolean;
  description?: string;
  /**
   * How browser auth is captured:
   * - 'cli': Extract cookies from Chrome profile via `lobu memory browser-auth`
   * - 'cdp': Connect to a running Chrome instance via Chrome DevTools Protocol.
   *          Requires Chrome launched with --remote-debugging-port=9222.
   *          Used for services (like Google) that block headless browsers.
   */
  capture?: 'cli' | 'cdp';
  /** Required cookie domains for 'cli' capture (e.g. ['x.com', '.x.com']) */
  requiredDomains?: string[];
  /** Default CDP URL for 'cdp' capture (default: http://127.0.0.1:9222) */
  defaultCdpUrl?: string;
}

/**
 * Org/workspace-scoped App install (GitHub App, Slack app, Jira site, …).
 * Install once per external tenant → a tenant-scoped token + webhook events
 * flow. Distinct from {@link ConnectorAuthOAuth}, which is user-scoped; a single
 * connector may declare both (resolver precedence is defined server-side).
 *
 * The credential is minted/refreshed gateway-side and never handed to the
 * worker as a raw token — the worker receives a `lobu_secret_<uuid>` placeholder
 * that the secret-proxy swaps at egress (same invariant as all other creds).
 */
export interface ConnectorAuthAppInstallation {
  type: 'app_installation';
  /** Provider key, e.g. `'github' | 'slack' | 'jira'`. */
  provider: string;
  /**
   * Provider instance: `'cloud'` (default) for the public SaaS, a GitHub
   * Enterprise Server host, or an Atlassian site class. Lets one connector serve
   * multiple deployments of the same provider.
   */
  providerInstance?: string;
  /** Env var holding the Lobu App's id (e.g. `GITHUB_APP_ID`). Gateway-side. */
  appIdKey?: string;
  /** Env var holding the App private key used to mint tokens (GitHub). Gateway-side. */
  privateKeyKey?: string;
  /** Template URL the UI sends the user to in order to install the App. */
  installUrlTemplate?: string;
  /** Declared App permissions (informational; surfaced in the install UI). */
  permissions?: string[];
  /** Webhook event types the App subscribes to (informational; install UI). */
  events?: string[];
  required?: boolean;
  description?: string;
}

/**
 * Resolved app-installation context for the run, attached to every execution and
 * webhook-registration context a connector method receives. Carries the external
 * tenant identity + routing keys, never the raw credential (see
 * {@link ConnectorAuthAppInstallation}).
 */
export interface ConnectorInstallationContext {
  /** `app_installations.id` — the Lobu install row id. */
  id: string;
  /** Provider key, e.g. `'github'`. */
  provider: string;
  /** Provider instance, e.g. `'cloud'`. */
  providerInstance: string;
  /** Which Lobu App minted this install (supports >1 App per provider). */
  providerAppId?: string;
  /** External tenant id: installation_id / team_id / cloudId. */
  externalTenantId: string;
  /** Provider-specific install metadata (bot_user_id, account login, …). */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Feed Definition
// =============================================================================

export interface FeedDefinition {
  /** Feed key, e.g. 'threads' */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** OAuth scopes required to keep this feed active. */
  requiredScopes?: string[];
  /** Template for generating feed display names from config values, e.g. "{subreddit} - {content_type}" */
  displayNameTemplate?: string;
  /** JSON Schema for feed-specific config */
  configSchema?: Record<string, unknown>;
  /**
   * When true, auto-wire (device-reconcile + bundled-connector install) skips
   * this feed — every feed instance is created explicitly by the user (or by
   * the device worker on their behalf). Use this for feeds whose configSchema
   * has required fields that can only be supplied by an external actor, e.g.
   * `local.directory.files` needs a per-folder `folder_id` from the Mac app.
   */
  userManaged?: boolean;
  /**
   * Routes inbound app-webhook deliveries to this feed. Lives on the feed (not
   * the connector's webhook schema) because feeds_schema is the persisted,
   * server-readable surface — the app-webhook router reads this to dispatch a
   * delivery WITHOUT hardcoding provider event types. The connector owns this
   * knowledge (which event updates which feed, and whether the payload is
   * complete enough to store):
   *  - `mode: 'trigger'` (default) — the poll brings more than the webhook, so
   *    mark this feed due and let the poll fetch the complete record (deduped by
   *    origin_id). Use for events whose poll endpoint returns richer data.
   *  - `mode: 'store'` — the payload is event-complete (e.g. a GitHub `star`
   *    carries the actor + starred_at) and re-polling the whole list is wasteful,
   *    so the router stores the structured event directly, consolidating with the
   *    poll on the same origin_id.
   */
  webhook?: {
    /** Provider webhook event types (e.g. `x-github-event` values) that update this feed. */
    events: string[];
    /** How a matching delivery is handled. Default `'trigger'`. */
    mode?: 'trigger' | 'store';
  };
  /** Event kinds this feed produces, keyed by kind slug */
  eventKinds?: Record<
    string,
    {
      description?: string;
      metadataSchema?: Record<string, unknown>;
      /**
       * Declarative entity links — identifiers live in a normalized
       * `entity_identities` table; traits live on `entities.metadata`.
       *
       * Iceberg-friendly: no mutation of events.entity_ids, JOIN at read
       * time via entity_identities on (org, namespace, identifier).
       */
      entityLinks?: EntityLinkRule[];
    }
  >;
}

/**
 * Normalized identifier that uniquely names an entity within a namespace.
 * Stored as a row in `entity_identities` with UNIQUE on
 * (organization_id, namespace, identifier) — matching, creation races, and
 * accrete all collapse onto this constraint.
 */
export interface EntityIdentitySpec {
  /**
   * Identifier namespace. Use values from the `IDENTITY` constants
   * whenever possible (phone, email, wa_jid, ...); custom namespaces are
   * allowed but connectors sharing a namespace must agree on its format.
   */
  namespace: string;
  /** Dot path into the event to extract the raw identifier. */
  eventPath: string;
  /**
   * When true, the identifier is used for matching existing entities but
   * not persisted on create or accrete. Defaults to false.
   */
  matchOnly?: boolean;
  /**
   * Marks an IMMUTABLE, authoritative identifier (e.g. a numeric provider user
   * id that survives renames). When a primary identity is PRESENT on an event:
   *   - if it matches an existing entity → that entity is used;
   *   - if it is present but matches nothing → resolution does NOT fall through
   *     to a non-primary match (a fresh primary id means a distinct account; a
   *     stale, since-reused secondary identifier like a renamed login must not
   *     conflate the two). A new entity is created keyed on the primary id.
   * Defaults to false: non-primary identities match equal-weight (a person is
   * matched by ANY of them — the cross-channel behavior whatsapp/email rely on).
   */
  primary?: boolean;
}

/**
 * Descriptive field stored on `entities.metadata`. Behavior determines how
 * the ingestion pipeline reconciles the value on match vs create.
 */
export interface EntityTraitSpec {
  /** Dot path into the event to extract the value. */
  eventPath: string;
  /**
   * - `init_only`        — write once on create, never touch after.
   * - `prefer_non_empty` — set only when current is null/empty, and skip empty event values.
   * - `overwrite`        — always write (for last_seen_at, status, etc.).
   */
  behavior: 'init_only' | 'prefer_non_empty' | 'overwrite';
}

/**
 * Declares how events link to dimension entities.
 *
 * - Identifiers are normalized on write and stored in `entity_identities`
 *   so matching is constraint-safe (UNIQUE per namespace+identifier).
 * - Ambiguity (same event's identifiers resolve to multiple distinct
 *   entities) is logged as a merge candidate; the platform never
 *   auto-picks a winner or cross-contaminates entities.
 * - Traits are descriptive fields merged onto entities.metadata per
 *   the declared `behavior`.
 */
export interface EntityLinkRule {
  /** Target entity type slug (e.g. '$member', 'chat_group'). The type must exist in the org. */
  entityType: string;
  /**
   * Create the entity if no existing entity matches any identifier.
   * When false, unmatched events stay unlinked and no entity is created.
   */
  autoCreate?: boolean;
  /** Dot path used for `entities.name` on create. */
  titlePath?: string;
  /** Identifier specs. At least one is required. */
  identities: EntityIdentitySpec[];
  /** Optional descriptive fields written to entities.metadata. */
  traits?: Record<string, EntityTraitSpec>;
}

/**
 * Per-install override for a connector's entityLinks rules, keyed by the
 * rule's `entityType`. Stored as JSONB on `connector_definitions` and
 * shallow-merged at rule-resolve time. Lets an org retarget, disable rules,
 * flip autoCreate, or mask specific identifier namespaces without forking
 * the connector source.
 *
 * Storage shape:
 *   { "$member": { autoCreate: false, maskIdentities: ["phone"] }, ... }
 */
export interface EntityLinkOverride {
  /** Drop the rule entirely. Other fields are ignored when true. */
  disable?: boolean;
  /** Rewrite the target entity type (e.g. retarget to a custom type). */
  retargetEntityType?: string;
  /** Override autoCreate on the matched rule. */
  autoCreate?: boolean;
  /** Filter out identity specs by namespace before matching/persisting. */
  maskIdentities?: string[];
}

export type EntityLinkOverrides = Record<string, EntityLinkOverride>;

/**
 * Canonical namespaces for cross-connector identity. Connectors targeting
 * `$member` should use these so identities align automatically.
 */
export const IDENTITY = {
  PHONE: 'phone',
  EMAIL: 'email',
  WA_JID: 'wa_jid',
  SLACK_USER_ID: 'slack_user_id',
  GITHUB_LOGIN: 'github_login',
  GITHUB_USER_ID: 'github_user_id',
  GITHUB_REPO_ID: 'github_repo_id',
  GITHUB_REPO_FULL_NAME: 'github_repo_full_name',
  AUTH_USER_ID: 'auth_user_id',
  GOOGLE_CONTACT_ID: 'google_contact_id',
} as const;

export type IdentityNamespace = (typeof IDENTITY)[keyof typeof IDENTITY];

// =============================================================================
// Action Definition
// =============================================================================

export interface ActionDefinition {
  /** Action key, e.g. 'draft_email' */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Whether this action requires human approval before execution */
  requiresApproval: boolean;
  /** MCP tool annotations for client-side confirmation UX */
  annotations?: {
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  /** JSON Schema for action input */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for action output */
  outputSchema?: Record<string, unknown>;
}

// =============================================================================
// Connection
// =============================================================================

export interface Connection {
  id: number;
  organizationId: string;
  connectorKey: string;
  displayName?: string;
  status: 'active' | 'paused' | 'error' | 'revoked';
  accountId?: string;
  credentials?: Record<string, unknown>;
  entityIds?: number[];
  config?: Record<string, unknown>;
  errorMessage?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Feed
// =============================================================================

export interface Feed {
  id: number;
  organizationId: string;
  connectionId: number;
  feedKey: string;
  status: 'active' | 'paused' | 'error';
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

// =============================================================================
// Run
// =============================================================================

export type RunType = 'sync' | 'action' | 'code' | 'watcher' | 'auth';
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'auto';

export interface Run {
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

// =============================================================================
// Event Envelope
// =============================================================================

/**
 * EventEnvelope is the standard output format for connector sync operations.
 * Each envelope becomes a row in the events table.
 */
export interface EventEnvelope {
  /** Platform's unique ID for this item */
  origin_id: string;
  /** Source-native item type (e.g. post, message, issue) */
  origin_type?: string;
  /** Content format: 'text' (default), 'markdown', 'json_template', 'media', 'empty' */
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  /** Main text content */
  payload_text: string;
  /** Structured data (template data for json_template, or structured metadata for media) */
  payload_data?: Record<string, unknown>;
  /** JSON template for rendering (required when payload_type is 'json_template') */
  payload_template?: Record<string, unknown> | null;
  /** File or media attachments */
  attachments?: unknown[];
  /** Title / subject line */
  title?: string;
  /** Author name or email */
  author_name?: string;
  /** Link to original content */
  source_url?: string;
  /** When the content was originally created/published */
  occurred_at: Date;
  /** Semantic type (e.g. content, note, summary, fact) */
  semantic_type?: string;
  /** Engagement/relevance score (0-100) */
  score?: number;
  /** Parent reference for hierarchical content */
  origin_parent_id?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding vector */
  embedding?: number[];
}

// =============================================================================
// Sync Context & Result
// =============================================================================

/**
 * Context passed to ConnectorRuntime.sync().
 *
 * Generic parameters:
 * - `C` — checkpoint shape (defaults to `Record<string, unknown>`)
 * - `F` — feed config shape (defaults to `Record<string, unknown>`)
 */
export interface SyncContext<C = Record<string, unknown>, F = Record<string, unknown>> {
  /** Feed key */
  feedKey: string;
  /**
   * Stable id of this feed INSTANCE (the `feeds` row), when run by the platform.
   * Distinct per feed even when several feeds share one `feedKey` on a single
   * connection — use it to namespace emitted `origin_id`s so two feeds can't
   * supersede each other's events. Undefined for direct/programmatic sync calls.
   */
  feedId?: number | null;
  /** Feed configuration (typed via F) */
  config: F;
  /** Previous checkpoint (null on first sync) */
  checkpoint: C | null;
  /** OAuth credentials (if applicable) */
  credentials: SyncCredentials | null;
  /** Entity IDs this feed is linked to */
  entityIds: number[];
  /** Connection session state (browser cookies, tokens, etc.) */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
  /** Optional hook for streaming event chunks while sync is in progress */
  emitEvents?: (events: EventEnvelope[]) => Promise<void>;
  /** Optional hook for persisting progress checkpoints during long syncs */
  updateCheckpoint?: (checkpoint: C | null) => Promise<void>;
}

export interface SyncCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

/**
 * Result from ConnectorRuntime.sync().
 *
 * Generic parameter `C` matches the connector's checkpoint shape.
 */
export interface SyncResult<C = Record<string, unknown>> {
  /** Events to write to the events table */
  events: EventEnvelope[];
  /** Updated checkpoint to persist */
  checkpoint: C | null;
  /** Updated auth state to persist on the linked auth profile (browser cookies, etc.) */
  auth_update?: Record<string, unknown> | null;
  /** Optional metadata about the sync */
  metadata?: {
    items_found?: number;
    items_skipped?: number;
    [key: string]: unknown;
  };
}

// =============================================================================
// Webhooks (inbound real-time push)
// =============================================================================

/**
 * Context passed to {@link ConnectorRuntime.registerWebhook} /
 * `unregisterWebhook` at connect/disconnect time.
 */
export interface WebhookRegistrationContext<F = Record<string, unknown>> {
  /** Feed/connector configuration (typed via F). */
  config: F;
  /** OAuth credentials used to authorize the subscription call. */
  credentials: SyncCredentials | null;
  /** Connection session state (browser cookies, tokens, etc.). */
  sessionState?: Record<string, unknown> | null;
  /**
   * Public URL the provider must POST deliveries to — the gateway builds this
   * from `PUBLIC_*_URL` + the connection id. The connector registers it verbatim.
   */
  callbackUrl: string;
  /** Provider-side subscription id to tear down (unregister only). */
  externalId?: string;
  /**
   * App-installation context when the webhook is backed by an App install. In
   * `app_installation` delivery mode register/unregister are no-ops, so this is
   * informational; subscriptions are provisioned at install time.
   */
  installation?: ConnectorInstallationContext;
}

/** Result from {@link ConnectorRuntime.registerWebhook}. */
export interface WebhookRegistration {
  /** Provider-side id of the created subscription, for later teardown. */
  externalId: string;
  /**
   * Shared secret the provider will sign deliveries with. Persisted on the
   * connection so the gateway can verify deliveries per {@link ConnectorWebhookSchema}.
   */
  secret?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Query (live pushdown — virtual feeds & external-backed derived entities)
// =============================================================================

/**
 * Context passed to ConnectorRuntime.query(). The connector runs `query` LIVE
 * against its source and returns rows WITHOUT persisting anything (contrast
 * sync(), which emits events). Used for virtual-feed reads and external-backed
 * derived entities — `query` is the feed's configured SQL, or the entity's
 * backing.sql.
 */
export interface QueryContext<F = Record<string, unknown>> {
  /** Present for a virtual-feed read; absent for an ad-hoc / derived-entity query. */
  feedKey?: string;
  /** The read-only query to run. */
  query: string;
  /** Feed configuration (typed via F) when feedKey is set; `{}` otherwise. */
  config: F;
  /** OAuth/env credentials (if applicable). */
  credentials: SyncCredentials | null;
  /** Connection session state (browser cookies, tokens, etc.). */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
  /** Pagination + sort the platform wants applied; the connector pushes these down. */
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

/** Result from ConnectorRuntime.query(). Rows are returned to the caller, never persisted. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  columns?: { name: string; type: string }[];
  /** Total matching rows (for pagination), when cheaply available. */
  total?: number;
}

// =============================================================================
// Metric reflection (warehouse federation)
// =============================================================================

// The contributed shapes (EntityTypeContribution, ReflectedMeasure) are the
// persisted metric contract and live in ./metrics.ts (imported above).
// Re-exported here for connector authors.
export type { EntityTypeContribution, ReflectedMeasure };

/**
 * Context for {@link ConnectorRuntime.reflectMetrics} — enough to introspect the
 * source's native semantic layer (e.g. list Snowflake semantic views).
 */
export interface ReflectContext<F = Record<string, unknown>> {
  /**
   * The Lobu connection slug being reflected. Stamp this into each
   * {@link EntityTypeContribution} `backing.connection` so live queries route
   * back through the right connection (the connector cannot otherwise know it).
   */
  connectionSlug: string;
  /** Connector options (typed via F). */
  config: F;
  /** OAuth/env credentials (if applicable). */
  credentials: SyncCredentials | null;
  /** Connection session state (browser cookies, tokens, etc.). */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
}

/** Result from ConnectorRuntime.reflectMetrics() — federated entity types. */
export type ReflectResult = EntityTypeContribution[];

// =============================================================================
// Authentication Lifecycle
// =============================================================================

/**
 * Artifact streamed from connector.authenticate() to the UI during an
 * interactive auth flow. Exactly one artifact is active at a time; calling
 * `ctx.emit()` replaces the previously active artifact in the run checkpoint.
 *
 * Core doesn't interpret these — UI renders by `type`.
 */
export type AuthArtifact =
  | {
      type: 'qr';
      /** Raw string to encode in the QR. */
      value: string;
      /** ISO timestamp. UI shows countdown and expects a replacement emit. */
      expiresAt?: string;
      instructions?: string;
    }
  | {
      type: 'code';
      /** Short human-typed code, e.g. "ABCD-1234". */
      value: string;
      expiresAt?: string;
      instructions?: string;
    }
  | {
      type: 'redirect';
      /** URL the user must visit (OAuth authorize, etc.). */
      url: string;
      mode: 'popup' | 'same-tab';
      /** Signal name the connector awaits. UI POSTs to /api/auth-runs/:id/signal with this name. */
      awaitSignal: string;
      instructions?: string;
    }
  | {
      type: 'prompt';
      fields: Array<{
        key: string;
        label: string;
        kind: 'text' | 'password' | 'otp';
        required?: boolean;
      }>;
      /** Signal name the connector awaits once the user submits. */
      submitSignal: string;
      instructions?: string;
    }
  | {
      type: 'status';
      /** Progress message requiring no user action, e.g. "Waiting for phone…". */
      message: string;
    };

/**
 * Context passed to ConnectorRuntime.authenticate().
 */
export interface AuthContext {
  /** Optional connector-specific input (rare — most interactive flows need no input). */
  config: Record<string, unknown>;
  /**
   * Previous credentials if re-authenticating an existing profile. Connectors
   * may use these to preserve identity (e.g. refresh an OAuth token).
   */
  previousCredentials: Record<string, unknown> | null;
  /** Stream an artifact to the UI. Replaces the previously active artifact. */
  emit: (artifact: AuthArtifact) => Promise<void>;
  /**
   * Pause until the UI sends a signal with the given name. Returns the
   * signal payload (shape is connector-defined).
   */
  awaitSignal: (name: string, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>;
  /** Aborts on timeout, user cancel, or worker shutdown. */
  signal: AbortSignal;
}

/**
 * Result from ConnectorRuntime.authenticate(). Credentials are persisted to
 * the linked auth profile's `credentials` column. Metadata goes to
 * `auth_profiles.metadata` and powers UI session-state display.
 */
export interface AuthResult {
  credentials: Record<string, unknown>;
  metadata?: {
    /** Stable external identifier (wa_jid, OAuth `sub`, etc.) for dedupe. */
    account_id?: string;
    /** Display label shown in the UI, e.g. "Burak · +14155551234". */
    display_name?: string;
    /** For credentials that expire (OAuth refresh tokens). */
    expires_at?: string;
    [key: string]: unknown;
  };
}

// =============================================================================
// Action Context & Result
// =============================================================================

/**
 * Context passed to ConnectorRuntime.execute()
 */
export interface ActionContext {
  /** Action key to execute */
  actionKey: string;
  /** Action input parameters */
  input: Record<string, unknown>;
  /** OAuth credentials (if applicable) */
  credentials: SyncCredentials | null;
  /** Connection config */
  config: Record<string, unknown>;
  /**
   * Per-run session state. The connector-worker splices a live
   * `chrome_dispatcher` (a `ChromeActionDispatcher`) onto this for action runs
   * the same way it does for syncs, so on-demand actions can drive the paired
   * Owletto Chrome extension (e.g. scrape a page the agent chose at runtime).
   * Null when no session/dispatcher applies.
   */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
}

/**
 * Result from ConnectorRuntime.execute()
 */
export interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Output data */
  output?: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Content Item (API response shape)
// =============================================================================

/**
 * Content item as returned by the read_knowledge API.
 * This is the canonical shape for content data across the platform.
 */
export interface ContentItem {
  id: number;
  entity_ids: number[];
  platform: string;
  origin_id: string;
  semantic_type: string;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  author_name: string | null;
  title: string | null;
  text_content: string;
  payload_text?: string | null;
  payload_data?: Record<string, unknown>;
  payload_template?: Record<string, unknown> | null;
  attachments?: Array<Record<string, unknown>>;
  rating: string | null;
  source_url: string | null;
  score: number;
  normalized_score?: number;
  metadata: Record<string, unknown>;
  classifications: Record<string, unknown>;
  created_at: string;
  occurred_at: string;
  content_date?: string;
  /** Excerpt for highlighted evidence (when filtering by classification value) */
  excerpt?: string;
  /** Search score fields (only present when query is provided) */
  similarity?: number;
  text_rank?: number;
  combined_score?: number;
  /** Score breakdown (only present when sort_by=score, for debugging) */
  score_breakdown?: {
    engagement: number;
    criticality: number;
    depth: number;
    authority: number;
    recency: number;
    quality: number;
    raw_signals?: {
      depth_raw: number;
      engagement_raw: number;
    };
    weights: {
      engagement: number;
      criticality: number;
      depth: number;
      authority: number;
      recency: number;
      quality: number;
      platform: number;
    };
  };
  /** OAuth client name that created this event */
  client_name?: string | null;
  /** Immediate parent origin_id */
  origin_parent_id: string | null;
  /** Thread root origin_id */
  root_origin_id: string;
  /** 0 = root, 1+ = nested */
  depth: number;
  /** Only if parent not in current results */
  parent_context?: {
    author_name: string;
    title: string | null;
    text_content: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  /** Only if root not in results AND depth > 0 */
  root_context?: {
    author_name: string;
    title: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  /** Permalink URL for this specific knowledge item */
  permalink?: string | null;
  interaction_type?: 'none' | 'approval';
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;
  /** Entity display info (only present in some responses) */
  entity_name?: string;
  entity_type?: string;
  entity_slug?: string;
}
