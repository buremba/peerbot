import {
  type AuthProfile,
  createLogger,
  safeJsonParse,
  safeJsonStringify,
} from "@lobu/core";
import type Redis from "ioredis";
import { deleteSecretsByPrefix, type WritableSecretStore } from "../../secrets";

const logger = createLogger("user-auth-profile-store");

const KEY_PREFIX = "user:auth-profiles";

function buildKey(userId: string, agentId: string): string {
  return `${KEY_PREFIX}:${userId}:${agentId}`;
}

function buildSecretName(
  userId: string,
  agentId: string,
  profileId: string,
  kind: "credential" | "refresh-token"
): string {
  return `users/${userId}/agents/${agentId}/auth-profiles/${profileId}/${kind}`;
}

function buildAgentSecretPrefix(userId: string, agentId: string): string {
  return `users/${userId}/agents/${agentId}/auth-profiles/`;
}

function buildProfileSecretPrefix(
  userId: string,
  agentId: string,
  profileId: string
): string {
  return `users/${userId}/agents/${agentId}/auth-profiles/${profileId}/`;
}

interface UserAgentRef {
  userId: string;
  agentId: string;
}

/**
 * Per-user auth profile storage.
 *
 * Keyed by `(userId, agentId)`. Holds OAuth tokens, refresh tokens, and
 * BYOK credentials owned by a specific user for a specific agent.
 *
 * Sensitive values (credential / refresh token) are persisted to the
 * secret store and replaced inline with their refs, mirroring the policy
 * previously implemented inside `AgentSettingsStore`.
 */
export class UserAuthProfileStore {
  constructor(
    private readonly redis: Redis,
    private readonly secretStore: WritableSecretStore
  ) {}

  async list(userId: string, agentId: string): Promise<AuthProfile[]> {
    if (!userId || !agentId) return [];
    try {
      const raw = await this.redis.get(buildKey(userId, agentId));
      if (!raw) return [];
      const parsed = safeJsonParse<AuthProfile[]>(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (error) {
      logger.warn("Failed to read user auth profiles", {
        userId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Insert or update a profile. The supplied profile is normalized through
   * the secret store: any plaintext credential/refreshToken is moved into
   * the secret store and replaced with a ref before persistence.
   *
   * The stored ordering follows the same convention as
   * `AuthProfilesManager.upsertProfile`: when `makePrimary === false` the
   * profile is appended after sibling provider profiles; otherwise it is
   * placed at the front of its provider group.
   */
  async upsert(
    userId: string,
    agentId: string,
    profile: AuthProfile,
    options: { makePrimary?: boolean } = {}
  ): Promise<AuthProfile> {
    const persisted = await this.persistSecrets(userId, agentId, profile);
    const current = await this.list(userId, agentId);

    let preservedCreatedAt = persisted.createdAt;
    const filtered = current.filter((existing) => {
      if (existing.id === persisted.id) {
        preservedCreatedAt = existing.createdAt;
        return false;
      }
      if (
        existing.provider === persisted.provider &&
        existing.model === persisted.model
      ) {
        preservedCreatedAt = existing.createdAt;
        return false;
      }
      return true;
    });
    const next: AuthProfile = { ...persisted, createdAt: preservedCreatedAt };

    const sameProvider: AuthProfile[] = [];
    const others: AuthProfile[] = [];
    for (const entry of filtered) {
      if (entry.provider === next.provider) {
        sameProvider.push(entry);
      } else {
        others.push(entry);
      }
    }

    const ordered =
      options.makePrimary === false
        ? [...sameProvider, next, ...others]
        : [next, ...sameProvider, ...others];

    await this.redis.set(buildKey(userId, agentId), this.serialize(ordered));
    return next;
  }

  async remove(
    userId: string,
    agentId: string,
    options: { provider: string; profileId?: string }
  ): Promise<{ removed: AuthProfile[]; secretsDeleted: number }> {
    const current = await this.list(userId, agentId);
    if (current.length === 0) {
      return { removed: [], secretsDeleted: 0 };
    }

    const removed = current.filter((profile) => {
      if (profile.provider !== options.provider) return false;
      if (options.profileId && profile.id !== options.profileId) return false;
      return true;
    });
    const remaining = current.filter((profile) => !removed.includes(profile));

    if (remaining.length > 0) {
      await this.redis.set(
        buildKey(userId, agentId),
        this.serialize(remaining)
      );
    } else {
      await this.redis.del(buildKey(userId, agentId));
    }

    let secretsDeleted = 0;
    for (const profile of removed) {
      secretsDeleted += await deleteSecretsByPrefix(
        this.secretStore,
        buildProfileSecretPrefix(userId, agentId, profile.id)
      );
    }

    return { removed, secretsDeleted };
  }

  /**
   * Cascade-delete every profile and secret for a `(userId, agentId)`.
   * Used when an agent is deleted entirely.
   */
  async dropAgent(userId: string, agentId: string): Promise<void> {
    await this.redis.del(buildKey(userId, agentId));
    await deleteSecretsByPrefix(
      this.secretStore,
      buildAgentSecretPrefix(userId, agentId)
    );
  }

  /**
   * Yield every `(userId, agentId)` pair for which OAuth profiles exist.
   * Used by `TokenRefreshJob` to scan refreshable tokens.
   */
  async *scanAllOAuth(): AsyncIterable<UserAgentRef> {
    const pattern = `${KEY_PREFIX}:*`;
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = next;
      for (const key of keys) {
        const ref = parseKey(key);
        if (ref) yield ref;
      }
    } while (cursor !== "0");
  }

  private serialize(profiles: AuthProfile[]): string {
    const json = safeJsonStringify(profiles);
    if (json === null) {
      throw new Error("Failed to serialize user auth profiles");
    }
    return json;
  }

  private async persistSecrets(
    userId: string,
    agentId: string,
    profile: AuthProfile
  ): Promise<AuthProfile> {
    const next: AuthProfile = { ...profile };
    const metadata = profile.metadata ? { ...profile.metadata } : undefined;

    if (profile.credential) {
      next.credentialRef = await this.secretStore.put(
        buildSecretName(userId, agentId, profile.id, "credential"),
        profile.credential
      );
    }
    delete next.credential;

    if (metadata) {
      if (metadata.refreshToken) {
        metadata.refreshTokenRef = await this.secretStore.put(
          buildSecretName(userId, agentId, profile.id, "refresh-token"),
          metadata.refreshToken
        );
      }
      delete metadata.refreshToken;
      next.metadata = metadata;
    }

    return next;
  }
}

function parseKey(key: string): UserAgentRef | null {
  const rest = key.startsWith(`${KEY_PREFIX}:`)
    ? key.slice(KEY_PREFIX.length + 1)
    : null;
  if (!rest) return null;
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { userId: rest.slice(0, sep), agentId: rest.slice(sep + 1) };
}
