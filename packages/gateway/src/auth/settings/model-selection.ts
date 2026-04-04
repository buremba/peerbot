import type { AgentSettings } from "./agent-settings-store";

export type ModelSelectionMode = "auto" | "pinned";

export interface ModelSelectionState {
  mode: ModelSelectionMode;
  pinnedModel?: string;
}

export type ProviderModelPreferences = Record<string, string>;

function normalizePreferenceMap(
  map: ProviderModelPreferences | undefined
): ProviderModelPreferences {
  const normalized: ProviderModelPreferences = {};
  for (const [providerId, modelRef] of Object.entries(map || {})) {
    const cleanProviderId = providerId.trim();
    const cleanModelRef = modelRef.trim();
    if (!cleanProviderId || !cleanModelRef) continue;
    normalized[cleanProviderId] = cleanModelRef;
  }
  return normalized;
}

function extractProviderIdFromModelRef(
  modelRef: string | undefined
): string | undefined {
  const clean = modelRef?.trim();
  if (!clean) return undefined;
  const slashIndex = clean.indexOf("/");
  if (slashIndex <= 0) return undefined;
  return clean.slice(0, slashIndex);
}

export function getModelSelectionState(
  settings: Pick<AgentSettings, "model" | "modelSelection"> | null | undefined
): ModelSelectionState {
  const mode = settings?.modelSelection?.mode;
  const explicitPinnedModel = settings?.modelSelection?.pinnedModel?.trim();
  const legacyModel = settings?.model?.trim();

  if (mode === "auto") {
    return { mode: "auto" };
  }

  if (mode === "pinned" && explicitPinnedModel) {
    return { mode: "pinned", pinnedModel: explicitPinnedModel };
  }

  if (legacyModel) {
    return { mode: "pinned", pinnedModel: legacyModel };
  }

  return { mode: "auto" };
}

export function resolveEffectiveModelRef(
  settings:
    | Pick<
        AgentSettings,
        | "model"
        | "modelSelection"
        | "installedProviders"
        | "providerModelPreferences"
      >
    | null
    | undefined
): string | undefined {
  if (!settings) return undefined;

  const state = getModelSelectionState(settings);
  const installedProviderIds = new Set(
    (settings.installedProviders || []).map((p) => p.providerId)
  );

  if (state.mode === "pinned" && state.pinnedModel) {
    const pinnedProviderId = extractProviderIdFromModelRef(state.pinnedModel);
    if (pinnedProviderId && installedProviderIds.has(pinnedProviderId)) {
      return state.pinnedModel;
    }
  }

  const primaryProviderId = settings.installedProviders?.[0]?.providerId;
  if (!primaryProviderId) return undefined;

  const preferences = normalizePreferenceMap(settings.providerModelPreferences);
  return preferences[primaryProviderId];
}

export function reconcileModelSelectionForInstalledProviders(
  settings: Pick<
    AgentSettings,
    | "model"
    | "modelSelection"
    | "installedProviders"
    | "providerModelPreferences"
  >
): Pick<
  AgentSettings,
  "model" | "modelSelection" | "providerModelPreferences"
> {
  const installedProviderIds = new Set(
    (settings.installedProviders || []).map((p) => p.providerId)
  );
  const currentState = getModelSelectionState(settings);
  const normalizedPrefs = normalizePreferenceMap(
    settings.providerModelPreferences
  );
  const filteredPrefs: ProviderModelPreferences = {};

  for (const [providerId, modelRef] of Object.entries(normalizedPrefs)) {
    if (installedProviderIds.has(providerId)) {
      filteredPrefs[providerId] = modelRef;
    }
  }

  const pinnedProviderId = extractProviderIdFromModelRef(
    currentState.pinnedModel
  );
  const hasPinnedProvider =
    currentState.mode === "pinned" &&
    !!pinnedProviderId &&
    installedProviderIds.has(pinnedProviderId);

  const nextState: ModelSelectionState = hasPinnedProvider
    ? { mode: "pinned", pinnedModel: currentState.pinnedModel }
    : { mode: "auto" };

  return {
    modelSelection: nextState,
    model: nextState.mode === "pinned" ? nextState.pinnedModel : undefined,
    providerModelPreferences:
      Object.keys(filteredPrefs).length > 0 ? filteredPrefs : undefined,
  };
}
