import { randomBytes } from "node:crypto";
import { createLogger, decrypt, encrypt } from "@lobu/core";
import { getDb } from "../../../db/client.js";

const logger = createLogger("cli-token-service");

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CliAccessTokenPayload {
  type: "cli-access";
  sessionId: string;
  userId: string;
  email?: string;
  name?: string;
  exp: number;
  iat: number;
}

interface CliRefreshTokenPayload {
  type: "cli-refresh";
  sessionId: string;
  refreshTokenId: string;
  exp: number;
  iat: number;
}

interface CliSessionRecord {
  sessionId: string;
  userId: string;
  email?: string;
  name?: string;
  refreshTokenId: string;
  createdAt: number;
  expiresAt: number;
}

interface CliTokenIdentity {
  userId: string;
  email?: string;
  name?: string;
}

interface CliIssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: CliTokenIdentity;
}

interface CliAccessTokenIdentity extends CliTokenIdentity {
  sessionId: string;
  expiresAt: number;
}

/**
 * CLI token service backed by `public.cli_sessions`.
 *
 * Session rows are 30-day refresh-token anchors. Access tokens are
 * encrypted JWT-shaped blobs that carry `sessionId`; verifyAccessToken
 * re-checks the row exists so a `revokeSessionByRefreshToken` invalidates
 * outstanding access tokens within the verify window.
 *
 * The previous Redis-backed implementation used a single `setex` per
 * session and relied on TTL for cleanup; here we read `expires_at` on
 * every load and lazily delete expired rows. A periodic sweeper deletes
 * leftover rows in bulk.
 */
export class CliTokenService {
  async issueTokens(identity: CliTokenIdentity): Promise<CliIssuedTokens> {
    const session = this.createSessionRecord(identity);
    await this.saveSession(session);
    return this.buildIssuedTokens(session);
  }

  async refreshTokens(refreshToken: string): Promise<CliIssuedTokens | null> {
    const payload = this.parseRefreshToken(refreshToken);
    if (!payload) {
      return null;
    }

    const session = await this.getSession(payload.sessionId);
    if (!session) {
      logger.warn("CLI refresh rejected: session not found", {
        sessionId: payload.sessionId,
      });
      return null;
    }

    if (session.refreshTokenId !== payload.refreshTokenId) {
      logger.warn("CLI refresh rejected: token rotation mismatch", {
        sessionId: payload.sessionId,
      });
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      logger.warn("CLI refresh rejected: session expired", {
        sessionId: payload.sessionId,
      });
      await this.deleteSession(session.sessionId);
      return null;
    }

    session.refreshTokenId = this.generateId();
    await this.saveSession(session);
    return this.buildIssuedTokens(session);
  }

  async verifyAccessToken(
    accessToken: string
  ): Promise<CliAccessTokenIdentity | null> {
    const payload = this.parseAccessToken(accessToken);
    if (!payload) {
      return null;
    }

    const session = await this.getSession(payload.sessionId);
    if (!session) {
      logger.warn("CLI access token rejected: session not found", {
        sessionId: payload.sessionId,
      });
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      logger.warn("CLI access token rejected: session expired", {
        sessionId: payload.sessionId,
      });
      await this.deleteSession(session.sessionId);
      return null;
    }

    return {
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      name: session.name,
      expiresAt: payload.exp,
    };
  }

  async revokeSessionByRefreshToken(refreshToken: string): Promise<void> {
    const payload = this.parseRefreshToken(refreshToken);
    if (!payload) {
      return;
    }
    await this.deleteSession(payload.sessionId);
  }

  private buildIssuedTokens(session: CliSessionRecord): CliIssuedTokens {
    const accessPayload: CliAccessTokenPayload = {
      type: "cli-access",
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      name: session.name,
      iat: Date.now(),
      exp: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
    const refreshPayload: CliRefreshTokenPayload = {
      type: "cli-refresh",
      sessionId: session.sessionId,
      refreshTokenId: session.refreshTokenId,
      iat: Date.now(),
      exp: session.expiresAt,
    };

    return {
      accessToken: encrypt(JSON.stringify(accessPayload)),
      refreshToken: encrypt(JSON.stringify(refreshPayload)),
      expiresAt: accessPayload.exp,
      user: {
        userId: session.userId,
        email: session.email,
        name: session.name,
      },
    };
  }

  private createSessionRecord(identity: CliTokenIdentity): CliSessionRecord {
    const now = Date.now();
    return {
      sessionId: this.generateId(),
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      refreshTokenId: this.generateId(),
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    };
  }

  private async saveSession(session: CliSessionRecord): Promise<void> {
    const sql = getDb();
    const expiresAt = new Date(session.expiresAt);
    await sql`
      INSERT INTO cli_sessions (
        session_id, user_id, email, name, refresh_token_id, expires_at
      ) VALUES (
        ${session.sessionId},
        ${session.userId},
        ${session.email ?? null},
        ${session.name ?? null},
        ${session.refreshTokenId},
        ${expiresAt}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        refresh_token_id = EXCLUDED.refresh_token_id,
        expires_at = EXCLUDED.expires_at
    `;
  }

  private async getSession(
    sessionId: string
  ): Promise<CliSessionRecord | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT session_id, user_id, email, name, refresh_token_id,
             expires_at, created_at
      FROM cli_sessions
      WHERE session_id = ${sessionId}
        AND expires_at > now()
    `;
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0] as {
      session_id: string;
      user_id: string;
      email: string | null;
      name: string | null;
      refresh_token_id: string;
      expires_at: Date | string;
      created_at: Date | string;
    };
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email ?? undefined,
      name: row.name ?? undefined,
      refreshTokenId: row.refresh_token_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.getTime()
          : Date.parse(String(row.created_at)),
      expiresAt:
        row.expires_at instanceof Date
          ? row.expires_at.getTime()
          : Date.parse(String(row.expires_at)),
    };
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const sql = getDb();
    await sql`DELETE FROM cli_sessions WHERE session_id = ${sessionId}`;
  }

  private parseAccessToken(token: string): CliAccessTokenPayload | null {
    return this.parseToken<CliAccessTokenPayload>(token, "cli-access");
  }

  private parseRefreshToken(token: string): CliRefreshTokenPayload | null {
    return this.parseToken<CliRefreshTokenPayload>(token, "cli-refresh");
  }

  private parseToken<T extends { type: string; exp: number }>(
    token: string,
    expectedType: string
  ): T | null {
    try {
      const payload = JSON.parse(decrypt(token)) as T;
      if (payload.type !== expectedType) {
        return null;
      }
      if (typeof payload.exp !== "number" || payload.exp <= Date.now()) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private generateId(): string {
    return randomBytes(24).toString("base64url");
  }
}

/**
 * Sweep expired cli_sessions rows. Safe to call from a periodic timer.
 */
export async function sweepExpiredCliSessions(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM cli_sessions WHERE expires_at <= now() RETURNING session_id
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
