import { createLogger } from "@lobu/core";

const logger = createLogger("grant-store");

export interface Grant {
  pattern: string;
  expiresAt: number | null; // Absolute timestamp (ms). null = never expires.
  grantedAt: number;
  denied?: boolean; // true = explicitly deny this pattern
}

const KEY_PREFIX = "grant:";

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
    const key = this.buildKey(agentId, pattern);
    const value = JSON.stringify({
      expiresAt,
      grantedAt: Date.now(),
      ...(denied && { denied: true }),
    });

    try {
      if (expiresAt === null) {
        await this.redis.set(key, value);
      } else {
        const ttlSeconds = Math.max(
          1,
          Math.ceil((expiresAt - Date.now()) / 1000)
        );
        await this.redis.set(key, value, "EX", ttlSeconds);
      }
      logger.info("Granted access", { agentId, pattern, expiresAt });
    } catch (error) {
      logger.error("Failed to grant access", { agentId, pattern, error });
      throw error;
    }
  }

  /**
   * Parse a raw Redis value into its stored object.
   * Returns null if the value is missing or malformed.
   */
  private parseValue(
    raw: string | null
  ): { expiresAt: number | null; grantedAt: number; denied?: boolean } | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Check if an agent has a grant for a pattern.
   * Checks exact match first, then wildcard parents.
   * Returns false if the grant has `denied: true`.
   */
  async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    // Exact match
    const exactKey = this.buildKey(agentId, pattern);
    try {
      const parsed = this.parseValue(await this.redis.get(exactKey));
      if (parsed) return !parsed.denied;
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
          const parsed = this.parseValue(await this.redis.get(wildcardKey));
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
        const wildcardDomain = `*.${parts.slice(1).join(".")}`;
        const wildcardKey = this.buildKey(agentId, wildcardDomain);
        try {
          const parsed = this.parseValue(await this.redis.get(wildcardKey));
          if (parsed) return !parsed.denied;
        } catch (error) {
          logger.error("Failed to check wildcard domain grant", {
            agentId,
            pattern: wildcardDomain,
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
    const key = this.buildKey(agentId, pattern);
    try {
      const parsed = this.parseValue(await this.redis.get(key));
      return parsed?.denied === true;
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
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          100
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          const values = await this.redis.mget(...keys);
          for (let i = 0; i < keys.length; i++) {
            const val = values[i];
            if (!val) continue;

            try {
              const parsed = JSON.parse(val);
              const pattern = (keys[i] as string).substring(prefix.length);
              grants.push({
                pattern,
                expiresAt: parsed.expiresAt ?? null,
                grantedAt: parsed.grantedAt,
                ...(parsed.denied && { denied: true }),
              });
            } catch {
              // Skip malformed entries
            }
          }
        }
      } while (cursor !== "0");
    } catch (error) {
      logger.error("Failed to list grants", { agentId, error });
    }

    return grants;
  }

  /**
   * Revoke a grant for an agent.
   */
  async revoke(agentId: string, pattern: string): Promise<void> {
    const key = this.buildKey(agentId, pattern);
    try {
      await this.redis.del(key);
      logger.info("Revoked grant", { agentId, pattern });
    } catch (error) {
      logger.error("Failed to revoke grant", { agentId, pattern, error });
      throw error;
    }
  }

  private buildKey(agentId: string, pattern: string): string {
    return `${KEY_PREFIX}${agentId}:${pattern}`;
  }
}
