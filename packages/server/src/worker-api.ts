/**
 * Worker API Endpoints
 *
 * HTTP handlers for worker operations.
 * Updated for V1 integration platform: runs-based job model.
 *
 * This barrel re-exports all handlers from the worker-api/ subdirectory.
 * Routes are registered in packages/server/src/index.ts.
 */

// Polling (device registration + run claiming)
export { pollWorkerJob } from './worker-api/poll';

// Run lifecycle (heartbeat, stream, complete, watcher/auth/action/embedding)
export {
  heartbeat,
  streamContent,
  completeWorkerJob,
  completeWatcherRun,
  completeEmbeddings,
  fetchEventsForEmbedding,
  emitAuthArtifact,
  pollAuthSignal,
  completeAuthRun,
  completeActionRun,
} from './worker-api/run-lifecycle';

// UI-facing auth run endpoints (session-auth, not worker-token)
export { getActiveAuthRun, getAuthRun, postAuthSignal } from './worker-api/auth-runs';

// Device worker management (mcpAuth, /api/me/devices/*)
export {
  listDeviceWorkers,
  mintDeviceChildToken,
  updateDeviceWorkerOrg,
  deleteDeviceWorker,
} from './worker-api/device-management';

// Device-scoped browser auth profiles (/api/workers/me/auth-profiles/*)
export {
  listMyDeviceAuthProfiles,
  createMyDeviceAuthProfile,
  deleteMyDeviceAuthProfile,
} from './worker-api/device-auth-profiles';

// Device-scoped feed CRUD (/api/workers/me/feeds/*)
export { listMyDeviceFeeds, createMyDeviceFeed, deleteMyDeviceFeed } from './worker-api/device-feeds';

// Device watcher trigger (/api/workers/me/watchers/:id/trigger)
export { triggerWatcherForDevice } from './worker-api/watcher-trigger';
