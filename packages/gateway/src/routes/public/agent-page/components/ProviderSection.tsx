import * as api from "../api";
import { type SettingsContextValue, useSettings } from "../app";
import type { CatalogProvider, ProviderState } from "../types";
import { Section } from "./Section";

const CAPABILITY_META: Record<
  "text" | "image-generation" | "speech-to-text" | "text-to-speech",
  { emoji: string; title: string }
> = {
  text: { emoji: "📝", title: "Text" },
  "image-generation": { emoji: "🖼️", title: "Image generation" },
  "speech-to-text": { emoji: "🎙️", title: "Speech to text" },
  "text-to-speech": { emoji: "🔊", title: "Text to speech" },
};

function CapabilityChips({
  capabilities,
}: {
  capabilities: (
    | "text"
    | "image-generation"
    | "speech-to-text"
    | "text-to-speech"
  )[];
}) {
  if (!capabilities.length) return null;
  return (
    <div class="flex flex-wrap gap-1 mt-1">
      {capabilities.map((capability) => (
        <span
          key={capability}
          title={CAPABILITY_META[capability].title}
          class="inline-flex items-center justify-center text-base leading-none"
        >
          {CAPABILITY_META[capability].emoji}
        </span>
      ))}
    </div>
  );
}

// ─── Shared auth helpers ──────────────────────────────────────────────────

type UpdatePS = (u: Partial<ProviderState>) => void;

function handleAuthSuccess(
  ctx: SettingsContextValue,
  providerId: string,
  providerName: string
) {
  const pendingProvider = ctx.pendingProvider.value;
  if (pendingProvider?.id === providerId) {
    if (pendingProvider.success) {
      return;
    }

    ctx.pendingProvider.value = { ...pendingProvider, success: true };
    setTimeout(async () => {
      ctx.pendingProvider.value = null;
      try {
        await api.installProvider(ctx.agentId, providerId);
        ctx.successMsg.value = "Provider added and connected!";
        window.scrollTo({ top: 0, behavior: "smooth" });
        setTimeout(() => ctx.reloadPage(), 800);
      } catch (e: unknown) {
        ctx.errorMsg.value =
          e instanceof Error
            ? e.message
            : String(e || "Failed to install provider");
      }
    }, 800);
    return;
  }
  ctx.providerState.value = {
    ...ctx.providerState.value,
    [providerId]: {
      ...ctx.providerState.value[providerId],
      connected: true,
      userConnected: true,
      systemConnected: false,
      status: "Connected",
    },
  };
  ctx.successMsg.value = `Connected to ${providerName}!`;
}

async function handleSubmitOAuth(
  ctx: SettingsContextValue,
  providerId: string,
  ps: ProviderState,
  updatePS: UpdatePS,
  providerName: string
) {
  const code = (ps.code || "").trim();
  if (!code) {
    ctx.errorMsg.value = "Please enter the authentication code";
    return;
  }
  try {
    await api.submitOAuthCode(providerId, code);
    updatePS({ showCodeInput: false, showAuthFlow: false, code: "" });
    handleAuthSuccess(ctx, providerId, providerName);
  } catch (e: unknown) {
    ctx.errorMsg.value = e instanceof Error ? e.message : "Failed";
  }
}

async function handleSubmitKey(
  ctx: SettingsContextValue,
  providerId: string,
  ps: ProviderState,
  updatePS: UpdatePS,
  providerName: string
) {
  const key = (ps.apiKey || "").trim();
  if (!key) return;
  try {
    await api.submitApiKey(providerId, key, ctx.agentId);
    updatePS({ showApiKeyInput: false, showAuthFlow: false, apiKey: "" });
    handleAuthSuccess(ctx, providerId, providerName);
  } catch (e: unknown) {
    ctx.errorMsg.value = e instanceof Error ? e.message : "Failed";
  }
}

async function startDeviceCodeFlow(
  ctx: SettingsContextValue,
  providerId: string,
  providerName: string,
  updatePS: UpdatePS
) {
  if (ctx.deviceCodePollTimer.value) {
    clearInterval(ctx.deviceCodePollTimer.value);
    ctx.deviceCodePollTimer.value = null;
  }

  updatePS({ status: "Starting..." });
  try {
    const data = await api.startDeviceCode(providerId, ctx.agentId);
    updatePS({
      userCode: data.userCode,
      verificationUrl: data.verificationUrl || "",
      deviceAuthId: data.deviceAuthId,
      showDeviceCode: true,
      status: "Waiting for authorization...",
      pollStatus: "Waiting for authorization...",
    });
    const interval = Math.max((data.interval || 5) * 1000, 3000);
    const timer = setInterval(
      () => pollDeviceCodeStatus(ctx, providerId, providerName),
      interval
    );
    ctx.deviceCodePollTimer.value = timer;
  } catch (e: unknown) {
    updatePS({
      status: `Error: ${e instanceof Error ? e.message : "Unknown"}`,
    });
  }
}

async function pollDeviceCodeStatus(
  ctx: SettingsContextValue,
  providerId: string,
  providerName: string
) {
  const pState = ctx.providerState.value[providerId];
  if (!pState) return;
  try {
    const data = await api.pollDeviceCode(providerId, {
      deviceAuthId: pState.deviceAuthId,
      userCode: pState.userCode,
      agentId: ctx.agentId,
    });
    if (data.status === "success") {
      if (ctx.deviceCodePollTimer.value) {
        clearInterval(ctx.deviceCodePollTimer.value);
        ctx.deviceCodePollTimer.value = null;
      }
      ctx.providerState.value = {
        ...ctx.providerState.value,
        [providerId]: {
          ...ctx.providerState.value[providerId],
          showDeviceCode: false,
          showAuthFlow: false,
        },
      };
      handleAuthSuccess(ctx, providerId, providerName);
    } else if (data.error) {
      if (ctx.deviceCodePollTimer.value) {
        clearInterval(ctx.deviceCodePollTimer.value);
        ctx.deviceCodePollTimer.value = null;
      }
      ctx.providerState.value = {
        ...ctx.providerState.value,
        [providerId]: {
          ...ctx.providerState.value[providerId],
          pollStatus: `Error: ${data.error}`,
        },
      };
    }
  } catch {
    // ignore poll errors
  }
}

/**
 * Auto-trigger provider auth flow for a given provider ID.
 * Handles both catalog (uninstalled) and installed-but-not-connected cases.
 */
export function triggerProviderAuth(
  ctx: SettingsContextValue,
  providerId: string
) {
  if (!ctx.canEditSection("model")) return;
  // Skip if auth flow is already active for this provider
  const existing = ctx.providerState.value[providerId];
  if (existing?.showAuthFlow) return;

  const updatePS = (u: Partial<ProviderState>) => {
    ctx.providerState.value = {
      ...ctx.providerState.value,
      [providerId]: { ...ctx.providerState.value[providerId], ...u },
    };
  };

  // Case 1: Already installed
  if (ctx.providerOrder.value.includes(providerId)) {
    const pInfo = ctx.PROVIDERS[providerId];
    if (!pInfo) return;
    const ps = ctx.providerState.value[providerId];
    if (!ps || ps.connected) return;

    const authTypes = pInfo.supportedAuthTypes || [pInfo.authType || "oauth"];
    const primaryAuth = authTypes[0];

    updatePS({ showAuthFlow: true });
    if (primaryAuth === "api-key") {
      updatePS({
        activeAuthTab: "api-key",
        showApiKeyInput: true,
        status: "Enter your API key...",
      });
    } else if (primaryAuth === "device-code") {
      updatePS({ activeAuthTab: "device-code" });
      startDeviceCodeFlow(ctx, providerId, pInfo.name || providerId, updatePS);
    } else {
      updatePS({
        activeAuthTab: "oauth",
        showCodeInput: true,
        status: "Click Login to start authentication.",
      });
    }
    return;
  }

  // Case 2: In catalog (not yet installed)
  const cp = ctx.catalogProviders.value.find((c) => c.id === providerId);
  if (!cp) return;

  ctx.showCatalog.value = false;
  ctx.pendingProvider.value = cp;

  const authTypes = cp.supportedAuthTypes || [cp.authType];
  const primaryAuth = authTypes[0] || cp.authType;

  ctx.providerState.value = {
    ...ctx.providerState.value,
    [providerId]: {
      status:
        primaryAuth === "api-key"
          ? "Enter your API key..."
          : primaryAuth === "device-code"
            ? "Starting..."
            : "Click Login to start authentication.",
      connected: false,
      userConnected: false,
      systemConnected: false,
      showAuthFlow: true,
      showCodeInput: primaryAuth === "oauth",
      showDeviceCode: false,
      showApiKeyInput: primaryAuth === "api-key",
      activeAuthTab: primaryAuth,
      code: "",
      apiKey: "",
      userCode: "",
      verificationUrl: "",
      pollStatus: "",
      deviceAuthId: "",
      selectedModel: "",
      modelQuery: "",
      showModelDropdown: false,
    },
  };

  if (primaryAuth === "device-code") {
    startDeviceCodeFlow(ctx, providerId, cp.name, updatePS);
  }
}

// ─── Components ───────────────────────────────────────────────────────────

export function ProviderSection({ adminOnly }: { adminOnly?: boolean }) {
  const ctx = useSettings();

  return (
    <Section
      id="model"
      title="Providers"
      icon="&#129302;"
      sectionKey="model"
      adminOnly={adminOnly}
    >
      <div id="provider-list">
        {ctx.providerOrder.value.length === 0 && (
          <div class="text-center py-6 text-gray-500">
            <p class="text-sm font-medium text-gray-700 mb-1">
              No model providers configured
            </p>
            <p class="text-xs">
              {ctx.canEditSection("model")
                ? "Add a provider below to get started."
                : "Provider access is visible here but cannot be edited in this view."}
            </p>
          </div>
        )}
        {ctx.providerOrder.value.map((pid, i) => (
          <ProviderCard key={pid} providerId={pid} index={i} />
        ))}
      </div>
      <ProviderCatalog />
      <PendingProviderAuth />
    </Section>
  );
}

function ProviderCard({
  providerId,
  index,
}: {
  providerId: string;
  index: number;
}) {
  const ctx = useSettings();
  const pInfo = ctx.PROVIDERS[providerId];
  const ps = ctx.providerState.value[providerId];
  if (!pInfo || !ps) return null;

  const iconUrl = ctx.providerIconUrls[providerId] || "";
  const models = ctx.providerModels[providerId] || [];
  const isConfigManaged = ctx.configManagedProviders.includes(providerId);
  const providerView = ctx.providerViews[providerId];
  const canEditProvider = providerView?.canEdit ?? ctx.canEditSection("model");

  function updatePS(update: Partial<ProviderState>) {
    ctx.providerState.value = {
      ...ctx.providerState.value,
      [providerId]: { ...ctx.providerState.value[providerId], ...update },
    };
  }

  function connectProvider() {
    const authTypes = pInfo.supportedAuthTypes || [pInfo.authType || "oauth"];
    const hasMultiAuth = authTypes.length > 1;
    const activeTab = hasMultiAuth
      ? ps.activeAuthTab || authTypes[0]
      : pInfo.authType;

    updatePS({ showAuthFlow: true });

    if (activeTab === "api-key") {
      updatePS({
        activeAuthTab: "api-key",
        showApiKeyInput: true,
        status: "Enter your API key...",
      });
    } else if (activeTab === "device-code") {
      updatePS({ activeAuthTab: "device-code" });
      startDeviceCodeFlow(ctx, providerId, pInfo.name || providerId, updatePS);
    } else {
      updatePS({
        activeAuthTab: "oauth",
        showCodeInput: true,
        status: "Click Login to start authentication.",
      });
    }
  }

  async function handleUninstall() {
    if (
      !confirm(
        `Remove ${pInfo.name || providerId}? This will also remove saved credentials.`
      )
    )
      return;
    try {
      if (ps.userConnected) {
        await api.disconnectProvider(providerId, ctx.agentId);
      }
      await api.uninstallProvider(ctx.agentId, providerId);
      ctx.successMsg.value = "Provider removed!";
      window.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => ctx.reloadPage(), 800);
    } catch (e: unknown) {
      ctx.errorMsg.value =
        e instanceof Error ? e.message : "Failed to remove provider";
    }
  }

  const authTypes = pInfo.supportedAuthTypes || [pInfo.authType];
  const hasMultiAuth = authTypes.length > 1;

  // Filtered models for dropdown
  const filteredModels = models.filter(
    (o) =>
      !ps.modelQuery ||
      o.label.toLowerCase().includes(ps.modelQuery.toLowerCase()) ||
      o.value.toLowerCase().includes(ps.modelQuery.toLowerCase())
  );

  return (
    <div class={index > 0 ? "mt-3 pt-3 border-t border-gray-200" : ""}>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-3 min-w-0">
          <label
            class="inline-flex items-center cursor-pointer"
            title="Set as primary provider"
          >
            <input
              type="radio"
              name="primaryProvider"
              value={providerId}
              checked={ctx.primaryProvider.value === providerId}
              disabled={!canEditProvider}
              onChange={() => {
                ctx.primaryProvider.value = providerId;
              }}
              class="w-4 h-4 accent-slate-600 cursor-pointer disabled:opacity-50"
            />
          </label>
          {iconUrl && (
            <img src={iconUrl} alt={pInfo.name} class="w-5 h-5 rounded" />
          )}
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-800">{pInfo.name}</p>
            <CapabilityChips capabilities={pInfo.capabilities || []} />
            {providerView?.source && (
              <span class="inline-flex mt-1 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                {providerView.source}
              </span>
            )}
            {!isConfigManaged && !ps.connected && ps.status && (
              <p class="text-xs truncate max-w-[120px] sm:max-w-none text-red-500">
                {ps.status}
              </p>
            )}
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          {ps.connected && (
            <div class="sm:flex-none relative">
              <input
                type="text"
                value={ps.modelQuery}
                disabled={!canEditProvider}
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  updatePS({
                    modelQuery: val,
                    showModelDropdown: true,
                    selectedModel: val,
                  });
                }}
                onFocus={() => updatePS({ showModelDropdown: true })}
                onKeyDown={(e) => {
                  if (e.key === "Escape")
                    updatePS({ showModelDropdown: false });
                  if (e.key === "Enter") {
                    e.preventDefault();
                    updatePS({ showModelDropdown: false });
                  }
                }}
                placeholder={ps.selectedModel || "Auto model"}
                class="w-36 sm:w-44 px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none bg-white placeholder-gray-500 disabled:bg-gray-100 disabled:text-gray-500"
              />
              {ps.showModelDropdown && canEditProvider && (
                <div class="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() =>
                      updatePS({
                        selectedModel: "",
                        modelQuery: "",
                        showModelDropdown: false,
                      })
                    }
                    class="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 text-gray-500"
                  >
                    Auto model
                  </button>
                  {filteredModels.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        updatePS({
                          selectedModel: opt.value,
                          modelQuery: opt.label,
                          showModelDropdown: false,
                        })
                      }
                      class="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 text-gray-800"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {isConfigManaged && (
            <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
              from config
            </span>
          )}
          {!isConfigManaged &&
            canEditProvider &&
            !ps.connected &&
            !ps.authMethods?.length && (
              <button
                type="button"
                onClick={connectProvider}
                class="bg-slate-100 text-slate-800 hover:bg-slate-200 px-3 py-1.5 text-xs font-medium rounded-lg transition-all"
              >
                Connect
              </button>
            )}
          {!isConfigManaged && canEditProvider && (
            <button
              type="button"
              onClick={handleUninstall}
              title={`Remove ${pInfo.name}`}
              class="p-1.5 text-xs rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-all"
            >
              <svg
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Auth flow */}
      {ps.showAuthFlow && canEditProvider && (
        <div class="mt-3 pt-3 border-t border-gray-200">
          {hasMultiAuth && (
            <div class="flex gap-1 mb-3 border-b border-gray-200">
              {authTypes.map((at) => (
                <button
                  key={at}
                  type="button"
                  onClick={() => {
                    const update: Partial<ProviderState> = {
                      activeAuthTab: at,
                      showApiKeyInput: at === "api-key",
                      showCodeInput: at === "oauth",
                    };
                    updatePS(update);
                    if (at === "device-code" && !ps.showDeviceCode) {
                      startDeviceCodeFlow(
                        ctx,
                        providerId,
                        pInfo.name || providerId,
                        updatePS
                      );
                    }
                  }}
                  class={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px ${
                    ps.activeAuthTab === at
                      ? "border-slate-600 text-slate-800 bg-white"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {at === "api-key"
                    ? "API Key"
                    : at === "device-code"
                      ? "Device Auth"
                      : "OAuth"}
                </button>
              ))}
            </div>
          )}
          <AuthFlowContent
            providerId={providerId}
            ps={ps}
            pInfo={pInfo}
            updatePS={updatePS}
            onSubmitOAuth={() =>
              handleSubmitOAuth(
                ctx,
                providerId,
                ps,
                updatePS,
                pInfo.name || providerId
              )
            }
            onSubmitApiKey={() =>
              handleSubmitKey(
                ctx,
                providerId,
                ps,
                updatePS,
                pInfo.name || providerId
              )
            }
          />
        </div>
      )}
    </div>
  );
}

function AuthFlowContent({
  providerId,
  ps,
  pInfo,
  updatePS,
  onSubmitOAuth,
  onSubmitApiKey,
}: {
  providerId: string;
  ps: ProviderState;
  pInfo: {
    name: string;
    authType: string;
    supportedAuthTypes: string[];
    apiKeyInstructions: string;
    apiKeyPlaceholder: string;
  };
  updatePS: (u: Partial<ProviderState>) => void;
  onSubmitOAuth: () => void;
  onSubmitApiKey: () => void;
}) {
  const ctx = useSettings();
  const authTypes = pInfo.supportedAuthTypes || [pInfo.authType];
  const hasMultiAuth = authTypes.length > 1;

  const showOAuth = hasMultiAuth
    ? ps.activeAuthTab === "oauth" && ps.showCodeInput
    : ps.showCodeInput;
  const showDeviceCode = hasMultiAuth
    ? ps.activeAuthTab === "device-code" && ps.showDeviceCode
    : ps.showDeviceCode;
  const showApiKey = hasMultiAuth
    ? ps.activeAuthTab === "api-key"
    : ps.showApiKeyInput;

  return (
    <>
      {showOAuth && (
        <div>
          <div class="mb-3 text-center">
            <a
              href={`/api/v1/auth/${providerId}/login?agentId=${ctx.agentId}`}
              onClick={(e) => {
                e.preventDefault();
                ctx.openExternal(
                  `/api/v1/auth/${providerId}/login?agentId=${ctx.agentId}`
                );
              }}
              class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all cursor-pointer"
            >
              Login with {pInfo.name}
            </a>
          </div>
          <p class="text-xs text-gray-600 mb-2">
            Paste the authentication code from {pInfo.name}:
          </p>
          <div class="flex gap-2">
            <input
              type="text"
              value={ps.code}
              onInput={(e) =>
                updatePS({ code: (e.target as HTMLInputElement).value })
              }
              placeholder="CODE#STATE"
              class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
            />
            <button
              type="button"
              onClick={onSubmitOAuth}
              class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all"
            >
              Submit
            </button>
          </div>
          <p class="text-xs text-gray-400 mt-1">
            Format: CODE#STATE (copy the entire code shown after login)
          </p>
        </div>
      )}
      {showDeviceCode && (
        <div class="text-center">
          <p class="text-xs text-gray-600 mb-2">
            Enter this code at the verification page:
          </p>
          <p class="text-2xl font-mono font-bold text-slate-800 mb-2">
            {ps.userCode || ""}
          </p>
          <a
            href={ps.verificationUrl}
            onClick={(e) => {
              e.preventDefault();
              ctx.openExternal(ps.verificationUrl);
            }}
            class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all mb-2 cursor-pointer"
          >
            Login
          </a>
          <p class="text-xs text-gray-400">
            {ps.pollStatus || "Waiting for authorization..."}
          </p>
        </div>
      )}
      {showApiKey && (
        <div>
          <p
            class="text-xs text-gray-600 mb-2"
            dangerouslySetInnerHTML={{ __html: pInfo.apiKeyInstructions }}
          />
          <div class="flex gap-2">
            <input
              type="password"
              value={ps.apiKey}
              onInput={(e) =>
                updatePS({ apiKey: (e.target as HTMLInputElement).value })
              }
              placeholder={pInfo.apiKeyPlaceholder}
              class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
            />
            <button
              type="button"
              onClick={onSubmitApiKey}
              class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ProviderCatalog() {
  const ctx = useSettings();
  if (ctx.catalogProviders.value.length === 0) return null;
  if (!ctx.canEditSection("model")) {
    return (
      <div class="mt-3 pt-3 border-t border-gray-200">
        <p class="text-xs text-gray-500">
          Provider configuration is visible here but cannot be edited in this
          view.
        </p>
      </div>
    );
  }

  function handleAddProvider(cp: CatalogProvider) {
    triggerProviderAuth(ctx, cp.id);
  }

  return (
    <div class="mt-3 pt-3 border-t border-gray-200">
      <div class="relative">
        <button
          type="button"
          onClick={() => {
            ctx.showCatalog.value = !ctx.showCatalog.value;
          }}
          class="w-full px-3 py-2 text-xs font-medium rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
        >
          <svg
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Add Provider
        </button>
        {ctx.showCatalog.value && (
          <div class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {ctx.catalogProviders.value.map((cp) => (
              <button
                key={cp.id}
                type="button"
                class="w-full text-left p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                onClick={() => handleAddProvider(cp)}
              >
                <div class="flex items-center gap-2">
                  <img src={cp.iconUrl} alt={cp.name} class="w-4 h-4 rounded" />
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-medium text-gray-800">{cp.name}</p>
                  </div>
                  <div class="flex items-center gap-1 ml-2">
                    {(cp.capabilities || []).map((capability) => (
                      <span
                        key={capability}
                        title={CAPABILITY_META[capability].title}
                        class="inline-flex items-center justify-center text-sm leading-none"
                      >
                        {CAPABILITY_META[capability].emoji}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingProviderAuth() {
  const ctx = useSettings();
  if (!ctx.canEditSection("model")) return null;
  const pp = ctx.pendingProvider.value;
  if (!pp) return null;

  const ps = ctx.providerState.value[pp.id];
  if (!ps) return null;

  function cancelPending() {
    if (ctx.deviceCodePollTimer.value) {
      clearInterval(ctx.deviceCodePollTimer.value);
      ctx.deviceCodePollTimer.value = null;
    }
    const updated = { ...ctx.providerState.value };
    delete updated[pp?.id];
    ctx.providerState.value = updated;
    ctx.pendingProvider.value = null;
  }

  const pendingUpdatePS: UpdatePS = (u) => {
    ctx.providerState.value = {
      ...ctx.providerState.value,
      [pp.id]: { ...ctx.providerState.value[pp.id], ...u },
    };
  };

  const authTypes = pp.supportedAuthTypes || [pp.authType];
  const hasMultiAuth = authTypes.length > 1;

  return (
    <div class="mt-3 pt-3 border-t border-gray-200">
      <div class="bg-white border border-slate-200 rounded-lg p-3">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            {pp.iconUrl && (
              <img src={pp.iconUrl} alt={pp.name} class="w-5 h-5 rounded" />
            )}
            <p class="text-sm font-medium text-gray-800">Connect {pp.name}</p>
          </div>
          <button
            type="button"
            onClick={cancelPending}
            class="px-2 py-1 text-xs font-medium rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-all"
          >
            Cancel
          </button>
        </div>

        {pp.success ? (
          <div class="text-center py-4">
            <svg
              class="w-8 h-8 mx-auto text-emerald-500 mb-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M5 13l4 4L19 7"
              />
            </svg>
            <p class="text-sm font-medium text-emerald-700">Connected!</p>
          </div>
        ) : (
          <>
            {hasMultiAuth && (
              <div class="flex gap-1 mb-3 border-b border-gray-200">
                {authTypes.map((at) => (
                  <button
                    key={at}
                    type="button"
                    onClick={() => {
                      pendingUpdatePS({
                        activeAuthTab: at,
                        showApiKeyInput: at === "api-key",
                        showCodeInput: at === "oauth",
                      });
                      if (at === "device-code" && !ps.showDeviceCode) {
                        startDeviceCodeFlow(
                          ctx,
                          pp.id,
                          pp.name,
                          pendingUpdatePS
                        );
                      }
                    }}
                    class={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px ${
                      ps.activeAuthTab === at
                        ? "border-slate-600 text-slate-800 bg-white"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {at}
                  </button>
                ))}
              </div>
            )}
            <AuthFlowContent
              providerId={pp.id}
              ps={ps}
              pInfo={pp}
              updatePS={pendingUpdatePS}
              onSubmitOAuth={() =>
                handleSubmitOAuth(ctx, pp.id, ps, pendingUpdatePS, pp.name)
              }
              onSubmitApiKey={() =>
                handleSubmitKey(ctx, pp.id, ps, pendingUpdatePS, pp.name)
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
