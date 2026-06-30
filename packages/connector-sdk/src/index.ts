// =============================================================================
// V1 Integration Platform — Connector SDK
// =============================================================================

// TypeBox (schema authoring convenience for connector definitions / fact
// schemas). NOTE: do NOT import these into a watcher reaction — bundling
// typebox into the isolate breaks the SDK client proxy (see
// reaction-execute-typebox.test.ts). A reaction declares its `input` as a
// PLAIN JSON Schema object; the host validates `ctx.extracted_data` against it.
export type { Static } from '@sinclair/typebox';
export { Type } from '@sinclair/typebox';
export { Value } from '@sinclair/typebox/value';
// ky (shared HTTP dependency)
export type { KyInstance, Options } from 'ky';
export { default as ky, HTTPError } from 'ky';
// Connector runtime & types (primary API)
export {
  BridgeOnlyConnector,
  ConnectorRuntime,
  IntegrationConnector,
} from './connector-runtime.js';
export { defineConnector } from './define-connector.js';
export { validateEntityMetrics } from './metrics.js';
// Entity-bound metric layer contract (shared by CLI authoring + server
// compile/validate; lives here to satisfy config-isolation — see metrics.ts)
export type {
  Dimension,
  EntityMetrics,
  EventSet,
  FactMatchRule,
  Measure,
  MetricReadMode,
  MetricTier,
  Segment,
} from './metrics.js';
export type {
  ConnectorActionSpec,
  ConnectorClass,
  ConnectorFeedSpec,
  ConnectorSpec,
} from './define-connector.js';
export type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  ApprovalStatus,
  AuthArtifact,
  AuthContext,
  AuthResult,
  Connection,
  ConnectorAuthAppInstallation,
  ConnectorAuthBrowser,
  ConnectorAuthEnvField,
  ConnectorAuthEnvKeys,
  ConnectorAuthInteractive,
  ConnectorAuthMethod,
  ConnectorAuthNone,
  ConnectorAuthOAuth,
  ConnectorAuthSchema,
  ConnectorDefinition,
  ConnectorInstallationContext,
  ConnectorRuntimeInfo,
  ConnectorWebhookSchema,
  ContentItem,
  EntityIdentitySpec,
  EntityLinkOverride,
  EntityLinkOverrides,
  EntityLinkPredicate,
  EntityLinkRule,
  EntityTraitSpec,
  EventEnvelope,
  Feed,
  FeedDefinition,
  EntityTypeContribution,
  IdentityNamespace,
  QueryContext,
  QueryResult,
  ReflectContext,
  ReflectedMeasure,
  ReflectResult,
  Run,
  RunStatus,
  RunType,
  SearchContext,
  SyncContext,
  SyncCredentials,
  SyncResult,
  WebhookRegistration,
  WebhookRegistrationContext,
} from './connector-types.js';
export { IDENTITY } from './connector-types.js';
// Identity-engine SDK contracts. Each schema export is both a TypeBox
// runtime validator (value) AND a TypeScript type via declaration merging.
// We import then re-export locally instead of `export { … } from
// './identity-types.js'`: bun's ESM linker (macOS + node26 + bun 1.3.5)
// intermittently fails to resolve a name through a large transitive
// re-export barrel, surfacing as a flaky `Export named 'X' not found in
// dist/index.js` under concurrent test load (issue #976). A local export
// list links against the already-bound import.
import {
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
  RelationshipTypeIdentityMetadata,
} from './identity-types.js';
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
  RelationshipTypeIdentityMetadata,
};
export {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeGithubLogin,
  normalizeGithubRepoFullName,
  normalizeGoogleContactId,
  normalizeNumericId,
  normalizeIdentifier,
  normalizePhone,
  normalizeSlackUserId,
  normalizeSlackUserIdCombined,
  normalizeWaJid,
} from './identity-normalize.js';
// HTTP client (auth + retry + 429 Retry-After)
export type {
  CreateHttpClientOptions,
  HttpClient,
  RequireBearerClientOptions,
} from './http-client.js';
export { createHttpClient, HttpStatusError, requireBearerClient } from './http-client.js';
// Logger
export { sdkLogger, sdkLogger as logger } from './logger.js';
// Pagination generators
export type {
  CursorPage,
  OffsetPage,
  PaginateByCursorOptions,
  PaginateByOffsetOptions,
} from './pagination.js';
export { paginateByCursor, paginateByOffset } from './pagination.js';
// Nix package-name sanitizer (shared by gateway orchestrator + connector-worker)
export { nixPackageAttrRef } from './nix-package.js';
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
// Browser SDK
// =============================================================================

export type { AcquireBrowserOptions, AcquiredBrowser } from './browser/acquire.js';
export { acquireBrowser, BrowserAuthCascadeError } from './browser/acquire.js';
export type { CdpVersionInfo, ResolveCdpOptions } from './browser/cdp.js';
export {
  fetchCdpVersionInfo,
  resolveCdpUrl,
} from './browser/cdp.js';
export { CdpPage } from './browser/cdp-page.js';
export type { BrowserLaunchOptions, EnhancedBrowser } from './browser/launcher.js';
export {
  captureErrorArtifacts,
  launchBrowser,
} from './browser/launcher.js';
export type { BrowserNetworkConfig, BrowserNetworkResult } from './browser-network.js';
export { browserNetworkSync } from './browser-network.js';
export type {
  ExtensionDomScrapeResult,
  ExtensionScrapeConfig,
  ExtensionScrapeObservation,
  ExtensionScrapeResult,
} from './extension-dom-scrape.js';
export { extensionDomScrape } from './extension-dom-scrape.js';
export type {
  ChromeActionDispatcher,
  ChromeActionInput,
  ChromeActionOutput,
  ExtensionNetworkConfig,
  ExtensionNetworkPattern,
  ExtensionNetworkResult,
  InterceptedResponse,
  NavigateObservation,
  NetworkInterceptDrainObservation,
  NetworkInterceptStartObservation,
} from './extension-network.js';
export { extensionNetworkSync } from './extension-network.js';
export type { ReactionContext } from './reaction-sdk.js';
export type { ReactionClient } from './reaction-client-types.js';
export type {
  CardElement,
  EntityCreateInput,
  EntityLinkInput,
  EntityListFilter,
  EntityUpdateInput,
  KnowledgeReadInput,
  KnowledgeSaveInput,
  KnowledgeSearchInput,
  NotificationsSendInput,
} from './reaction-client-types.js';
export type { Env } from './types.js';

// =============================================================================
// FileSystemSource — reusable primitive for filesystem-shape ingestion sources
// =============================================================================

export type { FileDelta, FileSystemSource, Snapshot } from './file-source.js';
export { fileSystemSourceFromUri } from './file-source.js';
export { GitFileSource, parseGitUri } from './sources/git-file-source.js';
export type { TarballFileSourceOptions } from './sources/tarball-file-source.js';
export { TarballFileSource } from './sources/tarball-file-source.js';
export { LocalFileSource } from './sources/local-file-source.js';
