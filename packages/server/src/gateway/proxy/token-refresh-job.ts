import { createLogger } from "@lobu/core";
import type { OAuthClient } from "../auth/oauth/client.js";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";

const logger = createLogger("token-refresh-job");

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh tokens expiring within 5 minutes

export interface RefreshableProvider {
  providerId: string;
  oauthClient: OAuthClient;
}

/**
 * Proactive OAuth token refresher.
 *
 * Wired as a periodic task via TaskScheduler (see `scheduled/jobs.ts`).
 * On each invocation:
 * 1. Scans `UserAuthProfileStore` for `(userId, agentId)` pairs holding OAuth profiles.
 * 2. Refreshes any token expiring within `EXPIRY_BUFFER_MS` via its provider's OAuth client.
 * 3. Writes the rotated credentials back through `AuthProfilesManager.upsertProfile`.
 *
 * Per-pod `refreshLocks` dedup concurrent refreshes for the same profile;
 * cross-pod dedup happens at the scheduler level (one row per cron tick).
 */
export class TokenRefreshJob {
  private refreshLocks = new Map<string, Promise<void>>();

  constructor(
    private authProfilesManager: AuthProfilesManager,
    private refreshableProviders: RefreshableProvider[]
  ) {}

  /** One-shot scan + refresh of every OAuth profile. Invoked by the
   *  TaskScheduler as the every-30min safety net for users who haven't
   *  exercised any token-using path recently — the lazy at-use-time
   *  refresh handles everyone else. */
  async runOnce(): Promise<void> {
    const userAuthProfiles = this.authProfilesManager.getUserAuthProfileStore();
    for await (const { userId, agentId } of userAuthProfiles.scanAllOAuth()) {
      await this.maybeRefresh(userId, agentId);
    }
  }

  /**
   * Refresh tokens for a single (userId, agentId). Public so the
   * `refresh-token-for-user-agent` task and AuthProfilesManager's at-use-time
   * lazy path can both call it. Per-pod `refreshLocks` dedup concurrent calls
   * for the same key in this process.
   */
  async refreshForUserAgent(userId: string, agentId: string): Promise<void> {
    return this.maybeRefresh(userId, agentId);
  }

  private async maybeRefresh(userId: string, agentId: string): Promise<void> {
    const lockKey = `${userId}:${agentId}`;
    const existing = this.refreshLocks.get(lockKey);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.doRefresh(userId, agentId);
    this.refreshLocks.set(lockKey, promise);
    try {
      await promise;
    } finally {
      this.refreshLocks.delete(lockKey);
    }
  }

  private async doRefresh(userId: string, agentId: string): Promise<void> {
    for (const { providerId, oauthClient } of this.refreshableProviders) {
      const profiles = await this.authProfilesManager.getProviderProfiles(
        agentId,
        providerId,
        userId
      );
      const oauthProfile = profiles.find(
        (profile) =>
          profile.authType === "oauth" && !!profile.metadata?.refreshToken
      );

      if (!oauthProfile?.metadata?.refreshToken) continue;

      const expiresAt = oauthProfile.metadata.expiresAt || 0;
      const isExpiring = expiresAt <= Date.now() + EXPIRY_BUFFER_MS;
      if (!isExpiring) continue;

      logger.info(
        `Refreshing ${providerId} token for user ${userId} agent ${agentId} profile ${oauthProfile.id}`,
        { expiresAt: new Date(expiresAt).toISOString() }
      );

      try {
        const newCredentials = await oauthClient.refreshToken(
          oauthProfile.metadata.refreshToken
        );

        await this.authProfilesManager.upsertProfile({
          agentId,
          userId,
          id: oauthProfile.id,
          provider: oauthProfile.provider,
          credential: newCredentials.accessToken,
          authType: "oauth",
          label: oauthProfile.label,
          model: oauthProfile.model,
          metadata: {
            ...oauthProfile.metadata,
            refreshToken: newCredentials.refreshToken,
            expiresAt: newCredentials.expiresAt,
          },
          makePrimary: false,
        });

        logger.info(
          `Token refreshed for user ${userId} agent ${agentId} (${providerId})`
        );
      } catch (error) {
        logger.error(
          `Failed to refresh ${providerId} token for user ${userId} agent ${agentId}`,
          {
            error,
            profileId: oauthProfile.id,
          }
        );
      }
    }
  }
}
