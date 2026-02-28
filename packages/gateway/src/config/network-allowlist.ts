import { createLogger } from "@lobu/core";

const logger = createLogger("network-allowlist");

/**
 * Load allowed domains from environment
 *
 * Behavior:
 * - Not set: Complete isolation (deny all)
 * - "*": Unrestricted access (allow all)
 * - "domain1,domain2": Allowlist mode (deny by default, allow only these)
 */
export function loadAllowedDomains(): string[] {
  const domains: string[] = [];

  const allowedDomains = process.env.WORKER_ALLOWED_DOMAINS;
  if (allowedDomains) {
    const trimmed = allowedDomains.trim();

    // Special case: * means unrestricted access
    if (trimmed === "*") {
      logger.info("🌐 WORKER_ALLOWED_DOMAINS=* - unrestricted internet access");
      return ["*"];
    }

    const parsed = trimmed
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    domains.push(...parsed);
    logger.info(
      `🔒 Loaded ${parsed.length} allowed domains from WORKER_ALLOWED_DOMAINS`
    );
  } else {
    logger.warn(
      "⚠️  WORKER_ALLOWED_DOMAINS not set - workers will have NO internet access (complete isolation)"
    );
  }

  return domains;
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
  const domains: string[] = [];

  const disallowedDomains = process.env.WORKER_DISALLOWED_DOMAINS;
  if (disallowedDomains) {
    const parsed = disallowedDomains
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    domains.push(...parsed);
    logger.info(
      `Loaded ${parsed.length} disallowed domains from WORKER_DISALLOWED_DOMAINS`
    );
  }

  return domains;
}
