import { createLogger, normalizeDomainPatterns } from "@lobu/core";
import { isUnrestrictedMode } from "@lobu/connector-sdk/egress-policy";

const logger = createLogger("network-allowlist");

/**
 * Parse the Sentry ingest host from SENTRY_DSN, e.g.
 * `https://<key>@o123.ingest.de.sentry.io/456` → `o123.ingest.de.sentry.io`.
 *
 * Worker subprocesses report provider/model failures to Sentry via the gateway
 * proxy (HTTP_PROXY), so the proxy must admit this host or the capture POSTs
 * are silently 403'd. We add the EXACT host (not a wildcard) so widening the
 * allowlist for telemetry can't be abused to reach arbitrary `*.sentry.io`.
 *
 * Returns null when no DSN is configured (nothing to allow) or it can't be
 * parsed (fail closed — don't punch a hole for a malformed value).
 */
function getSentryIngestHost(): string | null {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  try {
    return new URL(dsn).hostname.toLowerCase() || null;
  } catch {
    logger.warn("SENTRY_DSN is set but not a valid URL — not allowlisting it");
    return null;
  }
}

/**
 * Load allowed domains from environment
 *
 * Rules:
 * - Not set: Complete isolation (deny all)
 * - "*": Unrestricted access (allow all)
 * - "domain1,domain2": Allowlist mode (deny by default, allow only these)
 *
 * When SENTRY_DSN is configured, the Sentry ingest host is appended to the
 * allowlist so worker telemetry (provider/model failure captures) can leave
 * via the gateway proxy. This holds even in complete-isolation mode: only the
 * single Sentry host is added, everything else stays denied. In unrestricted
 * (`*`) mode no addition is needed.
 */
export function loadAllowedDomains(): string[] {
  const sentryHost = getSentryIngestHost();
  const allowedDomains = process.env.WORKER_ALLOWED_DOMAINS;
  if (!allowedDomains) {
    if (sentryHost) {
      logger.warn(
        `⚠️  WORKER_ALLOWED_DOMAINS not set - workers are network-isolated except the Sentry ingest host (${sentryHost})`
      );
      return [sentryHost];
    }
    logger.warn(
      "⚠️  WORKER_ALLOWED_DOMAINS not set - workers will have NO internet access (complete isolation)"
    );
    return [];
  }

  const trimmed = allowedDomains.trim();

  // Special case: * means unrestricted access (Sentry already reachable).
  if (trimmed === "*") {
    logger.debug("WORKER_ALLOWED_DOMAINS=* - unrestricted internet access");
    return ["*"];
  }

  const parsed =
    normalizeDomainPatterns(
      trimmed
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
    ) ?? [];

  if (sentryHost && !parsed.includes(sentryHost)) {
    parsed.push(sentryHost);
  }

  logger.debug(
    `Loaded ${parsed.length} allowed domains from WORKER_ALLOWED_DOMAINS${
      sentryHost ? " (+ Sentry ingest host)" : ""
    }`
  );
  return parsed;
}

/**
 * Load disallowed domains from environment
 */
export function loadDisallowedDomains(): string[] {
  const disallowedDomains = process.env.WORKER_DISALLOWED_DOMAINS;
  if (!disallowedDomains) return [];

  const parsed =
    normalizeDomainPatterns(
      disallowedDomains
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
    ) ?? [];

  logger.debug(
    `Loaded ${parsed.length} disallowed domains from WORKER_DISALLOWED_DOMAINS`
  );
  return parsed;
}

/**
 * Boot preflight: report when the global allowlist makes EVERY egress judge
 * inert.
 *
 * `checkDomainAccess` (proxy/http-proxy.ts) consults the global allowlist at
 * step 3 and the egress judge only at step 5, so under `WORKER_ALLOWED_DOMAINS=*`
 * every host returns `allowed: true, source: "global"` and no judge is ever
 * asked. That is the worst shape of misconfiguration available here: the
 * request SUCCEEDS, so nothing looks broken, and `logAccessDecision`
 * deliberately drops `allowed && source === "global"` lines, so there is not
 * even a per-request trace to grep. A judge policy an operator wrote and
 * believes is enforcing is silently dead.
 *
 * Reports the state itself, NOT "a judge is being shadowed": whether any agent
 * declares an egress guardrail lives in per-org DB config that changes at
 * runtime, long after boot, so a boot-time check cannot know. This is
 * deliberate — one line at startup is cheap, and gating it on a judge existing
 * would mean the warning never fires for the agent that adds a judge tomorrow.
 *
 * Non-fatal, and returned rather than thrown, mirroring
 * `checkConfiguredJudgeModel`: unrestricted mode is a legitimate deployment
 * choice (`lobu init --network open`; docs/DOCKER.md documents it), so this
 * must never turn into a boot failure.
 */
export function checkJudgeShadowingAllowlist(): string | null {
  // Unset = complete isolation, which shadows no judge. Return before
  // `loadAllowedDomains`, which logs the isolation warning on every call and
  // the proxy has already logged it once at boot.
  if (!process.env.WORKER_ALLOWED_DOMAINS) return null;
  if (!isUnrestrictedMode(loadAllowedDomains())) return null;

  const detail =
    'WORKER_ALLOWED_DOMAINS="*" (unrestricted): the global allowlist admits every host BEFORE the egress judge runs, so any egress judge guardrail on any agent is inert and its denials will never fire. Set an explicit allowlist to let judged domains reach their judge.';
  logger.warn(detail);
  return detail;
}
