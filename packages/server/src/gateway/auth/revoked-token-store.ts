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
 * Schema lives in `db/migrations/20260519020001_revoked_tokens.sql` and is
 * mirrored in `db/embedded-schema-patches.ts` for pre-initialized embedded
 * databases.
 */
export class RevokedTokenStore {
  private readonly cache = new Map<string, CacheEntry>();
  private lastGcAt = 0;

  /**
   * Revoke a token by its `jti`. `expiresAt` is the original token's
   * expiry (ms epoch) — once past it the row is GC'd, since the token is
   * dead anyway.
   */
  async revoke(jti: string, expiresAt: number): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO revoked_tokens (jti, expires_at)
      VALUES (${jti}, ${new Date(expiresAt)})
      ON CONFLICT (jti) DO UPDATE SET expires_at = GREATEST(revoked_tokens.expires_at, EXCLUDED.expires_at)
    `;
    this.cache.set(jti, { revoked: true, cachedAt: Date.now() });
    logger.info("Revoked token", { jti, expiresAt });
  }

  /**
   * Synchronous fast-path: consults only the in-process TTL cache.
   * Used by hot/non-async call sites (HTTP CONNECT proxy auth, internal
   * worker-token middleware) where introducing an `await` would force a
   * cascading refactor. Revokes performed in the same process are visible
   * immediately because `revoke()` writes to the cache; revokes performed
   * elsewhere become visible after the next `isRevoked()` populates the
   * cache (within `CACHE_TTL_MS`). For middleware paths that already
   * await DB work, prefer `isRevoked()` for cross-process freshness.
   */
  isRevokedCached(jti: string): boolean {
    if (!jti) return false;
    const cached = this.cache.get(jti);
    if (!cached) return false;
    if (Date.now() - cached.cachedAt >= CACHE_TTL_MS) return false;
    return cached.revoked;
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
