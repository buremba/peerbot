import { createLogger, type NetworkConfig } from "@peerbot/core";

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

// Cache global defaults to avoid repeated parsing
let cachedGlobalAllowed: string[] | null = null;
let cachedGlobalDenied: string[] | null = null;

/**
 * Get cached global defaults (lazy initialization)
 */
function getGlobalDefaults(): {
  allowedDomains: string[];
  deniedDomains: string[];
} {
  if (cachedGlobalAllowed === null) {
    cachedGlobalAllowed = loadAllowedDomains();
  }
  if (cachedGlobalDenied === null) {
    cachedGlobalDenied = loadDisallowedDomains();
  }
  return {
    allowedDomains: cachedGlobalAllowed,
    deniedDomains: cachedGlobalDenied,
  };
}

/**
 * Resolve network configuration by merging per-agent config with global defaults.
 *
 * If agentConfig is provided and has explicit values, use them.
 * Otherwise, fall back to global defaults from environment variables.
 *
 * @param agentConfig - Optional per-agent network configuration
 * @returns Resolved network configuration with both allowedDomains and deniedDomains
 */
export function resolveNetworkConfig(agentConfig?: NetworkConfig): {
  allowedDomains: string[];
  deniedDomains: string[];
} {
  const globalDefaults = getGlobalDefaults();

  // If no agent config provided, use global defaults
  if (!agentConfig) {
    return {
      allowedDomains: globalDefaults.allowedDomains,
      deniedDomains: globalDefaults.deniedDomains,
    };
  }

  // Agent config takes precedence if explicitly provided
  // Note: We check for undefined specifically, as empty array [] is a valid explicit value (means deny all)
  return {
    allowedDomains:
      agentConfig.allowedDomains !== undefined
        ? agentConfig.allowedDomains
        : globalDefaults.allowedDomains,
    deniedDomains:
      agentConfig.deniedDomains !== undefined
        ? agentConfig.deniedDomains
        : globalDefaults.deniedDomains,
  };
}
