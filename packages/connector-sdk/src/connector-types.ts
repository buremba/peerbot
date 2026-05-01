/**
 * Connector Types
 *
 * Type definitions for the V1 integration platform.
 * Defines the contract between connectors, the runtime, and the platform.
 */

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
  | ConnectorAuthInteractive;

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
  AUTH_USER_ID: 'auth_user_id',
  GOOGLE_CONTACT_ID: 'google_contact_id',
} as const;

export type IdentityNamespace = (typeof IDENTITY)[keyof typeof IDENTITY];

export enum FeedMode {
  /** Connector code runs on worker, syncs data */
  sync = 'sync',
  /** Virtual feed backed by saved queries (future) */
  virtual = 'virtual',
}

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
 * Context passed to ConnectorRuntime.sync()
 */
export interface SyncContext {
  /** Feed configuration */
  feedKey: string;
  config: Record<string, unknown>;
  /** Previous checkpoint (null on first sync) */
  checkpoint: Record<string, unknown> | null;
  /** OAuth credentials (if applicable) */
  credentials: SyncCredentials | null;
  /** Entity IDs this feed is linked to */
  entityIds: number[];
  /** Connection session state (browser cookies, tokens, etc.) */
  sessionState?: Record<string, unknown> | null;
  /** Optional hook for streaming event chunks while sync is in progress */
  emitEvents?: (events: EventEnvelope[]) => Promise<void>;
  /** Optional hook for persisting progress checkpoints during long syncs */
  updateCheckpoint?: (checkpoint: Record<string, unknown> | null) => Promise<void>;
}

export interface SyncCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

/**
 * Result from ConnectorRuntime.sync()
 */
export interface SyncResult {
  /** Events to write to the events table */
  events: EventEnvelope[];
  /** Updated checkpoint to persist */
  checkpoint: Record<string, unknown> | null;
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
