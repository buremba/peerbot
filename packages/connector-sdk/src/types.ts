/**
 * Checkpoint data structure for tracking feed sync state
 */
export interface Checkpoint {
  // Required for all feeds - used to filter content by time
  last_timestamp?: Date;

  // Metadata
  updated_at: Date;
  total_items_processed?: number;

  // Platform-specific fields should extend this interface
}

/**
 * Sync result containing extracted content and updated checkpoint
 *
 * Note: checkpoint can be null for feeds that use incremental checkpoint
 * updates via updateCheckpointFn during pagination (e.g., Reddit)
 */
export interface FeedSyncResult {
  contents: Content[];
  checkpoint: Checkpoint | null;
  metadata?: {
    items_found: number;
    items_skipped: number;
    rate_limit_remaining?: number;
    next_sync_recommended_at?: Date;
    parent_map?: Record<string, string>; // For hierarchical content (e.g., GitHub comments -> issues)
    [key: string]: any; // Allow additional feed-specific metadata
  };
  /**
   * Auth state to persist after sync (browser cookies, etc.)
   * Will be saved back to the linked auth profile for browser-based connectors.
   */
  auth_update?: Record<string, any>;
}

/**
 * Extracted content from platform
 */
export interface Content {
  origin_id: string; // Platform's unique ID
  payload_text: string; // Main text content
  title?: string; // Title of content (e.g., post title, issue title, review subject)
  author_name?: string; // Username/display name
  source_url: string; // Link to original content
  occurred_at: Date; // When content was posted

  // Source-native item type (e.g. 'thread', 'message', 'email', 'issue', 'review')
  origin_type?: string;

  // Semantic type inside Lobu (defaults to 'content' for raw connector ingests)
  semantic_type?: string;

  // Calculated engagement score (0-100, calculated by feed implementation)
  score: number;

  // Optional parent reference for hierarchical content
  origin_parent_id?: string | null;

  // Metadata including engagement metrics (platform-specific)
  // Engagement fields: score, upvotes, downvotes, rating, helpful_count, reply_count, likes, views, retweets, replies, comments
  // Platform fields: post_id, parent_id, etc.
  metadata?: Record<string, any>;
}

/**
 * Feed options passed from MCP tool
 */
export interface FeedOptions {
  /**
   * Number of days to look back when collecting historical data
   * Default: 365 (1 year)
   */
  lookback_days?: number;

  // Platform-specific options defined in each feed
  [key: string]: any;
}

/**
 * Consolidated environment bindings used across the platform.
 * This is the single source of truth for environment variable types.
 */
export interface Env {
  // Environment
  ENVIRONMENT: string;
  MAX_CONSECUTIVE_FAILURES?: string;
  DATABASE_URL?: string;
  PUBLIC_LOGO_URL?: string;
  PUBLIC_LEGAL_URL?: string;

  // Space- or comma-separated list of origins allowed to iframe the SPA.
  // Applied as `Content-Security-Policy: frame-ancestors 'self' <list>` on
  // HTML responses. Defaults to `https://lobu.ai https://*.lobu.ai` when unset.
  FRAME_ANCESTORS?: string;

  // Sync intervals
  DEFAULT_SYNC_INTERVAL_MS?: string;
  DEFAULT_SYNC_INTERVAL_HOURS?: string;
  DEFAULT_SYNC_INTERVAL_X_MS?: string;
  DEFAULT_SYNC_INTERVAL_REDDIT_MS?: string;
  DEFAULT_SYNC_INTERVAL_GITHUB_MS?: string;

  // API Credentials
  GITHUB_TOKEN?: string; // GitHub API token for connectors
  X_USERNAME?: string; // X/Twitter username for scraping
  X_PASSWORD?: string; // X/Twitter password for scraping
  X_EMAIL?: string; // X/Twitter email for scraping
  X_2FA_SECRET?: string; // X/Twitter TOTP secret for 2FA (base32 encoded)
  X_COOKIES?: string; // X/Twitter JSON cookies for cookie-based auth (recommended)
  GOOGLE_MAPS_API_KEY?: string; // Google Maps API key
  REDDIT_CLIENT_ID?: string; // Reddit API client ID
  REDDIT_CLIENT_SECRET?: string; // Reddit API client secret
  REDDIT_USER_AGENT?: string; // Reddit API user agent
  JWT_SECRET?: string; // JWT secret for signing window tokens
  WORKER_API_TOKEN?: string; // Optional shared token for internal worker endpoints
  ANTHROPIC_API_KEY?: string; // Anthropic API key

  // Embeddings
  EMBEDDINGS_SERVICE_URL?: string; // Embeddings service base URL
  EMBEDDINGS_SERVICE_TOKEN?: string; // Optional auth token for embeddings service
  EMBEDDINGS_MODEL?: string; // Embeddings model name
  EMBEDDINGS_DIMENSIONS?: string; // Embeddings vector dimensions
  EMBEDDINGS_TIMEOUT_MS?: string; // Optional timeout for embeddings requests

  // Better-Auth Configuration
  BETTER_AUTH_SECRET?: string; // Session signing secret
  GITHUB_CLIENT_ID?: string; // GitHub OAuth client ID
  GITHUB_CLIENT_SECRET?: string; // GitHub OAuth client secret
  GOOGLE_CLIENT_ID?: string; // Google OAuth client ID
  GOOGLE_CLIENT_SECRET?: string; // Google OAuth client secret
  APPLE_CLIENT_ID?: string; // Apple OAuth client ID
  APPLE_CLIENT_SECRET?: string; // Apple OAuth client secret

  // Transactional email (Resend)
  RESEND_API_KEY?: string; // Resend API key
  EMAIL_FROM_AUTH?: string; // From address for auth emails (magic link, password reset). e.g. "Lobu <auth@lobu.ai>"
  EMAIL_FROM_INVITES?: string; // From address for org invitations. e.g. "Lobu <invites@lobu.ai>"
  EMAIL_REPLY_TO?: string; // Reply-To address, e.g. "support@lobu.ai"
  EMAIL_UNSUBSCRIBE?: string; // List-Unsubscribe header value, e.g. "mailto:unsubscribe@lobu.ai"

  // WhatsApp OTP (Twilio)
  TWILIO_SID?: string; // Twilio account SID
  TWILIO_TOKEN?: string; // Twilio auth token
  TWILIO_WHATSAPP_NUMBER?: string; // Twilio WhatsApp number

  // Allow any other env vars accessed via c.env[key]
  [key: string]: string | undefined;
}

/**
 * Base session state type - feeds define their own specific types
 * Values can come from env vars (defaults) or DB (per-connection overrides)
 * At runtime, DB values override env defaults
 */
export type SessionState = Record<string, any>;

