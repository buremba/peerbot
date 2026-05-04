export const SETTINGS_SECTION_KEYS = [
  "model",
  "system-prompt",
  "skills",
  "packages",
  "permissions",
  "logging",
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTION_KEYS)[number];

export interface ResolvedSectionView {
  editable: boolean;
}

export interface ResolvedProviderView {
  id: string;
  canEdit: boolean;
}

interface ResolvedSettingsViewer {
  settingsMode?: "admin" | "user";
  allowedScopes?: string[];
  isAdmin?: boolean;
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

/**
 * Definition-level sections are admin-only writes. Non-admins (org members)
 * cannot mutate the agent's identity, soulMd, userMd, skills, tools, plugins,
 * model, network, nix, mcp, providers, guardrails, or pre-approved tools —
 * those describe the agent itself, not per-user state.
 */
const DEFINITION_SECTIONS: ReadonlySet<SettingsSectionKey> = new Set([
  "model",
  "system-prompt",
  "skills",
  "packages",
  "logging",
]);

export function canEditSettingsSection(
  section: SettingsSectionKey,
  viewer?: ResolvedSettingsViewer
): boolean {
  if (!viewer || viewer.isAdmin || viewer.settingsMode === "admin") {
    return true;
  }

  // Definition fields are admin-only.
  if (DEFINITION_SECTIONS.has(section)) {
    return false;
  }

  const allowedScopes = viewer.allowedScopes || [];
  if (allowedScopes.includes(section)) {
    return true;
  }

  if (section === "permissions") {
    return allowedScopes.includes("tools");
  }

  return false;
}
