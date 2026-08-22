// =============================================================================
// V1 Integration Platform — Connector SDK
// =============================================================================

// TypeBox (schema authoring convenience for connector definitions / fact
// schemas). NOTE: do NOT import these into an automation reaction — bundling
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
export {
  canonicalDeviceManifestJson,
  defineDeviceConnector,
  deviceManifestHash,
  serializeDeviceConnector,
  sortDeviceManifestJson,
} from './device-manifest.js';
export type {
  DeviceActionDefinition,
  DeviceConnectorDefinition,
  DeviceConnectorManifest,
  DeviceConnectorRuntimeInfo,
  DeviceConnectorSpec,
  DeviceFeedDefinition,
  DeviceManifestSchema,
} from './device-manifest.js';
import { validateEntityMetrics } from './metrics.js';
export { validateEntityMetrics };
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
  ConnectorAgentTooling,
  ConnectorAgentToolingEnv,
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
  EntityLinkPredicate,
  EntityTraitSpec,
  EventAttributionRole,
  EventAttributionRule,
  EventAttributionTargetSpec,
  EventEnvelope,
  Feed,
  FeedDefinition,
  EntityTypeContribution,
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
import {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeEmailDomain,
  normalizeIdentifier,
  normalizePhone,
} from './identity-normalize.js';
export {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeEmailDomain,
  normalizeIdentifier,
  normalizePhone,
};
export type {
  IdentityNamespace,
  IdentityNamespaceDefinition,
  IdentityNormalizerKind,
  IdentitySubjectKind,
} from './identity-namespaces.js';
export type {
  AccessIdentitySpec,
  AccessMember,
  AccessResource,
  AclSourceDef,
  ChannelReadIdentity,
} from './acl-source.js';
export {
  ACL_RESOURCE_TYPE,
  ACL_RESOURCE_TYPE_SLUG,
} from './acl-source.js';
import {
  EVENT_RECALL_IDENTITY_NAMESPACES,
  getIdentityNamespaceDefinition,
  IDENTITY,
  IDENTITY_NAMESPACE_REGISTRY,
  isEventRecallIdentityNamespace,
} from './identity-namespaces.js';
export {
  EVENT_RECALL_IDENTITY_NAMESPACES,
  getIdentityNamespaceDefinition,
  IDENTITY,
  IDENTITY_NAMESPACE_REGISTRY,
  isEventRecallIdentityNamespace,
};
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
export {
  ConnectorAutomationEventSchema,
  ConnectorAutomationSignalDraftSchema,
  SubscriptionCandidateSchema,
} from './automation-triggers.js';
export type {
  AutomationEventTrigger,
  AutomationScheduleTrigger,
  AutomationTrigger,
  AutomationWorkspaceEventTrigger,
  ConnectorAutomationEvent,
  ConnectorAutomationSignalDraft,
  ConnectorTriggerSignal,
  SubscriptionCandidate,
} from './automation-triggers.js';
export type { AutomationTimeGranularity } from './automation-time.js';
export {
  addAutomationPeriod,
  alignToAutomationWindowStart,
  getAvailableAutomationGranularities,
  getFinerAutomationGranularities,
  getNextAutomationGranularity,
  getAutomationDateTruncUnit,
  inferAutomationGranularityFromDays,
  inferAutomationGranularityFromSchedule,
  isAutomationTimeGranularity,
  shiftAutomationPeriod,
  subtractAutomationPeriod,
  AUTOMATION_TIME_GRANULARITIES,
} from './automation-time.js';

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
export type { ReviewExtractResult, RunReviewScrapeOptions } from './browser/review-scrape.js';
export { handleCookieConsent, runReviewScrape } from './browser/review-scrape.js';
export { applyLookbackCutoff } from './checkpoint/lookback.js';
export {
  buildTimestampCheckpoint,
  filterByCheckpoint,
  finalizeTimestampSync,
} from './checkpoint/timestamp-watermark.js';
export { validatePublicUrl, validateUrlDomain } from './url-guards.js';
export { sleep } from './sleep.js';
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
  KnowledgeSaveResult,
  KnowledgeSearchInput,
  NotificationsSendInput,
  NotificationsSendResult,
  OperationsListRunsInput,
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
