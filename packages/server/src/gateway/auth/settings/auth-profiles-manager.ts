import { type AuthProfile, createLogger } from "@lobu/core";
import type {
  ProviderCredentialContext,
  RuntimeProviderCredentialResolver,
} from "../../embedded.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import type { DeclaredAgentRegistry } from "../../services/declared-agent-registry.js";
import type { EphemeralAuthProfileRegistry } from "./agent-settings-store.js";
import type { UserAuthProfileStore } from "./user-auth-profile-store.js";

const logger = createLogger("auth-profiles-manager");

const ANY_MODEL_SCOPE = "*";

/** Refresh tokens that expire within this window from now. */
const LAZY_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Hooks the AuthProfilesManager calls when a profile read encounters a token
 * that's near or past expiry. Wired by boot after the TaskScheduler is up;
 * before that point, lazy refresh is a no-op and the periodic safety-net task
 * handles everything.
 */
export interface LazyRefreshHooks {
  /** Fire-and-forget — used when the token is still valid but expiring soon.
   *  Implementation should dedup across pods (idempotency-keyed scheduler spawn). */
  triggerAsync: (userId: string, agentId: string) => Promise<void>;
  /** Inline refresh — used when the token is already expired and the caller
   *  is about to use it. Awaits completion. Per-pod dedup expected. */
  refreshNow: (userId: string, agentId: string) => Promise<void>;
}

interface UpsertAuthProfileInput {
  agentId: string;
  /** Owning user. Required for persistent writes. */
  userId?: string;
  provider: string;
  credential?: string;
  credentialRef?: string;
  authType: AuthProfile["authType"];
  label: string;
  model?: string;
  metadata?: AuthProfile["metadata"];
  makePrimary?: boolean;
  id?: string;
}

interface AuthProfilesManagerOptions {
  ephemeralProfiles: EphemeralAuthProfileRegistry;
  declaredAgents: DeclaredAgentRegistry;
  userAuthProfiles: UserAuthProfileStore;
  secretStore: WritableSecretStore;
  runtimeCredentialResolver?: RuntimeProviderCredentialResolver;
}

/**
 * Resolve and write auth profiles by merging three sources:
 *
 * 1. **Runtime resolver** — SDK host can plug in a synchronous credential
 *    resolver that wins over everything else (ProviderCredentialContext).
 * 2. **User-scoped profiles** — durable per-user profiles keyed by
 *    `(userId, agentId)` in `UserAuthProfileStore`.
 * 3. **Declared credentials** — read-only credentials shipped with the
 *    agent's declared config (lobu.toml / SDK GatewayConfig.agents),
 *    surfaced via `DeclaredAgentRegistry`.
 *
 * Callers pass `ProviderCredentialContext.userId` when they have one
 * (worker proxy, OAuth route, agent-config route). When `userId` is
 * absent, only declared + runtime sources are consulted.
 */
export class AuthProfilesManager {
  private readonly ephemeralProfiles: EphemeralAuthProfileRegistry;
  private readonly declaredAgents: DeclaredAgentRegistry;
  private readonly userAuthProfiles: UserAuthProfileStore;
  private readonly secretStore: WritableSecretStore;
  private readonly runtimeCredentialResolver?: RuntimeProviderCredentialResolver;
  private lazyRefreshHooks?: LazyRefreshHooks;

  constructor(options: AuthProfilesManagerOptions) {
    this.ephemeralProfiles = options.ephemeralProfiles;
    this.declaredAgents = options.declaredAgents;
    this.userAuthProfiles = options.userAuthProfiles;
    this.secretStore = options.secretStore;
    this.runtimeCredentialResolver = options.runtimeCredentialResolver;
  }

  /** Wired by boot after TaskScheduler is up. Until then, lazy refresh is a
   *  no-op (the periodic safety-net handles everything). */
  setLazyRefreshHooks(hooks: LazyRefreshHooks): void {
    this.lazyRefreshHooks = hooks;
  }

  /**
   * Returns a credential guaranteed valid right now for the given profile.
   * Three paths:
   *  - Token has > 5min until expiry, or profile is non-OAuth: returns
   *    `profile.credential` immediately (fast path).
   *  - Token expires within 5min but is still valid: fires a fire-and-forget
   *    refresh task (idempotency-keyed) and returns the current credential
   *    (still valid for the buffer window).
   *  - Token has already expired: blocks on inline refresh, re-reads the
   *    profile, returns the new credential.
   *
   * If LazyRefreshHooks aren't wired (boot order, tests), returns
   * `profile.credential` unchanged — periodic safety-net catches it later.
   */
  async ensureFreshCredential(
    profile: AuthProfile,
    ctx: { userId: string; agentId: string },
  ): Promise<string | undefined> {
    const credential = profile.credential;
    if (!credential) return credential;
    if (profile.authType !== "oauth") return credential;
    if (!this.lazyRefreshHooks) return credential;

    const expiresAt = profile.metadata?.expiresAt ?? 0;
    if (!expiresAt) return credential; // no expiry tracked

    const now = Date.now();
    if (expiresAt > now + LAZY_REFRESH_BUFFER_MS) return credential;

    if (expiresAt > now) {
      // Soon-expiring: fire async, return current credential.
      this.lazyRefreshHooks
        .triggerAsync(ctx.userId, ctx.agentId)
        .catch((err) =>
          logger.warn(
            { err, profileId: profile.id, userId: ctx.userId },
            "[lazy-refresh] async trigger failed; periodic task will retry",
          ),
        );
      return credential;
    }

    // Already expired: inline refresh + re-read.
    try {
      await this.lazyRefreshHooks.refreshNow(ctx.userId, ctx.agentId);
      const refreshed = await this.getProviderProfiles(
        ctx.agentId,
        profile.provider,
        ctx.userId,
      );
      const fresh = refreshed.find((p) => p.id === profile.id);
      return fresh?.credential ?? credential;
    } catch (err) {
      logger.error(
        { err, profileId: profile.id, userId: ctx.userId },
        "[lazy-refresh] inline refresh failed; returning stale credential",
      );
      return credential;
    }
  }

  getDeclaredAgents(): DeclaredAgentRegistry {
    return this.declaredAgents;
  }

  getUserAuthProfileStore(): UserAuthProfileStore {
    return this.userAuthProfiles;
  }

  /**
   * Return every profile known for `(agentId, userId?)`, with secret refs
   * resolved to plaintext. Intended for admin/agent-config surfaces.
   *
   * Order:
   *   1. user-scoped profiles (most authoritative)
   *   2. ephemeral profiles registered by SDK host
   *   3. declared credentials from registry (synthesized as `api-key`)
   */
  async listProfiles(agentId: string, userId?: string): Promise<AuthProfile[]> {
    const userProfiles = userId
      ? await this.userAuthProfiles.list(userId, agentId)
      : [];
    const ephemeral = this.ephemeralProfiles.get(agentId) || [];
    const declared = this.synthesizeDeclaredProfiles(agentId);

    const merged = this.dedupeByScope([
      ...this.normalizeProfiles(userProfiles),
      ...this.normalizeProfiles(ephemeral),
      ...declared,
    ]);

    const resolved = await Promise.all(
      merged.map(async (profile) => {
        try {
          return await this.resolveProfile(profile);
        } catch (error) {
          logger.warn(
            {
              agentId,
              profileId: profile.id,
              provider: profile.provider,
              error: error instanceof Error ? error.message : String(error),
            },
            "Dropping auth profile with unresolvable secret ref"
          );
          return null;
        }
      })
    );

    return resolved.filter((p): p is AuthProfile => p !== null);
  }

  async hasProviderProfiles(
    agentId: string,
    provider: string,
    context?: ProviderCredentialContext
  ): Promise<boolean> {
    if (
      await this.resolveRuntimeProfile(agentId, provider, undefined, context)
    ) {
      return true;
    }
    const profiles = await this.listProfiles(agentId, context?.userId);
    return profiles.some((profile) => profile.provider === provider);
  }

  async getProviderProfiles(
    agentId: string,
    provider: string,
    userId?: string
  ): Promise<AuthProfile[]> {
    const profiles = await this.listProfiles(agentId, userId);
    return profiles.filter((profile) => profile.provider === provider);
  }

  async getBestProfile(
    agentId: string,
    provider: string,
    model?: string,
    context?: ProviderCredentialContext
  ): Promise<AuthProfile | null> {
    const runtimeProfile = await this.resolveRuntimeProfile(
      agentId,
      provider,
      model,
      context
    );
    if (runtimeProfile) {
      return runtimeProfile;
    }

    const providerProfiles = await this.getProviderProfiles(
      agentId,
      provider,
      context?.userId
    );
    if (providerProfiles.length === 0) {
      return null;
    }

    const now = Date.now();
    const validProfiles = providerProfiles.filter((profile) => {
      const expiresAt = profile.metadata?.expiresAt;
      return !expiresAt || expiresAt > now;
    });

    if (validProfiles.length === 0) {
      logger.warn(
        { agentId, provider, profileCount: providerProfiles.length },
        "All auth profiles for provider are expired"
      );
      return null;
    }

    if (!model) {
      return validProfiles[0] || null;
    }

    const exact = validProfiles.find((profile) => profile.model === model);
    if (exact) return exact;

    const wildcard = validProfiles.find(
      (profile) => profile.model === ANY_MODEL_SCOPE
    );
    return wildcard || validProfiles[0] || null;
  }

  /**
   * Insert or update a persistent profile.
   *
   * Requires `userId` — declared agents cannot be mutated through this
   * path. Runtime UI/sandbox agents that aren't owned by a single user
   * should pass a synthetic principal (`$ADMIN`) chosen by the caller.
   */
  async upsertProfile(input: UpsertAuthProfileInput): Promise<AuthProfile> {
    if (!input.userId) {
      throw new Error(
        "upsertProfile requires userId — declared agents cannot be mutated; " +
          "runtime agents must specify the owning principal"
      );
    }

    const modelScope = input.model?.trim() || ANY_MODEL_SCOPE;
    const profile: AuthProfile = {
      id: input.id || crypto.randomUUID(),
      provider: input.provider,
      ...(input.credential ? { credential: input.credential } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      authType: input.authType,
      label: input.label,
      model: modelScope,
      metadata: input.metadata,
      createdAt: Date.now(),
    };

    const stored = await this.userAuthProfiles.upsert(
      input.userId,
      input.agentId,
      profile,
      { makePrimary: input.makePrimary }
    );

    logger.info(
      {
        agentId: input.agentId,
        userId: input.userId,
        provider: input.provider,
        profileId: stored.id,
      },
      "Saved auth profile"
    );

    return stored;
  }

  registerEphemeralProfile(input: UpsertAuthProfileInput): AuthProfile {
    const modelScope = input.model?.trim() || ANY_MODEL_SCOPE;
    const nextProfile: AuthProfile = {
      id: input.id || crypto.randomUUID(),
      provider: input.provider,
      ...(input.credential ? { credential: input.credential } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      authType: input.authType,
      label: input.label,
      model: modelScope,
      metadata: input.metadata,
      createdAt: Date.now(),
    };

    const current = this.ephemeralProfiles.get(input.agentId) || [];
    const withoutSameScope = current.filter(
      (profile) =>
        !(
          profile.provider === input.provider &&
          profile.model === modelScope &&
          (!input.id || profile.id !== input.id)
        )
    );

    const providerProfiles: AuthProfile[] = [];
    const otherProfiles: AuthProfile[] = [];
    for (const profile of withoutSameScope) {
      if (profile.provider === input.provider) {
        providerProfiles.push(profile);
      } else {
        otherProfiles.push(profile);
      }
    }

    const nextProfiles =
      input.makePrimary !== false
        ? [nextProfile, ...providerProfiles, ...otherProfiles]
        : [...providerProfiles, nextProfile, ...otherProfiles];

    this.ephemeralProfiles.set(input.agentId, nextProfiles);
    return nextProfile;
  }

  async deleteProviderProfiles(
    agentId: string,
    provider: string,
    options: { userId?: string; profileId?: string } = {}
  ): Promise<void> {
    if (options.userId) {
      await this.userAuthProfiles.remove(options.userId, agentId, {
        provider,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      });
    }

    const ephemeral = this.ephemeralProfiles.get(agentId);
    if (ephemeral) {
      const filtered = ephemeral.filter((profile) => {
        if (profile.provider !== provider) return true;
        if (!options.profileId) return false;
        return profile.id !== options.profileId;
      });
      if (filtered.length > 0) {
        this.ephemeralProfiles.set(agentId, filtered);
      } else {
        this.ephemeralProfiles.delete(agentId);
      }
    }

    logger.info(
      {
        agentId,
        provider,
        userId: options.userId || null,
        profileId: options.profileId || "all",
      },
      "Deleted auth profiles"
    );
  }

  private synthesizeDeclaredProfiles(agentId: string): AuthProfile[] {
    const entry = this.declaredAgents.get(agentId);
    if (!entry || entry.credentials.length === 0) return [];

    const now = Date.now();
    return entry.credentials.map<AuthProfile>((cred) => ({
      id: `declared:${agentId}:${cred.provider}`,
      provider: cred.provider,
      ...(cred.key ? { credential: cred.key } : {}),
      ...(cred.secretRef ? { credentialRef: cred.secretRef } : {}),
      authType: "api-key",
      label: `${cred.provider} (declared)`,
      model: ANY_MODEL_SCOPE,
      createdAt: now,
    }));
  }

  private normalizeProfiles(
    profiles: AuthProfile[] | undefined
  ): AuthProfile[] {
    if (!Array.isArray(profiles)) return [];
    return profiles.filter(
      (profile) =>
        typeof profile?.id === "string" &&
        typeof profile?.provider === "string" &&
        (typeof profile?.credential === "string" ||
          typeof profile?.credentialRef === "string") &&
        typeof profile?.authType === "string"
    );
  }

  /**
   * Merge profile lists, preferring whichever came first in the input
   * when two profiles cover the same (provider, model) scope. Callers
   * pass user profiles before ephemeral and declared so the persisted
   * per-user choice always wins.
   *
   * Within a scope, a non-expired profile beats an expired one regardless
   * of order — this keeps a stale user OAuth token from masking a valid
   * declared/ephemeral fallback for the same scope.
   */
  private dedupeByScope(profiles: AuthProfile[]): AuthProfile[] {
    const now = Date.now();
    const isExpired = (profile: AuthProfile) =>
      !!profile.metadata?.expiresAt && profile.metadata.expiresAt <= now;

    const scopeOrder: string[] = [];
    const chosen = new Map<string, AuthProfile>();
    for (const profile of profiles) {
      const scope = `${profile.provider}:${profile.model ?? ANY_MODEL_SCOPE}`;
      const existing = chosen.get(scope);
      if (!existing) {
        chosen.set(scope, profile);
        scopeOrder.push(scope);
        continue;
      }
      if (existing.id === profile.id) continue;
      if (isExpired(existing) && !isExpired(profile)) {
        chosen.set(scope, profile);
      }
    }
    return scopeOrder.map((scope) => chosen.get(scope)!);
  }

  private async resolveProfile(profile: AuthProfile): Promise<AuthProfile> {
    let credential = profile.credential;
    let credentialResolvedFromRef = false;
    if (!credential && profile.credentialRef) {
      const resolved = await this.secretStore.get(profile.credentialRef);
      if (!resolved) {
        throw new Error(
          `Unresolved credential secret ref: ${profile.credentialRef}`
        );
      }
      credential = resolved;
      credentialResolvedFromRef = true;
    }

    let refreshToken = profile.metadata?.refreshToken;
    let refreshTokenResolvedFromRef = false;
    if (!refreshToken && profile.metadata?.refreshTokenRef) {
      const resolved = await this.secretStore.get(
        profile.metadata.refreshTokenRef
      );
      if (!resolved) {
        throw new Error(
          `Unresolved refreshToken secret ref: ${profile.metadata.refreshTokenRef}`
        );
      }
      refreshToken = resolved;
      refreshTokenResolvedFromRef = true;
    }

    const next: AuthProfile = { ...profile };
    if (credentialResolvedFromRef) {
      next.credential = credential;
      delete next.credentialRef;
    } else if (credential) {
      next.credential = credential;
    }

    if (profile.metadata) {
      const metadata = { ...profile.metadata };
      if (refreshTokenResolvedFromRef) {
        metadata.refreshToken = refreshToken;
        delete metadata.refreshTokenRef;
      } else if (refreshToken) {
        metadata.refreshToken = refreshToken;
      }
      next.metadata = metadata;
    }

    return next;
  }

  private async resolveRuntimeProfile(
    agentId: string,
    provider: string,
    model?: string,
    context?: ProviderCredentialContext
  ): Promise<AuthProfile | null> {
    if (!this.runtimeCredentialResolver) {
      return null;
    }

    let resolved: Awaited<ReturnType<RuntimeProviderCredentialResolver>>;
    try {
      resolved = await this.runtimeCredentialResolver({
        ...context,
        agentId,
        provider,
        model,
      });
    } catch (error) {
      logger.warn("Runtime credential resolver threw", {
        agentId,
        provider,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (!resolved || (!resolved.credential && !resolved.credentialRef)) {
      return null;
    }

    if (resolved.credential && resolved.credentialRef) {
      logger.warn(
        "Runtime credential resolver returned both credential and credentialRef; preferring credential",
        { agentId, provider, model }
      );
    }

    try {
      const profile = await this.resolveProfile({
        id: `runtime:${agentId}:${provider}:${model ?? "*"}`,
        provider,
        ...(resolved.credential
          ? { credential: resolved.credential }
          : { credentialRef: resolved.credentialRef }),
        authType: resolved.authType ?? "api-key",
        label: resolved.label ?? `${provider} (runtime resolver)`,
        model: model?.trim() || ANY_MODEL_SCOPE,
        metadata: resolved.metadata,
        createdAt: Date.now(),
      });

      if (!profile.credential && !profile.credentialRef) {
        return null;
      }

      return profile;
    } catch (error) {
      logger.warn("Failed to resolve runtime credential profile", {
        agentId,
        provider,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
