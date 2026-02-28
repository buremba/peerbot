import { type AuthProfile, createLogger } from "@lobu/core";
import type { AgentSettingsStore } from "./agent-settings-store";

const logger = createLogger("auth-profiles-manager");

const ANY_MODEL_SCOPE = "*";

export interface UpsertAuthProfileInput {
  agentId: string;
  provider: string;
  credential: string;
  authType: AuthProfile["authType"];
  label: string;
  model?: string;
  metadata?: AuthProfile["metadata"];
  makePrimary?: boolean;
  id?: string;
}

export class AuthProfilesManager {
  constructor(private readonly agentSettingsStore: AgentSettingsStore) {}

  async listProfiles(agentId: string): Promise<AuthProfile[]> {
    const settings = await this.agentSettingsStore.getSettings(agentId);
    return this.normalizeProfiles(settings?.authProfiles);
  }

  async hasProviderProfiles(
    agentId: string,
    provider: string
  ): Promise<boolean> {
    const profiles = await this.listProfiles(agentId);
    return profiles.some((profile) => profile.provider === provider);
  }

  async getProviderProfiles(
    agentId: string,
    provider: string
  ): Promise<AuthProfile[]> {
    const profiles = await this.listProfiles(agentId);
    return profiles.filter((profile) => profile.provider === provider);
  }

  async getBestProfile(
    agentId: string,
    provider: string,
    model?: string
  ): Promise<AuthProfile | null> {
    const providerProfiles = await this.getProviderProfiles(agentId, provider);
    if (providerProfiles.length === 0) {
      return null;
    }

    const now = Date.now();
    const validProfiles = providerProfiles.filter((profile) => {
      const expiresAt = profile.metadata?.expiresAt;
      return !expiresAt || expiresAt > now;
    });

    const candidates =
      validProfiles.length > 0 ? validProfiles : providerProfiles;
    if (!model) {
      return candidates[0] || null;
    }

    const exact = candidates.find((profile) => profile.model === model);
    if (exact) return exact;

    const wildcard = candidates.find(
      (profile) => profile.model === ANY_MODEL_SCOPE
    );
    return wildcard || candidates[0] || null;
  }

  async upsertProfile(input: UpsertAuthProfileInput): Promise<AuthProfile> {
    const settings = await this.agentSettingsStore.getSettings(input.agentId);
    const current = this.normalizeProfiles(settings?.authProfiles);
    const modelScope = input.model?.trim() || ANY_MODEL_SCOPE;

    const nextProfile: AuthProfile = {
      id: input.id || crypto.randomUUID(),
      provider: input.provider,
      credential: input.credential,
      authType: input.authType,
      label: input.label,
      model: modelScope,
      metadata: input.metadata,
      createdAt: Date.now(),
    };

    let replaced = false;
    const withoutExisting = current.filter((profile) => {
      if (input.id && profile.id === input.id) {
        replaced = true;
        nextProfile.createdAt = profile.createdAt;
        return false;
      }
      return true;
    });

    if (!input.id) {
      const existingPrimary = withoutExisting.find(
        (profile) =>
          profile.provider === input.provider && profile.model === modelScope
      );
      if (existingPrimary) {
        replaced = true;
        nextProfile.createdAt = existingPrimary.createdAt;
      }
    }

    const withoutSameScope = withoutExisting.filter(
      (profile) =>
        !(
          profile.provider === input.provider &&
          profile.model === modelScope &&
          (!input.id || profile.id !== input.id)
        )
    );

    const nextProfiles: AuthProfile[] = [];
    const providerProfiles: AuthProfile[] = [];
    const otherProfiles: AuthProfile[] = [];

    for (const profile of withoutSameScope) {
      if (profile.provider === input.provider) {
        providerProfiles.push(profile);
      } else {
        otherProfiles.push(profile);
      }
    }

    if (input.makePrimary !== false) {
      nextProfiles.push(nextProfile, ...providerProfiles, ...otherProfiles);
    } else {
      nextProfiles.push(...providerProfiles, nextProfile, ...otherProfiles);
    }

    await this.agentSettingsStore.updateSettings(input.agentId, {
      authProfiles: nextProfiles,
    });

    logger.info(
      {
        agentId: input.agentId,
        provider: input.provider,
        profileId: nextProfile.id,
        replaced,
      },
      "Saved auth profile"
    );

    return nextProfile;
  }

  async deleteProviderProfiles(
    agentId: string,
    provider: string,
    profileId?: string
  ): Promise<void> {
    const settings = await this.agentSettingsStore.getSettings(agentId);
    const current = this.normalizeProfiles(settings?.authProfiles);
    const filtered = current.filter((profile) => {
      if (profile.provider !== provider) return true;
      if (!profileId) return false;
      return profile.id !== profileId;
    });

    await this.agentSettingsStore.updateSettings(agentId, {
      authProfiles: filtered,
    });

    logger.info(
      { agentId, provider, profileId: profileId || "all" },
      "Deleted auth profiles"
    );
  }

  private normalizeProfiles(
    profiles: AuthProfile[] | undefined
  ): AuthProfile[] {
    if (!Array.isArray(profiles)) return [];
    return profiles.filter(
      (profile) =>
        typeof profile?.id === "string" &&
        typeof profile?.provider === "string" &&
        typeof profile?.credential === "string" &&
        typeof profile?.authType === "string"
    );
  }
}

export function createAuthProfileLabel(
  providerDisplayName: string,
  credential: string,
  accountHint?: string
): string {
  if (accountHint?.trim()) {
    return accountHint.trim();
  }

  const trimmed = credential.trim();
  if (trimmed.length <= 8) {
    return `${providerDisplayName} key`;
  }

  return `${providerDisplayName} ${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
