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
  ConnectorRuntimeInfo,
  ContentItem,
  EntityIdentitySpec,
  EntityLinkOverride,
  EntityLinkOverrides,
  EntityLinkRule,
  EntityTraitSpec,
  EventEnvelope,
  Feed,
  FeedDefinition,
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
export type { ReactionContext } from './reaction-sdk.js';
export type { ReactionClient } from './reaction-client-types.js';
export type {
  EntityCreateInput,
  EntityLinkInput,
  EntityListFilter,
  EntityUpdateInput,
  KnowledgeReadInput,
  KnowledgeSaveInput,
  KnowledgeSearchInput,
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
