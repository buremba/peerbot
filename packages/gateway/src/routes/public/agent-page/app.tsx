import { type Signal, useSignal } from "@preact/signals";
import { createContext, render } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";
import * as api from "./api";
import { ConnectionsSection } from "./components/ConnectionsSection";
import { AdminBar } from "./components/Header";
import { InstructionsSection } from "./components/InstructionsSection";
import { MessageBanners } from "./components/MessageBanners";
import { NixPackagesSection } from "./components/NixPackagesSection";
import { PermissionsSection } from "./components/PermissionsSection";
import {
  ProviderSection,
  triggerProviderAuth,
} from "./components/ProviderSection";
import { RemindersSection } from "./components/RemindersSection";
import { SkillsSection } from "./components/SkillsSection";
import type {
  CatalogProvider,
  McpConfig,
  ModelOption,
  PermissionGrant,
  PrefillMcp,
  PrefillSkill,
  ProviderInfo,
  ProviderState,
  Schedule,
  SettingsSectionKey,
  SettingsSnapshot,
  SettingsState,
  Skill,
} from "./types";

declare global {
  interface Window {
    __AGENT_STATE__: SettingsState;
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready(): void;
        expand(): void;
        openLink(url: string): void;
      };
    };
  }
}

// ─── Context ───────────────────────────────────────────────────────────────

export interface RegistryEntry {
  id: string;
  type: string;
  apiUrl: string;
}

export interface SettingsContextValue {
  agentId: string;
  scope: SettingsState["scope"];
  PROVIDERS: Record<string, ProviderInfo>;
  providerModels: Record<string, ModelOption[]>;
  catalogProviders: Signal<CatalogProvider[]>;
  providerOrder: Signal<string[]>;
  primaryProvider: Signal<string>;
  providerState: Signal<Record<string, ProviderState>>;
  showCatalog: Signal<boolean>;
  pendingProvider: Signal<(CatalogProvider & { success?: boolean }) | null>;
  deviceCodePollTimer: Signal<ReturnType<typeof setInterval> | null>;

  agentName: Signal<string>;
  agentDescription: Signal<string>;
  initialAgentName: Signal<string>;
  initialAgentDescription: Signal<string>;
  savingIdentity: Signal<boolean>;
  hasChannelId: boolean;

  successMsg: Signal<string>;
  errorMsg: Signal<string>;
  saving: Signal<boolean>;

  verboseLogging: Signal<boolean>;
  identityMd: Signal<string>;
  soulMd: Signal<string>;
  userMd: Signal<string>;

  skills: Signal<Skill[]>;
  skillsLoading: Signal<boolean>;
  skillsError: Signal<string>;

  mcpServers: Signal<Record<string, McpConfig>>;

  nixPackages: Signal<string[]>;

  permissionGrants: Signal<PermissionGrant[]>;
  permissionsLoading: Signal<boolean>;

  schedules: Signal<Schedule[]>;
  schedulesLoading: Signal<boolean>;
  schedulesError: Signal<string>;

  prefillSkills: Signal<PrefillSkill[]>;
  prefillMcpServers: Signal<PrefillMcp[]>;
  prefillGrants: Signal<string[]>;
  prefillNixPackages: Signal<string[]>;
  prefillProviders: Signal<string[]>;
  prefillBannerDismissed: Signal<boolean>;
  approvingPrefills: Signal<boolean>;
  approvedPrefillSkills: Signal<string[]>;

  openSections: Signal<Record<string, boolean>>;

  initialSettingsSnapshot: Signal<SettingsSnapshot | null>;

  // Skill registries
  registries: Signal<RegistryEntry[]>;
  globalRegistries: RegistryEntry[];

  // Server-injected display data
  platform: string;
  userId: string;
  channelId?: string;
  teamId?: string;
  message?: string;
  conversationId?: string;
  connectionId?: string;
  showSwitcher: boolean;
  agents: SettingsState["agents"];
  providerIconUrls: Record<string, string>;

  memoryEnabled: boolean;

  // Scoped settings
  settingsMode: "admin" | "user";
  allowedScopes?: string[];
  isAdmin: boolean;
  isSandbox: boolean;
  ownerPlatform: string;
  templateAgentId?: string;
  templateAgentName?: string;
  sectionViews: SettingsState["sectionViews"];
  providerViews: SettingsState["providerViews"];
  configManagedProviders: string[];
  promoting: Signal<boolean>;
  canViewSection(section: SettingsSectionKey): boolean;
  canEditSection(section: SettingsSectionKey): boolean;
  canUserViewSection(section: SettingsSectionKey): boolean;
  resetSection(section: SettingsSectionKey): Promise<void>;

  // Actions
  toggleSection(id: string): void;
  openExternal(url: string): void;
  reloadPage(): void;
  hasPendingSettingsChanges(): boolean;
  buildSettingsSnapshot(): SettingsSnapshot;
}

const SettingsContext = createContext<SettingsContextValue>(null!);

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}

// ─── App ───────────────────────────────────────────────────────────────────

function App() {
  const state = window.__AGENT_STATE__;

  // Init signals from server state
  const agentName = useSignal(state.agentName || "");
  const agentDescription = useSignal(state.agentDescription || "");
  const initialAgentName = useSignal(state.agentName || "");
  const initialAgentDescription = useSignal(state.agentDescription || "");
  const savingIdentity = useSignal(false);

  const successMsg = useSignal("");
  const errorMsg = useSignal("");
  const saving = useSignal(false);
  const promoting = useSignal(false);

  const verboseLogging = useSignal(!!state.verboseLogging);
  const identityMd = useSignal(state.identityMd || "");
  const soulMd = useSignal(state.soulMd || "");
  const userMd = useSignal(state.userMd || "");

  // Providers
  const providerOrder = useSignal<string[]>(
    Array.isArray(state.providerOrder) ? state.providerOrder.slice() : []
  );
  const primaryProvider = useSignal(
    providerOrder.value.length ? providerOrder.value[0] : ""
  );
  const catalogProviders = useSignal<CatalogProvider[]>(
    state.catalogProviders || []
  );
  const showCatalog = useSignal(false);
  const pendingProvider = useSignal<
    (CatalogProvider & { success?: boolean }) | null
  >(null);
  const deviceCodePollTimer = useSignal<ReturnType<typeof setInterval> | null>(
    null
  );

  // Init provider state
  const providerModels = state.providerModels || {};
  const initialProviderModelPreferences = state.providerModelPreferences || {};
  const initProviderState: Record<string, ProviderState> = {};
  for (const pid of providerOrder.value) {
    const pInfo = state.PROVIDERS[pid] || ({} as ProviderInfo);
    const authTypes = pInfo.supportedAuthTypes || [pInfo.authType || "oauth"];
    const selectedModel = initialProviderModelPreferences[pid] || "";
    const selectedModelLabel =
      providerModels[pid]?.find((option) => option.value === selectedModel)
        ?.label || selectedModel;
    initProviderState[pid] = {
      status: "Checking...",
      connected: false,
      userConnected: false,
      systemConnected: false,
      showAuthFlow: false,
      showCodeInput: false,
      showDeviceCode: false,
      showApiKeyInput: false,
      activeAuthTab: authTypes[0] || "oauth",
      code: "",
      apiKey: "",
      userCode: "",
      verificationUrl: "",
      pollStatus: "Waiting for authorization...",
      deviceAuthId: "",
      selectedModel,
      modelQuery: selectedModelLabel,
      showModelDropdown: false,
    };
  }
  const providerState =
    useSignal<Record<string, ProviderState>>(initProviderState);

  // Skills
  const skills = useSignal<Skill[]>(state.initialSkills || []);
  const skillsLoading = useSignal(false);
  const skillsError = useSignal("");

  // MCPs
  const mcpServers = useSignal<Record<string, McpConfig>>(
    state.initialMcpServers || {}
  );

  // Skill registries (per-agent custom registries)
  const registries = useSignal<RegistryEntry[]>(state.initialRegistries || []);
  const globalRegistries: RegistryEntry[] = state.globalRegistries || [];

  // Nix
  const nixPackages = useSignal<string[]>(
    Array.isArray(state.initialNixPackages)
      ? state.initialNixPackages.slice()
      : []
  );

  // Permissions
  const permissionGrants = useSignal<PermissionGrant[]>([]);
  const permissionsLoading = useSignal(true);

  // Schedules
  const schedules = useSignal<Schedule[]>([]);
  const schedulesLoading = useSignal(false);
  const schedulesError = useSignal("");

  // Prefills
  const prefillSkills = useSignal<PrefillSkill[]>(state.prefillSkills || []);
  const prefillMcpServers = useSignal<PrefillMcp[]>(
    state.prefillMcpServers || []
  );
  const prefillGrants = useSignal<string[]>(state.prefillGrants || []);
  const prefillNixPackages = useSignal<string[]>(
    state.prefillNixPackages || []
  );
  const prefillProviders = useSignal<string[]>(state.prefillProviders || []);
  const prefillBannerDismissed = useSignal(
    new URL(window.location.href).searchParams.has("dismissed")
  );
  const approvingPrefills = useSignal(false);
  const approvedPrefillSkills = useSignal<string[]>([]);

  // Sections
  const openSections = useSignal<Record<string, boolean>>({});
  const initialSettingsSnapshot = useSignal<SettingsSnapshot | null>(null);

  // ─── Helpers ─────────────────────────────────────────────────────────

  function sectionAllowedByScopes(
    section: SettingsSectionKey,
    opts?: { treatAsScopedUser?: boolean; requireEdit?: boolean }
  ): boolean {
    if (state.settingsMode !== "user") return true;
    if (!opts?.treatAsScopedUser && state.isAdmin) return true;

    const allowedScopes = state.allowedScopes || [];
    if (section === "model") {
      return opts?.requireEdit
        ? allowedScopes.includes("model")
        : allowedScopes.includes("model") ||
            allowedScopes.includes("view-model");
    }

    if (allowedScopes.includes(section)) {
      return true;
    }

    if (section === "skills") {
      return (
        allowedScopes.includes("tools") || allowedScopes.includes("mcp-servers")
      );
    }

    if (section === "permissions" || section === "packages") {
      return allowedScopes.includes("tools");
    }

    return false;
  }

  function nixPackagesSignature(): string {
    return nixPackages.value
      .map((pkg) => (pkg || "").trim())
      .filter(Boolean)
      .join("\n");
  }

  function skillsSignature(): string {
    return JSON.stringify(
      skills.value.map((s) => ({
        repo: s.repo,
        enabled: s.enabled,
        mcpServers: s.mcpServers,
        nixPackages: s.nixPackages,
        permissions: s.permissions,
      }))
    );
  }

  function mcpServersSignature(): string {
    return JSON.stringify(
      Object.entries(mcpServers.value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, cfg]) => ({
          id,
          enabled: cfg.enabled !== false,
          url: cfg.url || "",
        }))
    );
  }

  function permissionsSignature(): string {
    return JSON.stringify(
      permissionGrants.value
        .slice()
        .sort((a, b) => a.pattern.localeCompare(b.pattern))
        .map((g) => ({
          pattern: g.pattern,
          expiresAt: g.expiresAt,
          denied: !!g.denied,
        }))
    );
  }

  function registriesSignature(): string {
    return JSON.stringify(
      registries.value
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => ({ id: r.id, type: r.type, apiUrl: r.apiUrl }))
    );
  }

  function providerModelPreferencesSignature(): string {
    const preferences: Record<string, string> = {};
    for (const providerId of providerOrder.value) {
      const selectedModel = (
        providerState.value[providerId]?.selectedModel || ""
      ).trim();
      if (!selectedModel) continue;
      preferences[providerId] = selectedModel;
    }
    return JSON.stringify(preferences);
  }

  function buildSettingsSnapshot(): SettingsSnapshot {
    return {
      identityMd: identityMd.value || "",
      soulMd: soulMd.value || "",
      userMd: userMd.value || "",
      verboseLogging: !!verboseLogging.value,
      primaryProvider: primaryProvider.value || "",
      providerOrder: providerOrder.value.join(","),
      nixPackages: nixPackagesSignature(),
      skills: skillsSignature(),
      mcpServers: mcpServersSignature(),
      permissions: permissionsSignature(),
      providerModelPreferences: providerModelPreferencesSignature(),
      registries: registriesSignature(),
    };
  }

  function hasPendingSettingsChanges(): boolean {
    if (!initialSettingsSnapshot.value) return false;
    const current = buildSettingsSnapshot();
    return (
      JSON.stringify(current) !== JSON.stringify(initialSettingsSnapshot.value)
    );
  }

  function canViewSection(section: SettingsSectionKey): boolean {
    return sectionAllowedByScopes(section);
  }

  function canEditSection(section: SettingsSectionKey): boolean {
    if (!canViewSection(section)) return false;
    return (
      state.sectionViews?.[section]?.editable ??
      sectionAllowedByScopes(section, {
        requireEdit: true,
      })
    );
  }

  function canUserViewSection(section: SettingsSectionKey): boolean {
    return sectionAllowedByScopes(section, { treatAsScopedUser: true });
  }

  async function resetSection(section: SettingsSectionKey): Promise<void> {
    await api.resetSettingsSection(state.agentId, section);
    reloadPage();
  }

  function toggleSection(id: string) {
    openSections.value = {
      ...openSections.value,
      [id]: !openSections.value[id],
    };
    updateSectionsUrl();
  }

  function updateSectionsUrl() {
    const ids = Object.keys(openSections.value).filter(
      (k) => openSections.value[k]
    );
    const url = new URL(window.location.href);
    if (ids.length > 0) {
      url.searchParams.set("open", ids.join(","));
    } else {
      url.searchParams.delete("open");
    }
    window.history.replaceState({}, "", url.toString());
  }

  function openExternal(url: string) {
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(url);
    } else {
      window.open(url, "_blank");
    }
  }

  function reloadPage() {
    if (window.Telegram?.WebApp && state.platform && state.channelId) {
      // WebApp context: navigate to bootstrap URL instead of reloading,
      // because reload loses initData and crashes the mini app.
      const basePath = state.agentId
        ? `/agent/${encodeURIComponent(state.agentId)}`
        : "/agent";
      const url = new URL(basePath, window.location.origin);
      url.searchParams.set("platform", state.platform);
      url.searchParams.set("chat", state.channelId);
      window.location.href = url.toString();
    } else {
      window.location.reload();
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────

  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Restore open sections from URL
    const urlParams = new URLSearchParams(window.location.search);
    const openParam = urlParams.get("open");
    if (openParam) {
      const sections: Record<string, boolean> = {};
      for (const id of openParam.split(",")) {
        sections[id] = true;
      }
      openSections.value = sections;
    }

    // Auto-open model section when no providers
    if (state.hasNoProviders && !openParam) {
      openSections.value = { ...openSections.value, model: true };
    }

    // Check providers
    api
      .checkProviders(state.agentId)
      .then((providers) => {
        const updated = { ...providerState.value };
        for (const [provider, info] of Object.entries(providers)) {
          if (!updated[provider]) continue;
          updated[provider] = {
            ...updated[provider],
            connected: !!info.connected,
            userConnected: !!info.userConnected,
            systemConnected: !!info.systemConnected,
            activeAuthType: info.activeAuthType || null,
            authMethods: info.authMethods || [],
            status: !info.connected
              ? "Not connected"
              : info.userConnected
                ? `Connected (${info.activeAuthType || "unknown"})`
                : "Using system key",
          };
        }
        // Resolve any providers still stuck at "Checking..."
        for (const [pid, ps] of Object.entries(updated)) {
          if (ps.status === "Checking...") {
            updated[pid] = { ...ps, status: "Not connected" };
          }
        }
        providerState.value = updated;

        // Auto-trigger auth flow for prefilled providers
        if (prefillProviders.value.length > 0) {
          openSections.value = { ...openSections.value, model: true };
          triggerProviderAuth(ctx, prefillProviders.value[0]);

          // Auto-dismiss banner if only providers are prefilled
          const onlyProviders =
            prefillSkills.value.length === 0 &&
            prefillGrants.value.length === 0 &&
            prefillNixPackages.value.length === 0 &&
            prefillMcpServers.value.length === 0;
          if (onlyProviders) {
            prefillBannerDismissed.value = true;
          }
        }
      })
      .catch((err) => {
        console.warn("checkProviders failed:", err);
        // Clear "Checking..." so providers don't appear stuck
        const updated = { ...providerState.value };
        for (const [pid, ps] of Object.entries(updated)) {
          if (ps.status === "Checking...") {
            updated[pid] = { ...ps, status: "Not connected" };
          }
        }
        providerState.value = updated;
      });

    // Load permissions
    api
      .fetchGrants(state.agentId)
      .then((grants) => {
        permissionGrants.value = grants.map((g) => ({
          pattern: g.pattern,
          expiresAt: g.expiresAt,
          denied: !!g.denied,
          grantedAt: g.grantedAt,
        }));
      })
      .catch(() => {
        // noop
      })
      .finally(() => {
        permissionsLoading.value = false;
        // Snapshot after permissions load so it captures the initial state
        initialSettingsSnapshot.value = buildSettingsSnapshot();
      });

    // Load schedules
    schedulesLoading.value = true;
    api
      .fetchSchedules(state.agentId)
      .then((data) => {
        schedules.value = data as Schedule[];
      })
      .catch(() => {
        schedulesError.value = "Failed to load schedules.";
      })
      .finally(() => {
        schedulesLoading.value = false;
      });

    // Telegram WebApp
    if (window.Telegram?.WebApp?.initData) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
  }, []);

  // ─── Context Value ───────────────────────────────────────────────────

  const ctx: SettingsContextValue = {
    agentId: state.agentId,
    scope: state.scope,
    PROVIDERS: state.PROVIDERS,
    providerModels,
    catalogProviders,
    providerOrder,
    primaryProvider,
    providerState,
    showCatalog,
    pendingProvider,
    deviceCodePollTimer,

    agentName,
    agentDescription,
    initialAgentName,
    initialAgentDescription,
    savingIdentity,
    hasChannelId: state.hasChannelId,

    successMsg,
    errorMsg,
    saving,

    verboseLogging,
    identityMd,
    soulMd,
    userMd,

    skills,
    skillsLoading,
    skillsError,

    mcpServers,

    registries,
    globalRegistries,

    nixPackages,

    permissionGrants,
    permissionsLoading,

    schedules,
    schedulesLoading,
    schedulesError,

    prefillSkills,
    prefillMcpServers,
    prefillGrants,
    prefillNixPackages,
    prefillProviders,
    prefillBannerDismissed,
    approvingPrefills,
    approvedPrefillSkills,

    openSections,
    initialSettingsSnapshot,

    platform: state.platform,
    userId: state.userId,
    channelId: state.channelId,
    teamId: state.teamId,
    message: state.message,
    conversationId: state.conversationId,
    connectionId: state.connectionId,
    showSwitcher: state.showSwitcher,
    agents: state.agents,
    providerIconUrls: state.providerIconUrls || {},

    memoryEnabled: !!state.memoryEnabled,
    settingsMode: state.settingsMode || "admin",
    allowedScopes: state.allowedScopes,
    isAdmin: !!state.isAdmin,
    isSandbox: !!state.isSandbox,
    ownerPlatform: state.ownerPlatform || "",
    templateAgentId: state.templateAgentId,
    templateAgentName: state.templateAgentName,
    sectionViews: state.sectionViews || {},
    providerViews: state.providerViews || {},
    configManagedProviders: state.configManagedProviders || [],
    promoting,
    canViewSection,
    canEditSection,
    canUserViewSection,
    resetSection,

    toggleSection,
    openExternal,
    reloadPage,
    hasPendingSettingsChanges,
    buildSettingsSnapshot,
  };

  return (
    <SettingsContext.Provider value={ctx}>
      <AdminBar />
      <div class={ctx.isAdmin ? "p-6" : ""}>
        <MessageBanners />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave(ctx);
          }}
          onKeyDown={(e) => {
            const target = e.target as HTMLElement;
            if (
              e.key === "Enter" &&
              target.tagName !== "TEXTAREA" &&
              (target as HTMLInputElement).type !== "submit"
            ) {
              e.preventDefault();
            }
          }}
          class="space-y-3"
        >
          {ctx.isAdmin && !ctx.isSandbox && <ConnectionsSection />}
          {ctx.canViewSection("model") && (
            <ProviderSection
              adminOnly={
                ctx.isAdmin && ctx.isSandbox && !ctx.canUserViewSection("model")
              }
            />
          )}
          {ctx.canViewSection("system-prompt") && (
            <InstructionsSection
              adminOnly={
                ctx.isAdmin &&
                ctx.isSandbox &&
                !ctx.canUserViewSection("system-prompt")
              }
            />
          )}
          {ctx.canViewSection("skills") && (
            <SkillsSection
              adminOnly={
                ctx.isAdmin &&
                ctx.isSandbox &&
                !ctx.canUserViewSection("skills")
              }
            />
          )}
          {ctx.canViewSection("schedules") && (
            <RemindersSection
              adminOnly={
                ctx.isAdmin &&
                ctx.isSandbox &&
                !ctx.canUserViewSection("schedules")
              }
            />
          )}
          {ctx.canViewSection("permissions") && (
            <PermissionsSection
              adminOnly={
                ctx.isAdmin &&
                ctx.isSandbox &&
                !ctx.canUserViewSection("permissions")
              }
            />
          )}
          {ctx.canViewSection("packages") && (
            <NixPackagesSection
              adminOnly={
                ctx.isAdmin &&
                ctx.isSandbox &&
                !ctx.canUserViewSection("packages")
              }
            />
          )}

          {ctx.canViewSection("logging") && (
            <div class="bg-gray-50 rounded-lg p-3">
              <label
                class={`flex items-center gap-2 ${ctx.canEditSection("logging") ? "cursor-pointer" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={ctx.verboseLogging.value}
                  disabled={!ctx.canEditSection("logging")}
                  onChange={(e) => {
                    ctx.verboseLogging.value = (
                      e.target as HTMLInputElement
                    ).checked;
                  }}
                  class="w-4 h-4 text-slate-600 rounded focus:ring-slate-500 disabled:opacity-50"
                />
                <span class="text-sm font-medium text-gray-800">
                  Verbose logging
                </span>
                {!ctx.canEditSection("logging") && (
                  <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                    read-only
                  </span>
                )}
                {ctx.sectionViews.logging?.canReset &&
                  ctx.canEditSection("logging") && (
                    <button
                      type="button"
                      onClick={() => {
                        void ctx.resetSection("logging");
                      }}
                      class="ml-auto text-xs text-slate-600 hover:text-slate-800"
                    >
                      Reset
                    </button>
                  )}
              </label>
              <p class="text-xs text-gray-500 mt-1 ml-6">
                Show tool calls, reasoning tokens, and detailed output
              </p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={
              ctx.saving.value ||
              ctx.promoting.value ||
              !hasPendingSettingsChanges()
            }
            class="w-full py-3 bg-gradient-to-r from-slate-700 to-slate-800 text-white text-sm font-semibold rounded-lg hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
          >
            {ctx.saving.value
              ? "Saving..."
              : hasPendingSettingsChanges()
                ? "Save Settings"
                : "No Changes"}
          </button>
          {ctx.isAdmin && ctx.isSandbox && ctx.templateAgentId && (
            <div class="space-y-2">
              <button
                type="button"
                disabled={ctx.saving.value || ctx.promoting.value}
                onClick={() => {
                  void handlePromote(ctx);
                }}
                class="w-full py-3 border border-slate-300 text-slate-700 text-sm font-semibold rounded-lg hover:border-slate-400 hover:bg-slate-50 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {ctx.promoting.value
                  ? "Promoting..."
                  : hasPendingSettingsChanges()
                    ? "Save And Promote To Agent"
                    : "Promote To Agent"}
              </button>
              <p class="text-xs text-gray-500 text-center">
                Updates the base agent config used for future sandbox sessions.
              </p>
            </div>
          )}
        </form>
        {ctx.isAdmin && ctx.isSandbox && <DeleteSandboxSection />}
        {ctx.isAdmin && !ctx.isSandbox && <DeleteAgentSection />}
      </div>
    </SettingsContext.Provider>
  );
}

function DeleteSandboxSection() {
  const ctx = useSettings();
  const confirming = useSignal(false);
  const deleting = useSignal(false);
  const error = useSignal("");

  async function handleDelete() {
    deleting.value = true;
    error.value = "";
    try {
      await api.deleteAgent(ctx.agentId);
      const backUrl = new URLSearchParams(location.search).get("back");
      window.location.href =
        backUrl ||
        (ctx.templateAgentId
          ? `/agent/${encodeURIComponent(ctx.templateAgentId)}`
          : "/agents");
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : "Failed to delete sandbox";
      deleting.value = false;
    }
  }

  return (
    <div class="mt-8 border-t border-gray-200 pt-6">
      {error.value && (
        <div class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs mb-3">
          {error.value}
        </div>
      )}
      {confirming.value ? (
        <div class="space-y-2">
          <p class="text-xs text-gray-600">
            This will delete sandbox settings for <strong>{ctx.agentId}</strong>
            . Future sessions will use the base agent config.
          </p>
          <div class="flex gap-2">
            <button
              type="button"
              disabled={deleting.value}
              onClick={handleDelete}
              class="px-4 py-2 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-all disabled:opacity-60"
            >
              {deleting.value ? "Deleting..." : "Yes, Delete Sandbox"}
            </button>
            <button
              type="button"
              onClick={() => {
                confirming.value = false;
              }}
              class="px-4 py-2 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            confirming.value = true;
          }}
          class="text-xs text-red-500 hover:text-red-700 transition-colors"
        >
          Delete this sandbox
        </button>
      )}
    </div>
  );
}

function DeleteAgentSection() {
  const ctx = useSettings();
  const confirming = useSignal(false);
  const deleting = useSignal(false);
  const error = useSignal("");

  async function handleDelete() {
    deleting.value = true;
    error.value = "";
    try {
      await api.deleteAgent(ctx.agentId);
      window.location.href = "/agents";
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : "Failed to delete agent";
      deleting.value = false;
    }
  }

  return (
    <div class="mt-8 border-t border-gray-200 pt-6">
      {error.value && (
        <div class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs mb-3">
          {error.value}
        </div>
      )}
      {confirming.value ? (
        <div class="space-y-2">
          <p class="text-xs text-gray-600">
            This will permanently delete <strong>{ctx.agentId}</strong> and all
            its data. This cannot be undone.
          </p>
          <div class="flex gap-2">
            <button
              type="button"
              disabled={deleting.value}
              onClick={handleDelete}
              class="px-4 py-2 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-all disabled:opacity-60"
            >
              {deleting.value ? "Deleting..." : "Yes, Delete Agent"}
            </button>
            <button
              type="button"
              onClick={() => {
                confirming.value = false;
              }}
              class="px-4 py-2 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            confirming.value = true;
          }}
          class="text-xs text-red-500 hover:text-red-700 transition-colors"
        >
          Delete this agent
        </button>
      )}
    </div>
  );
}

async function syncPermissionGrants(
  agentId: string,
  desiredGrants: PermissionGrant[]
): Promise<void> {
  const serverGrants = await api.fetchGrants(agentId);
  const serverByPattern = new Map(serverGrants.map((g) => [g.pattern, g]));
  const currentByPattern = new Map(desiredGrants.map((g) => [g.pattern, g]));

  for (const [pattern] of serverByPattern) {
    if (!currentByPattern.has(pattern)) {
      await api.removeGrant(agentId, pattern);
    }
  }

  for (const [pattern, grant] of currentByPattern) {
    const serverGrant = serverByPattern.get(pattern);
    if (
      !serverGrant ||
      serverGrant.expiresAt !== grant.expiresAt ||
      !!serverGrant.denied !== !!grant.denied
    ) {
      if (serverGrant) {
        await api.removeGrant(agentId, pattern);
      }
      await api.addGrant(agentId, pattern, grant.expiresAt, grant.denied);
    }
  }
}

async function persistCurrentSettings(
  ctx: SettingsContextValue
): Promise<void> {
  const snap = ctx.initialSettingsSnapshot.value;
  const currentSnap = ctx.buildSettingsSnapshot();

  const providerOrderChanged =
    !snap ||
    snap.primaryProvider !== currentSnap.primaryProvider ||
    snap.providerOrder !== currentSnap.providerOrder;
  const providerPreferencesChanged =
    !snap ||
    snap.providerModelPreferences !== currentSnap.providerModelPreferences;
  const instructionsChanged =
    !snap ||
    snap.identityMd !== currentSnap.identityMd ||
    snap.soulMd !== currentSnap.soulMd ||
    snap.userMd !== currentSnap.userMd;
  const loggingChanged =
    !snap || snap.verboseLogging !== currentSnap.verboseLogging;
  const packagesChanged = !snap || snap.nixPackages !== currentSnap.nixPackages;
  const skillsChanged = !snap || snap.skills !== currentSnap.skills;
  const mcpServersChanged = !snap || snap.mcpServers !== currentSnap.mcpServers;
  const permissionsChanged =
    !snap || snap.permissions !== currentSnap.permissions;
  const registriesChanged = !snap || snap.registries !== currentSnap.registries;

  if (
    providerOrderChanged &&
    ctx.providerOrder.value.length > 0 &&
    ctx.primaryProvider.value
  ) {
    const orderedIds = [
      ctx.primaryProvider.value,
      ...ctx.providerOrder.value.filter(
        (pid) => pid !== ctx.primaryProvider.value
      ),
    ];
    try {
      await api.reorderProviders(ctx.agentId, orderedIds);
    } catch {
      // Non-fatal
    }
  }

  const settings: Record<string, unknown> = {};

  if (providerPreferencesChanged) {
    const providerModelPreferences: Record<string, string> = {};
    for (const providerId of ctx.providerOrder.value) {
      const selectedModel = (
        ctx.providerState.value[providerId]?.selectedModel || ""
      ).trim();
      if (!selectedModel) continue;
      providerModelPreferences[providerId] = selectedModel;
    }
    settings.modelSelection = { mode: "auto" };
    settings.providerModelPreferences = providerModelPreferences;
  }

  if (instructionsChanged) {
    settings.identityMd = ctx.identityMd.value || "";
    settings.soulMd = ctx.soulMd.value || "";
    settings.userMd = ctx.userMd.value || "";
  }

  if (loggingChanged) {
    settings.verboseLogging = !!ctx.verboseLogging.value;
  }

  if (registriesChanged) {
    settings.skillRegistries = ctx.registries.value.length
      ? ctx.registries.value
      : null;
  }

  if (packagesChanged) {
    const nixPkgs = ctx.nixPackages.value
      .map((pkg) => (pkg || "").trim())
      .filter(Boolean);
    settings.nixConfig = nixPkgs.length ? { packages: nixPkgs } : null;
  }

  if (Object.keys(settings).length > 0) {
    await api.saveSettings(ctx.agentId, settings);
  }

  if (skillsChanged) {
    await api.saveSkills(ctx.agentId, ctx.skills.value);
  }

  if (mcpServersChanged) {
    await api.saveMcpServers(ctx.agentId, ctx.mcpServers.value);
  }

  if (permissionsChanged) {
    await syncPermissionGrants(ctx.agentId, ctx.permissionGrants.value);
  }

  ctx.initialSettingsSnapshot.value = ctx.buildSettingsSnapshot();

  if (
    ctx.approvedPrefillSkills.value.length > 0 &&
    ctx.conversationId &&
    ctx.channelId
  ) {
    api
      .notifySkillInstalled(ctx.agentId, {
        platform: ctx.platform,
        channelId: ctx.channelId,
        conversationId: ctx.conversationId,
        connectionId: ctx.connectionId,
        skills: ctx.approvedPrefillSkills.value,
      })
      .catch(() => {
        /* non-fatal */
      });
    ctx.approvedPrefillSkills.value = [];
  }
}

async function handleSave(ctx: SettingsContextValue) {
  ctx.saving.value = true;
  ctx.successMsg.value = "";
  ctx.errorMsg.value = "";

  try {
    await persistCurrentSettings(ctx);
    ctx.successMsg.value = "Settings saved!";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e: unknown) {
    ctx.errorMsg.value = e instanceof Error ? e.message : "Failed to save";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    ctx.saving.value = false;
  }
}

async function handlePromote(ctx: SettingsContextValue) {
  if (!ctx.templateAgentId) return;

  ctx.promoting.value = true;
  ctx.successMsg.value = "";
  ctx.errorMsg.value = "";

  try {
    if (ctx.hasPendingSettingsChanges()) {
      await persistCurrentSettings(ctx);
    }
    await api.promoteSandboxSettings(ctx.agentId);
    ctx.successMsg.value = "Sandbox settings promoted to the base agent.";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e: unknown) {
    ctx.errorMsg.value =
      e instanceof Error ? e.message : "Failed to promote sandbox settings";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    ctx.promoting.value = false;
  }
}

render(<App />, document.getElementById("app")!);
