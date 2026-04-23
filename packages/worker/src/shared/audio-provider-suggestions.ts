interface AudioProviderSuggestions {
  providerIds: string[];
  providerDisplayList: string;
  available: boolean | null;
  usedFallback: boolean;
}

const FALLBACK_PROVIDER_ENTRIES = [
  { id: "chatgpt" },
  { id: "gemini" },
  { id: "elevenlabs" },
] as const;

const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT/OpenAI",
  openai: "OpenAI",
  gemini: "Google Gemini",
  google: "Google Gemini",
  elevenlabs: "ElevenLabs",
};

function normalizeProviderId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return value ? value : null;
}

function prefillProviderIdsFromCapabilityProvider(
  providerId: string
): string[] {
  if (providerId === "openai") {
    return ["chatgpt", "openai"];
  }
  if (providerId === "google") {
    return ["gemini"];
  }
  return [providerId];
}

function normalizeProviderName(providerId: string, rawName: unknown): string {
  if (typeof rawName === "string" && rawName.trim()) {
    return rawName.trim();
  }
  return KNOWN_PROVIDER_LABELS[providerId] || providerId;
}

function getFallbackSuggestions(
  available: boolean | null
): AudioProviderSuggestions {
  return {
    providerIds: FALLBACK_PROVIDER_ENTRIES.map((entry) => entry.id),
    providerDisplayList: "",
    available,
    usedFallback: true,
  };
}

export function normalizeAudioProviderSuggestions(
  payload: unknown
): AudioProviderSuggestions {
  if (typeof payload !== "object" || payload === null) {
    return getFallbackSuggestions(null);
  }

  const body = payload as {
    available?: unknown;
    provider?: unknown;
    providers?: unknown;
  };

  const available = typeof body.available === "boolean" ? body.available : null;

  const ids: string[] = [];
  const names: string[] = [];
  const addEntry = (providerId: string, providerName: unknown) => {
    const mappedIds = prefillProviderIdsFromCapabilityProvider(providerId);
    for (const mappedId of mappedIds) {
      if (!ids.includes(mappedId)) ids.push(mappedId);
    }
    const name = normalizeProviderName(providerId, providerName);
    if (!names.includes(name)) names.push(name);
  };

  if (Array.isArray(body.providers)) {
    for (const provider of body.providers) {
      if (typeof provider !== "object" || provider === null) continue;
      const entry = provider as { provider?: unknown; name?: unknown };
      const providerId = normalizeProviderId(entry.provider);
      if (!providerId) continue;
      addEntry(providerId, entry.name);
    }
  }

  const primaryProviderId = normalizeProviderId(body.provider);
  if (primaryProviderId) {
    addEntry(primaryProviderId, undefined);
  }

  if (ids.length === 0) {
    return getFallbackSuggestions(available);
  }

  return {
    providerIds: ids,
    providerDisplayList: names.join(", "),
    available,
    usedFallback: false,
  };
}

export async function fetchAudioProviderSuggestions(params: {
  gatewayUrl: string;
  workerToken: string;
  fetchFn?: typeof fetch;
}): Promise<AudioProviderSuggestions> {
  const fetchFn = params.fetchFn || fetch;
  try {
    const response = await fetchFn(
      `${params.gatewayUrl}/internal/audio/capabilities`,
      {
        headers: { Authorization: `Bearer ${params.workerToken}` },
      }
    );
    if (!response.ok) {
      return getFallbackSuggestions(null);
    }
    const payload = (await response.json()) as unknown;
    return normalizeAudioProviderSuggestions(payload);
  } catch {
    return getFallbackSuggestions(null);
  }
}
