import {
  createLogger,
  getJsonValue,
  mgetJsonValues,
  normalizeDomainPattern,
  scanKeysByPattern,
  setJsonValue,
} from "@lobu/core";

const logger = createLogger("grant-store");

interface Grant {
  pattern: string;
  expiresAt: number | null; // Absolute timestamp (ms). null = never expires.
  grantedAt: number;
  denied?: boolean; // true = explicitly deny this pattern
}

const KEY_PREFIX = "grant:";

type StoredGrant = {
  expiresAt: number | null;
  grantedAt: number;
  denied?: boolean;
};

function getDomainGrantCandidates(pattern: string): string[] {
  const normalized = normalizeDomainPattern(pattern);
  if (normalized.startsWith("/")) {
    return [normalized];
  }

  const candidates = new Set<string>([normalized]);
  if (normalized.startsWith(".")) {
    candidates.add(`*.${normalized.slice(1)}`);
  }

  return [...candidates];
}

/**
 * Unified grant store for URL-pattern permissions.
 *
 * Patterns can be:
 *   - Domain: "api.openai.com", "*.npmjs.org"
 *   - MCP tool: "/mcp/gmail/tools/send_email"
 *   - MCP wildcard: "/mcp/gmail/tools/*"
 *
 * Grants are stored in Redis with TTL matching expiresAt for automatic cleanup.
 */
export class GrantStore {
  constructor(private readonly redis: any) {}

  /**
   * Grant access to a pattern for an agent.
   * If expiresAt is null, the grant never expires (no Redis TTL).
   * If denied is true, the grant explicitly denies access.
   */
  async grant(
    agentId: string,
    pattern: string,
    expiresAt: number | null,
    denied?: boolean
  ): Promise<void> {
    pattern = normalizeDomainPattern(pattern);
    const key = this.buildKey(agentId, pattern);
    const value: StoredGrant = {
      expiresAt,
      grantedAt: Date.now(),
      ...(denied && { denied: true }),
    };

    if (expiresAt === null) {
      await setJsonValue(this.redis, key, value);
    } else {
      const ttlSeconds = Math.max(
        1,
        Math.ceil((expiresAt - Date.now()) / 1000)
      );
      await setJsonValue(this.redis, key, value, ttlSeconds);
    }
    logger.info("Granted access", { agentId, pattern, expiresAt });
  }

  private async getStoredGrant(key: string): Promise<StoredGrant | null> {
    return getJsonValue<StoredGrant>(this.redis, key);
  }

  /**
   * Check if an agent has a grant for a pattern.
   * Checks exact match first, then wildcard parents.
   * Returns false if the grant has `denied: true`.
   */
  async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    pattern = normalizeDomainPattern(pattern);
    // Exact match
    try {
      for (const candidate of getDomainGrantCandidates(pattern)) {
        const exactKey = this.buildKey(agentId, candidate);
        const parsed = await this.getStoredGrant(exactKey);
        if (parsed) return !parsed.denied;
      }
    } catch (error) {
      logger.error("Failed to check grant", { agentId, pattern, error });
      return false;
    }

    // Wildcard check for MCP tool patterns:
    // "/mcp/gmail/tools/send_email" is covered by "/mcp/gmail/tools/*"
    if (pattern.startsWith("/mcp/")) {
      const lastSlash = pattern.lastIndexOf("/");
      if (lastSlash > 0) {
        const wildcardPattern = `${pattern.substring(0, lastSlash)}/*`;
        const wildcardKey = this.buildKey(agentId, wildcardPattern);
        try {
          const parsed = await this.getStoredGrant(wildcardKey);
          if (parsed) return !parsed.denied;
        } catch (error) {
          logger.error("Failed to check wildcard grant", {
            agentId,
            pattern: wildcardPattern,
            error,
          });
        }
      }
    }

    // Wildcard check for domain patterns:
    // "sub.example.com" is covered by "*.example.com"
    if (!pattern.startsWith("/")) {
      const parts = pattern.split(".");
      if (parts.length > 2) {
        const wildcardDomains = [
          `.${parts.slice(1).join(".")}`,
          `*.${parts.slice(1).join(".")}`,
        ];
        try {
          for (const wildcardDomain of wildcardDomains) {
            const wildcardKey = this.buildKey(
              agentId,
              normalizeDomainPattern(wildcardDomain)
            );
            const parsed = await this.getStoredGrant(wildcardKey);
            if (parsed) return !parsed.denied;
          }
        } catch (error) {
          logger.error("Failed to check wildcard domain grant", {
            agentId,
            pattern,
            error,
          });
        }
      }
    }

    return false;
  }

  /**
   * Check if a pattern is explicitly denied for an agent.
   */
  async isDenied(agentId: string, pattern: string): Promise<boolean> {
    try {
      for (const candidate of getDomainGrantCandidates(pattern)) {
        const key = this.buildKey(agentId, candidate);
        const parsed = await this.getStoredGrant(key);
        if (parsed?.denied === true) {
          return true;
        }
      }
      return false;
    } catch (error) {
      logger.error("Failed to check denied grant", {
        agentId,
        pattern,
        error,
      });
      return false;
    }
  }

  /**
   * List all active grants for an agent.
   * Uses Redis SCAN to find matching keys.
   */
  async listGrants(agentId: string): Promise<Grant[]> {
    const prefix = `${KEY_PREFIX}${agentId}:`;
    const grants: Grant[] = [];

    try {
      const keys = await scanKeysByPattern(this.redis, `${prefix}*`);
      const values = await mgetJsonValues<StoredGrant>(this.redis, keys);

      for (let i = 0; i < keys.length; i++) {
        const parsed = values[i];
        if (!parsed) continue;

        const pattern = (keys[i] as string).substring(prefix.length);
        grants.push({
          pattern,
          expiresAt: parsed.expiresAt ?? null,
          grantedAt: parsed.grantedAt,
          ...(parsed.denied && { denied: true }),
        });
      }
    } catch (error) {
      logger.error("Failed to list grants", { agentId, error });
    }

    return grants;
  }

  /**
   * Revoke a grant for an agent.
   */
  async revoke(agentId: string, pattern: string): Promise<void> {
    const candidates = getDomainGrantCandidates(pattern);
    await this.redis.del(
      ...candidates.map((candidate) => this.buildKey(agentId, candidate))
    );
    logger.info("Revoked grant", { agentId, pattern });
  }

  private buildKey(agentId: string, pattern: string): string {
    return `${KEY_PREFIX}${agentId}:${pattern}`;
  }
}
