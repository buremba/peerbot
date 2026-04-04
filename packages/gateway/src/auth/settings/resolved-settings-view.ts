import type { AgentMetadataStore } from "../agent-metadata-store";
import type {
  AgentSettings,
  AgentSettingsContext,
  AgentSettingsStore,
} from "./agent-settings-store";

export const SETTINGS_SECTION_KEYS = [
  "model",
  "system-prompt",
  "skills",
  "packages",
  "permissions",
  "schedules",
  "logging",
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTION_KEYS)[number];
export type SettingsScope = "agent" | "sandbox";
export type SettingsSource = "local" | "inherited" | "mixed";

export interface ResolvedSectionView {
  source: SettingsSource;
  editable: boolean;
  canReset: boolean;
  hasLocalOverride: boolean;
}

export interface ResolvedProviderView {
  id: string;
  source: SettingsSource;
  canEdit: boolean;
  canReset: boolean;
  hasLocalOverride: boolean;
}

export interface ResolvedSettingsView {
  agentId: string;
  scope: SettingsScope;
  isSandbox: boolean;
  templateAgentId?: string;
  templateAgentName?: string;
  localSettings: AgentSettings | null;
  effectiveSettings: AgentSettings | null;
  sections: Record<SettingsSectionKey, ResolvedSectionView>;
  providerSources: Record<string, ResolvedProviderView>;
}

export interface ResolvedSettingsViewer {
  settingsMode?: "admin" | "user";
  allowedScopes?: string[];
  isAdmin?: boolean;
}

export interface ResolvedSettingsViewInput {
  agentId: string;
  agentSettingsStore: AgentSettingsStore;
  agentMetadataStore?: AgentMetadataStore;
  viewer?: ResolvedSettingsViewer;
}

const SECTION_SETTING_KEYS: Record<
  Exclude<SettingsSectionKey, "permissions" | "schedules">,
  Array<keyof AgentSettings>
> = {
  model: [
    "installedProviders",
    "authProfiles",
    "model",
    "modelSelection",
    "providerModelPreferences",
  ],
  "system-prompt": ["identityMd", "soulMd", "userMd"],
  skills: ["skillsConfig", "mcpServers", "pluginsConfig"],
  packages: ["nixConfig"],
  logging: ["verboseLogging"],
};

function hasOwnSetting(
  settings: AgentSettings | null | undefined,
  key: keyof AgentSettings
): boolean {
  return !!settings && Object.hasOwn(settings, key);
}

function sectionHasLocalOverride(
  section: SettingsSectionKey,
  localSettings: AgentSettings | null | undefined
): boolean {
  if (section === "permissions" || section === "schedules") {
    return false;
  }
  return SECTION_SETTING_KEYS[section].some((key) =>
    hasOwnSetting(localSettings, key)
  );
}

function sectionHasTemplateValue(
  section: SettingsSectionKey,
  templateSettings: AgentSettings | null | undefined
): boolean {
  if (section === "permissions" || section === "schedules") {
    return false;
  }
  return SECTION_SETTING_KEYS[section].some((key) =>
    hasOwnSetting(templateSettings, key)
  );
}

export function canViewSettingsSection(
  section: SettingsSectionKey,
  viewer?: ResolvedSettingsViewer
): boolean {
  if (!viewer || viewer.isAdmin || viewer.settingsMode === "admin") {
    return true;
  }

  const allowedScopes = viewer.allowedScopes || [];
  if (section === "model") {
    return (
      allowedScopes.includes("model") || allowedScopes.includes("view-model")
    );
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

export function canEditSettingsSection(
  section: SettingsSectionKey,
  viewer?: ResolvedSettingsViewer
): boolean {
  if (!viewer || viewer.isAdmin || viewer.settingsMode === "admin") {
    return true;
  }

  const allowedScopes = viewer.allowedScopes || [];
  if (section === "model") {
    return allowedScopes.includes("model");
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

function resolveSectionSource(
  isSandbox: boolean,
  hasLocalOverride: boolean,
  hasTemplateValue: boolean
): SettingsSource {
  if (!isSandbox) return "local";
  if (!hasLocalOverride && hasTemplateValue) return "inherited";
  if (hasLocalOverride && hasTemplateValue) return "mixed";
  return "local";
}

function resolveProviderSources(
  context: AgentSettingsContext,
  templateSettings: AgentSettings | null,
  viewer?: ResolvedSettingsViewer
): Record<string, ResolvedProviderView> {
  const effectiveSettings = context.effectiveSettings;
  const localSettings = context.localSettings;
  const isSandbox = !!context.templateAgentId;

  const effectiveProviderIds = (
    effectiveSettings?.installedProviders || []
  ).map((provider) => provider.providerId);
  const localProviderIds = new Set(
    (localSettings?.installedProviders || []).map(
      (provider) => provider.providerId
    )
  );
  const localProfileProviders = new Set(
    (localSettings?.authProfiles || []).map((profile) => profile.provider)
  );
  const localPreferenceProviders = new Set(
    Object.keys(localSettings?.providerModelPreferences || {})
  );
  const templateProviderIds = new Set(
    (templateSettings?.installedProviders || []).map(
      (provider) => provider.providerId
    )
  );

  return Object.fromEntries(
    effectiveProviderIds.map((providerId) => {
      const hasLocalOverride =
        localProviderIds.has(providerId) ||
        localProfileProviders.has(providerId) ||
        localPreferenceProviders.has(providerId);

      const source = resolveSectionSource(
        isSandbox,
        hasLocalOverride,
        templateProviderIds.has(providerId)
      );

      return [
        providerId,
        {
          id: providerId,
          source,
          canEdit: canEditSettingsSection("model", viewer),
          canReset: isSandbox && hasLocalOverride,
          hasLocalOverride,
        } satisfies ResolvedProviderView,
      ];
    })
  );
}

export async function resolveSettingsView(
  input: ResolvedSettingsViewInput
): Promise<ResolvedSettingsView> {
  const context = await input.agentSettingsStore.getSettingsContext(
    input.agentId
  );
  const templateAgentName =
    context.templateAgentId && input.agentMetadataStore
      ? (await input.agentMetadataStore.getMetadata(context.templateAgentId))
          ?.name
      : undefined;

  const templateSettings = context.templateAgentId
    ? await input.agentSettingsStore.getSettings(context.templateAgentId)
    : null;
  const isSandbox = !!context.templateAgentId;

  const sections = Object.fromEntries(
    SETTINGS_SECTION_KEYS.map((section) => {
      const hasLocalOverride = sectionHasLocalOverride(
        section,
        context.localSettings
      );
      const hasTemplateValue = sectionHasTemplateValue(
        section,
        templateSettings
      );

      return [
        section,
        {
          source: resolveSectionSource(
            isSandbox,
            hasLocalOverride,
            hasTemplateValue
          ),
          editable: canEditSettingsSection(section, input.viewer),
          canReset: isSandbox && hasLocalOverride,
          hasLocalOverride,
        } satisfies ResolvedSectionView,
      ];
    })
  ) as Record<SettingsSectionKey, ResolvedSectionView>;

  return {
    agentId: input.agentId,
    scope: isSandbox ? "sandbox" : "agent",
    isSandbox,
    templateAgentId: context.templateAgentId,
    templateAgentName,
    localSettings: context.localSettings,
    effectiveSettings: context.effectiveSettings,
    sections,
    providerSources: resolveProviderSources(
      context,
      templateSettings,
      input.viewer
    ),
  };
}
