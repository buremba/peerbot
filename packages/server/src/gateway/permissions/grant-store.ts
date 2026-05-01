import {
  createLogger,
  inferGrantKind,
  normalizeDomainPattern,
  type Grant,
  type GrantKind,
} from "@lobu/core";
import { getDb, pgTextArray } from "../../db/client.js";

const logger = createLogger("grant-store");

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

interface GrantRow {
  pattern: string;
  kind: GrantKind;
  granted_at: Date;
  expires_at: Date | null;
  denied: boolean;
}

/**
 * Unified grant store for URL-pattern permissions.
 *
 * Patterns can be:
 *   - Domain: "api.openai.com", "*.npmjs.org"
 *   - MCP tool: "/mcp/gmail/tools/send_email"
 *   - MCP wildcard: "/mcp/gmail/tools/*"
 *
 * Backed by `public.grants` with per-(agent_id, kind, pattern) rows.
 * Wildcard expansion happens at read time in `hasGrant`. Expired rows are
 * filtered by `expires_at` and swept by the periodic cleanup task.
 */
export class GrantStore {
  /**
   * Grant access to a pattern for an agent.
   * If expiresAt is null, the grant never expires.
   * If denied is true, the grant explicitly denies access.
   */
  async grant(
    agentId: string,
    pattern: string,
    expiresAt: number | null,
    denied?: boolean
  ): Promise<void> {
    pattern = normalizeDomainPattern(pattern);
    const kind = inferGrantKind(pattern);
    const expiresAtTs = expiresAt === null ? null : new Date(expiresAt);

    const sql = getDb();
    await sql`
      INSERT INTO grants (agent_id, kind, pattern, expires_at, granted_at, denied)
      VALUES (${agentId}, ${kind}, ${pattern}, ${expiresAtTs}, now(), ${denied ?? false})
      ON CONFLICT (agent_id, kind, pattern) DO UPDATE SET
        expires_at = EXCLUDED.expires_at,
        granted_at = EXCLUDED.granted_at,
        denied = EXCLUDED.denied
    `;
    logger.info("Granted access", { agentId, pattern, expiresAt });
  }

  /**
   * Check if an agent has a grant for a pattern.
   * Checks exact match first, then wildcard parents.
   * Returns false if the matched grant has `denied: true`.
   */
  async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    pattern = normalizeDomainPattern(pattern);
    const kind = inferGrantKind(pattern);

    // Build the candidate pattern set (exact + wildcards) and look them
    // up in a single query.
    const candidates: string[] = getDomainGrantCandidates(pattern);

    // MCP wildcard: "/mcp/gmail/tools/send_email" is covered by
    // "/mcp/gmail/tools/*".
    if (kind === "mcp_tool") {
      const lastSlash = pattern.lastIndexOf("/");
      if (lastSlash > 0) {
        candidates.push(`${pattern.substring(0, lastSlash)}/*`);
      }
    }

    // Domain wildcard: "sub.example.com" is covered by "*.example.com" or
    // ".example.com".
    if (kind === "domain") {
      const parts = pattern.split(".");
      if (parts.length > 2) {
        const tail = parts.slice(1).join(".");
        candidates.push(normalizeDomainPattern(`.${tail}`));
        candidates.push(normalizeDomainPattern(`*.${tail}`));
      }
    }

    const sql = getDb();
    try {
      const rows = await sql<GrantRow>`
        SELECT pattern, granted_at, expires_at, denied
        FROM grants
        WHERE agent_id = ${agentId}
          AND kind = ${kind}
          AND pattern = ANY(${pgTextArray(candidates)}::text[])
          AND (expires_at IS NULL OR expires_at > now())
      `;

      if (rows.length === 0) return false;

      // Prefer exact-match (highest specificity); if none, prefer rows in
      // candidate order — i.e. earlier candidates beat later ones. This makes
      // the wildcard precedence deterministic regardless of row insertion
      // order.
      const exact = rows.find((r) => r.pattern === pattern);
      if (exact) return !exact.denied;
      for (const candidate of candidates) {
        const match = rows.find((r) => r.pattern === candidate);
        if (match) return !match.denied;
      }
      return !rows[0]?.denied;
    } catch (error) {
      logger.error("Failed to check grant", { agentId, pattern, error });
      return false;
    }
  }

  /**
   * Check if a pattern is explicitly denied for an agent.
   */
  async isDenied(agentId: string, pattern: string): Promise<boolean> {
    pattern = normalizeDomainPattern(pattern);
    const kind = inferGrantKind(pattern);
    const candidates = getDomainGrantCandidates(pattern);

    const sql = getDb();
    try {
      const rows = await sql<{ denied: boolean }>`
        SELECT denied
        FROM grants
        WHERE agent_id = ${agentId}
          AND kind = ${kind}
          AND pattern = ANY(${pgTextArray(candidates)}::text[])
          AND (expires_at IS NULL OR expires_at > now())
          AND denied = true
        LIMIT 1
      `;
      return rows.length > 0;
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
   */
  async listGrants(agentId: string): Promise<Grant[]> {
    const sql = getDb();
    try {
      const rows = await sql<GrantRow>`
        SELECT pattern, kind, granted_at, expires_at, denied
        FROM grants
        WHERE agent_id = ${agentId}
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY granted_at DESC
      `;

      return rows.map((row) => ({
        pattern: row.pattern,
        kind: row.kind,
        expiresAt: row.expires_at ? row.expires_at.getTime() : null,
        grantedAt: row.granted_at.getTime(),
        ...(row.denied && { denied: true }),
      }));
    } catch (error) {
      logger.error("Failed to list grants", { agentId, error });
      return [];
    }
  }

  /**
   * Revoke a grant for an agent.
   */
  async revoke(agentId: string, pattern: string): Promise<void> {
    const candidates = getDomainGrantCandidates(pattern);
    const kind = inferGrantKind(pattern);
    const sql = getDb();
    await sql`
      DELETE FROM grants
      WHERE agent_id = ${agentId}
        AND kind = ${kind}
        AND pattern = ANY(${pgTextArray(candidates)}::text[])
    `;
    logger.info("Revoked grant", { agentId, pattern });
  }
}

/**
 * Sweep expired grants. Cheap because of the partial expires_at index;
 * safe to call from a periodic background timer.
 */
export async function sweepExpiredGrants(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM grants WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING agent_id
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
