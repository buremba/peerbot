// =============================================================================
// V1 Integration Platform — Connector SDK
// =============================================================================

// TypeBox (schema authoring convenience)
export type { Static } from '@sinclair/typebox';
export { Type } from '@sinclair/typebox';
// ky (shared HTTP dependency)
export type { KyInstance, Options } from 'ky';
export { default as ky, HTTPError } from 'ky';
// Connector runtime & types (primary API)
export { ConnectorRuntime } from './connector-runtime.js';
export type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  ApprovalStatus,
  AuthArtifact,
  AuthContext,
  AuthResult,
  Connection,
  ConnectorAuthBrowser,
  ConnectorAuthEnvField,
  ConnectorAuthEnvKeys,
  ConnectorAuthInteractive,
  ConnectorAuthMethod,
  ConnectorAuthNone,
  ConnectorAuthOAuth,
  ConnectorAuthSchema,
  ConnectorDefinition,
  ContentItem,
  EntityIdentitySpec,
  EntityLinkOverride,
  EntityLinkOverrides,
  EntityLinkRule,
  EntityTraitSpec,
  EventEnvelope,
  Feed,
  FeedDefinition,
  FeedMode,
  IdentityNamespace,
  Run,
  RunStatus,
  RunType,
  SyncContext,
  SyncCredentials,
  SyncResult,
} from './connector-types.js';
export { IDENTITY } from './connector-types.js';
// Identity-engine SDK contracts. Each schema export is both a TypeBox
// runtime validator (value) AND a TypeScript type via declaration merging.
export {
  AssuranceLevel,
  assuranceMeets,
  AutoCreateWhenRule,
  CLAIM_COLLISION_SEMANTIC_TYPE,
  ClaimCollisionPayload,
  ConnectorFact,
  ConnectorIdentityCapability,
  DerivedFromProvenance,
  DerivedRelationshipMetadata,
  FactEventMetadata,
  IDENTITY_FACT_SEMANTIC_TYPE,
  MatchStrategy,
  RelationshipTypeIdentityMetadata,
} from './identity-types.js';
export { isSourceNativeEventType, SOURCE_NATIVE_EVENT_TYPES } from './event-taxonomy.js';
// HTTP clients
export {
  createAuthenticatedClient,
  createHttpClient,
  httpClient,
  jsonHttpClient,
} from './http.js';
export {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeGithubLogin,
  normalizeGoogleContactId,
  normalizeIdentifier,
  normalizePhone,
  normalizeSlackUserId,
  normalizeWaJid,
} from './identity-normalize.js';
// Logger
export { sdkLogger, sdkLogger as logger } from './logger.js';
// Retry
export { withHttpRetry } from './retry.js';
// Scoring
export { calculateEngagementScore } from './scoring.js';
export type { WatcherTimeGranularity } from './watcher-time.js';
export {
  addWatcherPeriod,
  alignToWatcherWindowStart,
  getAvailableWatcherGranularities,
  getFinerWatcherGranularities,
  getNextWatcherGranularity,
  getWatcherDateTruncUnit,
  inferWatcherGranularityFromDays,
  inferWatcherGranularityFromSchedule,
  isWatcherTimeGranularity,
  shiftWatcherPeriod,
  subtractWatcherPeriod,
  WATCHER_TIME_GRANULARITIES,
} from './watcher-time.js';

// =============================================================================
// Feed SDK
// =============================================================================

export type { ApiSessionState } from './api-paginated.js';
export { ApiPaginatedFeed } from './api-paginated.js';
export { BaseFeed, RateLimitError } from './base.js';
export type { AcquireBrowserOptions, AcquiredBrowser } from './browser/acquire.js';
export { acquireBrowser, BrowserAuthCascadeError } from './browser/acquire.js';
export type { CdpVersionInfo, ResolveCdpOptions } from './browser/cdp.js';
export {
  discoverChromeListeningPorts,
  discoverChromeProcessCdpUrls,
  fetchCdpVersionInfo,
  normalizeCdpUrl,
  resolveCdpUrl,
  tryWebSocketCdp,
} from './browser/cdp.js';
export { CdpPage } from './browser/cdp-page.js';
export type { BrowserLaunchOptions, EnhancedBrowser } from './browser/launcher.js';
export {
  captureErrorArtifacts,
  launchBrowser,
  withErrorCapture,
} from './browser/launcher.js';
export type { StealthBrowser, StealthBrowserOptions } from './browser/stealth.js';
export {
  getRandomDelay,
  humanWait,
  launchStealthBrowser,
  randomScroll,
  testBotDetection,
} from './browser/stealth.js';
export type { BrowserNetworkConfig, BrowserNetworkResult } from './browser-network.js';
export { browserNetworkSync } from './browser-network.js';
export type {
  BrowserFeedConfig,
  BrowserPaginationConfig,
  BrowserSessionState,
  CaptchaConfig,
  CookieConsentConfig,
} from './browser-paginated.js';
export { BrowserPaginatedFeed } from './browser-paginated.js';
export type {
  PageFetchResult,
  PaginatedCheckpoint,
  PaginateResult,
  PaginationConfig,
} from './paginated.js';
export { PaginatedFeed } from './paginated.js';
export type { ReactionContext, ReactionEntity } from './reaction-sdk.js';
export type {
  Checkpoint,
  Content,
  Env,
  FeedAuthBrowserMethod,
  FeedAuthEnvField,
  FeedAuthEnvKeysMethod,
  FeedAuthMethod,
  FeedAuthNoneMethod,
  FeedAuthOAuthMethod,
  FeedAuthSchema,
  FeedOptions,
  FeedSyncResult,
  IFeed,
  ParentFeedDefinition,
  ScoringConfig,
  SearchResult,
  SessionState,
} from './types.js';
