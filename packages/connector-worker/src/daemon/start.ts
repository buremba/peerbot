/**
 * Shared device-daemon bootstrap: flag validation + worker registration + the
 * poll loop. Both the `connector-worker` binary and the `lobu daemon` command
 * call this, so the two cannot drift on validation or registration semantics.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { isKnownPlatform } from '@lobu/core';
import { assertExternalDepsResolvable } from '../compile/index.js';
import { buildConnectorWorkerEnv } from '../env.js';
import { assertConnectorRuntimeLoadable } from '../self-check/index.js';
import { DEVICE_MANIFESTS_BY_PLATFORM } from './device-manifests.js';
import { startDaemon, type WorkerDaemon } from './index.js';
import { log, setDebug } from './log.js';
import {
  attachInteractiveSession,
  deriveInteractiveWorkerId,
  detectInteractiveSession,
  type InteractiveSession,
} from './interactive-session.js';

/**
 * Accepted `--worker-id` shape. Deliberately narrow: the default is
 * `<platform>:<short-hostname>` (or a session-derived id in a supported
 * interactive agent), and anything a shell, a URL path, or a JSON payload
 * would mangle has no business being a durable device identity.
 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface DaemonStartOptions {
  apiUrl: string;
  workerId?: string;
  version?: string;
  /** Host platform for device registration (macos, headless, …). */
  platform?: string;
  /** Device default supplied by `lobu daemon`; omitted by fleet worker callers. */
  defaultPlatform?: string;
  label?: string;
  /** Declared capability names (already comma-split). */
  capabilities?: string[];
  /** Durable `owl_pat_…` personal access token for device mode. */
  workerApiToken?: string;
  debug?: boolean;
  /** False only when the operator explicitly disables inherited-session delivery. */
  interactiveSession?: false;
  workerCredentialMaintenance?: (activate: (workerApiToken: string) => void) => Promise<void>;
}

export function resolveDaemonWorkerId(
  opts: Pick<DaemonStartOptions, 'workerId'>,
  platform: string | undefined,
  shortHostname: string,
  interactiveSession?: InteractiveSession
): string {
  return (
    opts.workerId ??
    (interactiveSession
      ? deriveInteractiveWorkerId(interactiveSession)
      : platform
        ? `${platform}:${shortHostname}`
        : `worker-${randomUUID().slice(0, 8)}`)
  );
}

export function resolveDaemonLaunchContext(
  opts: Pick<
    DaemonStartOptions,
    'platform' | 'defaultPlatform' | 'interactiveSession'
  >,
  env: NodeJS.ProcessEnv = process.env,
  sessionsDir?: string
): { platform: string | undefined; interactiveSession: InteractiveSession | undefined } {
  const detected =
    opts.interactiveSession === false
      ? undefined
      : (() => {
          const result = detectInteractiveSession({
            env,
            ...(sessionsDir ? { sessionsDir } : {}),
          });
          return result.ok ? result.session : undefined;
        })();
  if (detected && opts.platform && opts.platform !== 'headless') {
    // Interactive delivery registers a per-session headless device, so it can
    // never also claim the host's own platform identity.
    throw new Error(
      `an inherited interactive agent session registers as --platform headless, so it cannot be combined with --platform ${opts.platform}. Pass --no-interactive-session to register this host as a ${opts.platform} device instead.`
    );
  }
  return {
    platform: detected ? 'headless' : (opts.platform ?? opts.defaultPlatform),
    interactiveSession: detected,
  };
}

/**
 * Validate the options and boot the daemon. Throws a user-facing `Error` on
 * bad input; the caller prints it and exits non-zero.
 */
export async function startDaemonCommand(
  opts: DaemonStartOptions
): Promise<WorkerDaemon> {
  setDebug(opts.debug === true);
  const launch = resolveDaemonLaunchContext(opts);
  const detected = launch.interactiveSession;
  const platform = launch.platform;
  const { capabilities = [] } = opts;

  if (platform && !isKnownPlatform(platform)) {
    throw new Error(`unknown device platform '${platform}'`);
  }
  // `worker_id` is the device's identity: the server upserts on
  // (user_id, worker_id) and Automation pins resolve the device row through it.
  // An unusable value therefore does not fail loudly — it mints a second device
  // and the pinned Automations go quiet on this one. Reject it at boot instead.
  if (opts.workerId !== undefined && !WORKER_ID_PATTERN.test(opts.workerId)) {
    throw new Error(
      `invalid --worker-id '${opts.workerId}': expected 1-128 characters of ` +
        'letters, digits, dot, underscore, colon or hyphen'
    );
  }
  if (capabilities.length > 0 && !platform) {
    throw new Error(
      '--capabilities requires --platform so the server can authorize the device capability set'
    );
  }
  // A device daemon runs for weeks; its bearer is snapshotted once at startup.
  // `lobu whoami --json` returns `workerToken ?? accessToken`, so a user without
  // a durable agent token silently gets the OAuth SESSION token — which expires
  // in 24h. The daemon would then poll 401 forever and every scheduled run
  // would stop with no failure anywhere the user looks. Fail closed at boot.
  if (platform && !opts.workerApiToken?.startsWith('owl_pat_')) {
    throw new Error(
      'device mode requires a durable personal access token in WORKER_API_TOKEN.\n' +
        "       `lobu whoami --json` falls back to your session's OAuth access token, which\n" +
        '       expires within 24h and would leave this daemon polling 401 indefinitely.\n' +
        '       Mint a device token and pass it as WORKER_API_TOKEN (expects an owl_pat_ prefix).'
    );
  }

  // Fleet workers advertise the DB-egress contract by default. Device workers
  // advertise only their declared, server-authorized capabilities.
  const workerCapabilities: Record<string, boolean> = platform
    ? Object.fromEntries(capabilities.map((name) => [name, true]))
    : { db_egress_hardening: true };
  // Headless recovery daemons own the daemon-builtin backend and deliberately
  // keep their compiler/SDK runtime closed; everything else is compiled-capable.
  const backendCapacity: Record<string, number> =
    platform === 'headless'
      ? { daemon_builtin: 1, compiled_connector: 0 }
      : { compiled_connector: 1 };
  // Auto-discover device identity from the host when not passed: a device
  // worker defaults to `<platform>:<short-hostname>` and a hostname label. An
  // interactive daemon instead derives its id from the exact inherited
  // provider session, so each TUI registers its own device rather than stealing
  // the host's. Explicit --worker-id remains authoritative.
  const shortHostname = hostname().split('.')[0] || hostname();
  const workerId = resolveDaemonWorkerId(opts, platform, shortHostname, detected);
  const label = opts.label ?? (platform ? shortHostname : undefined);

  // Crash loud before the first poll if the installed runtime cannot resolve
  // or execute the same connector graph this worker is about to advertise.
  assertExternalDepsResolvable(createRequire(import.meta.url).resolve);
  await assertConnectorRuntimeLoadable();
  log.info(`[cli] Starting worker daemon (ID: ${workerId}, API: ${opts.apiUrl})`);
  const env = buildConnectorWorkerEnv();
  const maxConcurrentJobs = process.env.WORKER_MAX_CONCURRENT_JOBS
    ? Math.max(1, Number.parseInt(process.env.WORKER_MAX_CONCURRENT_JOBS, 10))
    : undefined;
  if (platform) {
    log.info(
      `[cli] device mode: platform=${platform} capabilities=${capabilities.join(',') || '(none)'}`
    );
  }
  if (detected) {
    log.info(
      `[cli] interactive-session delivery enabled for ${detected.kind}`
    );
  }

  const daemonConfig = {
    apiUrl: opts.apiUrl,
    workerId,
    version: opts.version ?? '1.0.0',
    workerApiToken: opts.workerApiToken,
    capabilities: workerCapabilities,
    ...(platform ? { platform } : {}),
    ...(label ? { label } : {}),
    ...(platform ? { manifests: DEVICE_MANIFESTS_BY_PLATFORM[platform] ?? [] } : {}),
    ...(Number.isFinite(maxConcurrentJobs) ? { maxConcurrentJobs } : {}),
    backendCapacity,
    ...(opts.workerCredentialMaintenance
      ? { workerCredentialMaintenance: opts.workerCredentialMaintenance }
      : {}),
    ...(detected
      ? {
          agentKinds: [detected.kind],
          executor: {
            defaultAgentKind: detected.kind,
          }
        }
      : {}),
  };
  if (detected) attachInteractiveSession(daemonConfig, detected);
  return startDaemon(daemonConfig, env);
}
