import { createLogger, normalizeDomainPatterns } from "@lobu/core";

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
 * Behavior:
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
 * Check if unrestricted mode is enabled
 */
export function isUnrestrictedMode(allowedDomains: string[]): boolean {
  return allowedDomains.length === 1 && allowedDomains[0] === "*";
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
