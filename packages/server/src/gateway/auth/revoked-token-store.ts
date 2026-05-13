import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("revoked-token-store");

/** How long a positive/negative revocation lookup is cached in-process. */
const CACHE_TTL_MS = 60 * 1000;
/** Minimum gap between opportunistic lazy GC sweeps. */
const GC_INTERVAL_MS = 5 * 60 * 1000;

interface CacheEntry {
  revoked: boolean;
  cachedAt: number;
}

/**
 * Revoked-token store: a kill switch for otherwise purely-cryptographic
 * tokens (worker tokens, settings session cookies). Both token types carry
 * a random `jti`; revoking a `jti` blocks every copy of that token until it
 * would have expired anyway.
 *
 * Backed by `public.revoked_tokens(jti text primary key, expires_at
 * timestamptz not null)`. Mirrors the shape of `grant-store.ts`: a Postgres
 * table, a small in-memory TTL cache, and a lazy GC sweep of expired rows.
 * The table is created on first use (embedded deployments have no separate
 * migration step for it).
 */
export class RevokedTokenStore {
  private readonly cache = new Map<string, CacheEntry>();
  private schemaReady: Promise<void> | null = null;
  private lastGcAt = 0;

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      const sql = getDb();
      this.schemaReady = (async () => {
        await sql.unsafe(`
          CREATE TABLE IF NOT EXISTS public.revoked_tokens (
            jti text PRIMARY KEY,
            expires_at timestamptz NOT NULL
          )
        `);
        await sql.unsafe(
          `CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON public.revoked_tokens (expires_at)`
        );
      })().catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }

  /**
   * Revoke a token by its `jti`. `expiresAt` is the original token's
   * expiry (ms epoch) — once past it the row is GC'd, since the token is
   * dead anyway.
   */
  async revoke(jti: string, expiresAt: number): Promise<void> {
    await this.ensureSchema();
    const sql = getDb();
    await sql`
      INSERT INTO revoked_tokens (jti, expires_at)
      VALUES (${jti}, ${new Date(expiresAt)})
      ON CONFLICT (jti) DO UPDATE SET expires_at = GREATEST(revoked_tokens.expires_at, EXCLUDED.expires_at)
    `;
    this.cache.set(jti, { revoked: true, cachedAt: Date.now() });
    logger.info("Revoked token", { jti, expiresAt });
  }

  /** Returns true if this `jti` has been revoked (and not yet expired). */
  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;

    const now = Date.now();
    const cached = this.cache.get(jti);
    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      return cached.revoked;
    }

    try {
      await this.ensureSchema();
      const sql = getDb();
      const rows = await sql<{ jti: string }>`
        SELECT jti FROM revoked_tokens
        WHERE jti = ${jti} AND expires_at > now()
        LIMIT 1
      `;
      const revoked = rows.length > 0;
      this.cache.set(jti, { revoked, cachedAt: now });
      void this.maybeGc(now);
      return revoked;
    } catch (error) {
      logger.error("Failed to check revoked token", { jti, error });
      // Fail closed only when we have a cached positive; otherwise fail
      // open so a DB blip doesn't lock everyone out.
      return cached?.revoked ?? false;
    }
  }

  /** Opportunistic, throttled GC of expired rows. Safe to skip on error. */
  private async maybeGc(now: number): Promise<void> {
    if (now - this.lastGcAt < GC_INTERVAL_MS) return;
    this.lastGcAt = now;
    try {
      await this.sweepExpired();
    } catch (error) {
      logger.warn("Revoked-token GC failed", { error });
    }
  }

  /**
   * Delete expired rows. Cheap (partial index on `expires_at`); also drops
   * stale in-memory cache entries.
   */
  async sweepExpired(): Promise<number> {
    await this.ensureSchema();
    const sql = getDb();
    const rows = await sql`
      WITH deleted AS (
        DELETE FROM revoked_tokens WHERE expires_at <= now() RETURNING jti
      )
      SELECT count(*)::int AS count FROM deleted
    `;
    const now = Date.now();
    for (const [jti, entry] of this.cache) {
      if (now - entry.cachedAt >= CACHE_TTL_MS) this.cache.delete(jti);
    }
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
  }
}

/** Process-wide singleton — mirrors how the gateway shares GrantStore. */
let _store: RevokedTokenStore | null = null;
export function getRevokedTokenStore(): RevokedTokenStore {
  if (!_store) _store = new RevokedTokenStore();
  return _store;
}
