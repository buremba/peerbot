import { randomBytes } from "node:crypto";
import { createLogger, decrypt, encrypt } from "@lobu/core";
import type Redis from "ioredis";

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

export class CliTokenService {
  constructor(private readonly redis: Redis) {}

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
    const ttlSeconds = Math.max(
      1,
      Math.ceil((session.expiresAt - Date.now()) / 1000)
    );
    await this.redis.setex(
      this.getSessionKey(session.sessionId),
      ttlSeconds,
      JSON.stringify(session)
    );
  }

  private async getSession(
    sessionId: string
  ): Promise<CliSessionRecord | null> {
    const raw = await this.redis.get(this.getSessionKey(sessionId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as CliSessionRecord;
    } catch (error) {
      logger.error("Failed to parse CLI session", { sessionId, error });
      await this.deleteSession(sessionId);
      return null;
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await this.redis.del(this.getSessionKey(sessionId));
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

  private getSessionKey(sessionId: string): string {
    return `cli:auth:session:${sessionId}`;
  }

  private generateId(): string {
    return randomBytes(24).toString("base64url");
  }
}
