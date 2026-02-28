/**
 * Settings Page HTML Templates (Alpine.js + Pre-compiled Tailwind CSS)
 */

import type { ModelOption } from "@lobu/core";
import type { AgentMetadata } from "../../auth/agent-metadata-store";
import type { AgentSettings } from "../../auth/settings";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import { platformRegistry } from "../../platform";
import { settingsPageCSS } from "./settings-page-styles";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format userId for display - handles phone numbers and platform-specific IDs
 */
function formatUserId(userId: string): string {
  if (userId.startsWith("+")) {
    return userId;
  }
  if (userId.includes("@")) {
    const parts = userId.split("@");
    const id = parts[0] || "";
    const domain = parts[1] || "";
    if (domain === "lid") {
      return `ID: ${id.slice(0, 8)}...`;
    }
    if (domain === "s.whatsapp.net") {
      return `+${id}`;
    }
    return userId;
  }
  return userId;
}

/**
 * Get platform display info from the registry, with fallback for unknown platforms
 */
function getPlatformDisplay(platform: string): { icon: string; name: string } {
  const adapter = platformRegistry.get(platform);
  if (adapter?.getDisplayInfo) {
    const info = adapter.getDisplayInfo();
    const icon = info.icon.includes('class="')
      ? info.icon.replace('class="', 'class="w-4 h-4 inline-block ')
      : info.icon.replace("<svg", '<svg class="w-4 h-4 inline-block"');
    return { icon, name: info.name };
  }

  return {
    icon: '<svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>',
    name: platform || "API",
  };
}

export interface ProviderMeta {
  id: string;
  name: string;
  iconUrl: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  catalogDescription?: string;
}

export interface SettingsPageOptions {
  providers?: ProviderMeta[];
  catalogProviders?: ProviderMeta[];
  providerModelOptions?: Record<string, ModelOption[]>;
  /** Show agent switcher in settings page (channel-based tokens) */
  showSwitcher?: boolean;
  /** User's agents for the switcher */
  agents?: (AgentMetadata & { channelCount: number })[];
  /** Agent name from metadata */
  agentName?: string;
  /** Agent description from metadata */
  agentDescription?: string;
  /** Whether the token has a channelId (for post-delete behavior) */
  hasChannelId?: boolean;
}

export function renderSettingsPage(
  payload: SettingsTokenPayload,
  settings: AgentSettings | null,
  token: string,
  options?: SettingsPageOptions
): string {
  const s: Partial<AgentSettings> = settings || {};
  // Installed providers (already resolved in order by settings.ts)
  const providers: ProviderMeta[] = options?.providers ?? [];

  // Catalog providers (available but not installed)
  const catalogProviders: ProviderMeta[] = options?.catalogProviders ?? [];

  const providerModelOptions: Record<string, ModelOption[]> =
    options?.providerModelOptions || {};

  const providerOrder = providers.map((p) => p.id);

  const initialSecrets = (() => {
    const existingEnvVars = s.envVars || {};
    const prefillKeys = payload.prefillEnvVars || [];
    const seen = new Set<string>();
    const rows: Array<{ key: string; value: string }> = [];

    for (const [rawKey, rawValue] of Object.entries(existingEnvVars)) {
      const key = rawKey.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key,
        value:
          typeof rawValue === "string"
            ? rawValue
            : rawValue == null
              ? ""
              : String(rawValue),
      });
    }

    for (const rawKey of prefillKeys) {
      const key = (rawKey || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, value: "" });
    }

    return rows;
  })();

  const showSwitcher = options?.showSwitcher ?? false;
  const agents = options?.agents ?? [];
  const agentName = options?.agentName ?? "";
  const agentDescription = options?.agentDescription ?? "";
  const hasChannelId = options?.hasChannelId ?? false;
  const initialNixPackages = (() => {
    const existing = s.nixConfig?.packages || [];
    const prefill = payload.prefillNixPackages || [];
    return Array.from(
      new Set(
        [...existing, ...prefill]
          .map((pkg) => (typeof pkg === "string" ? pkg.trim() : ""))
          .filter(Boolean)
      )
    );
  })();

  const initialState = {
    token,
    agentId: payload.agentId,
    PROVIDERS: Object.fromEntries(
      providers.map((p) => [
        p.id,
        {
          name: p.name,
          authType: p.authType,
          supportedAuthTypes: p.supportedAuthTypes,
          apiKeyInstructions: p.apiKeyInstructions,
          apiKeyPlaceholder: p.apiKeyPlaceholder,
        },
      ])
    ),
    providerOrder,
    providerModels: providerModelOptions,
    catalogProviders: catalogProviders.map((p) => ({
      id: p.id,
      name: p.name,
      iconUrl: p.iconUrl,
      authType: p.authType,
      supportedAuthTypes: p.supportedAuthTypes,
      apiKeyInstructions: p.apiKeyInstructions,
      apiKeyPlaceholder: p.apiKeyPlaceholder,
    })),
    initialSkills: s.skillsConfig?.skills || [],
    initialMcpServers: s.mcpServers || {},
    prefillSkills: payload.prefillSkills || [],
    prefillMcpServers: payload.prefillMcpServers || [],
    prefillGrants: payload.prefillGrants || [],
    prefillNixPackages: payload.prefillNixPackages || [],
    prefillEnvVars: payload.prefillEnvVars || [],
    initialSecrets,
    initialNixPackages,
    agentName,
    agentDescription,
    hasChannelId,
    verboseLogging: !!s.verboseLogging,
    identityMd: s.identityMd || "",
    soulMd: s.soulMd || "",
    userMd: s.userMd || "",
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Settings - Lobu</title>
  <style>${settingsPageCSS}</style>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-slate-700 to-slate-900 p-4" x-data="settingsApp()" x-cloak>
  <div class="max-w-xl mx-auto bg-white rounded-2xl shadow-2xl p-6">
    <div class="mb-5" x-data="{ ${showSwitcher ? "switcherOpen: false, switching: false, creatingInSwitcher: false, switcherNewName: '', " : ""}editingIdentity: false, showDeleteConfirm: false, deleteConfirmText: '', deleting: false }">
      <div class="text-center mb-3">
        <div class="text-4xl mb-1">&#129438;</div>
        <div class="relative inline-block" x-show="!editingIdentity">
${
  showSwitcher
    ? `          <button type="button" @click="switcherOpen = !switcherOpen" class="inline-flex items-center gap-1.5 text-xl font-bold text-slate-900 hover:text-slate-700 transition-colors" title="${escapeHtml(payload.agentId || "")}">
            <span x-text="agentName || 'Agent Settings'"></span>
            <svg class="w-4 h-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
          </button>
          <div x-show="switcherOpen" @click.away="switcherOpen = false" class="absolute left-1/2 -translate-x-1/2 mt-2 w-72 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden z-20">
            <div class="max-h-48 overflow-y-auto">
${agents
  .map(
    (agent) => `
              <div class="w-full flex items-center justify-between px-3 py-2 text-left ${agent.agentId !== payload.agentId ? "hover:bg-slate-50 cursor-pointer" : "bg-slate-50"} transition-colors border-b border-slate-100 last:border-b-0"${agent.agentId !== payload.agentId ? ` @click="switching = true; switchAgent('${escapeHtml(agent.agentId)}')"` : ""}>
                <div class="min-w-0">
                  <p class="text-sm font-medium text-gray-800" title="${escapeHtml(agent.agentId)}">${escapeHtml(agent.name)}${agent.isWorkspaceAgent ? ' <span class="text-xs text-slate-500">(workspace)</span>' : ""}</p>
                </div>
                ${
                  agent.agentId === payload.agentId
                    ? `<div class="flex items-center gap-1 flex-shrink-0 ml-2">
                  <span class="text-xs text-slate-600">Current</span>
                  <button type="button" @click.stop="switcherOpen = false; editingIdentity = true" class="p-1 text-slate-400 hover:text-slate-600 transition-colors" title="Edit">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                  </button>
                  <button type="button" @click.stop="switcherOpen = false; showDeleteConfirm = true" class="p-1 text-slate-400 hover:text-red-500 transition-colors" title="Delete">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  </button>
                </div>`
                    : ""
                }
              </div>`
  )
  .join("")}
            </div>
            <!-- Create New Agent -->
            <div class="border-t border-slate-200">
              <template x-if="!creatingInSwitcher">
                <button type="button" @click.stop="creatingInSwitcher = true"
                  class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 transition-colors text-slate-600">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                  <span class="text-sm font-medium">Create new agent</span>
                </button>
              </template>
              <template x-if="creatingInSwitcher">
                <div class="px-3 py-2 space-y-2" @click.stop>
                  <input type="text" x-model="switcherNewName" placeholder="Agent name" maxlength="100"
                    class="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                    @keydown.enter.prevent="if (switcherNewName.trim()) createAgentFromSwitcher(switcherNewName)">
                  <div class="flex gap-2">
                    <button type="button" @click="creatingInSwitcher = false; switcherNewName = ''"
                      class="flex-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all">Cancel</button>
                    <button type="button" @click="createAgentFromSwitcher(switcherNewName)" :disabled="!switcherNewName.trim() || switching"
                      class="flex-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all disabled:opacity-60"
                      x-text="switching ? 'Creating...' : 'Create'"></button>
                  </div>
                </div>
              </template>
            </div>
          </div>`
    : `          <div class="inline-flex items-center gap-2">
            <h1 class="text-xl font-bold text-slate-900" x-text="agentName || 'Agent Settings'" title="${escapeHtml(payload.agentId || "")}"></h1>
            <button type="button" @click="editingIdentity = true" class="p-1 text-slate-400 hover:text-slate-600 transition-colors" title="Edit">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
            </button>
            <button type="button" @click="showDeleteConfirm = true" class="p-1 text-slate-400 hover:text-red-500 transition-colors" title="Delete">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>`
}
        </div>
        <p x-show="!editingIdentity && agentDescription" class="text-xs text-gray-500 mt-0.5" x-text="agentDescription"></p>
        <p class="text-xs text-gray-500 mt-1">${getPlatformDisplay(payload.platform).icon} ${escapeHtml(formatUserId(payload.userId))}</p>
      </div>

      <!-- Inline identity edit -->
      <div x-show="editingIdentity" x-transition class="space-y-2 mb-3">
        <input type="text" x-model="agentName" maxlength="100" placeholder="Agent name"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
        <input type="text" x-model="agentDescription" maxlength="200" placeholder="Short description"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
        <div class="flex gap-2 justify-center">
          <button type="button" @click="editingIdentity = false; agentName = _initialAgentName; agentDescription = _initialAgentDescription"
            class="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all">Cancel</button>
          <button type="button" @click="await saveIdentity(); editingIdentity = false"
            :disabled="savingIdentity || (agentName === _initialAgentName && agentDescription === _initialAgentDescription)"
            class="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all disabled:opacity-60"
            x-text="savingIdentity ? 'Saving...' : 'Save'"></button>
        </div>
      </div>

      <!-- Delete confirmation -->
      <div x-show="showDeleteConfirm" x-transition class="mt-2 space-y-2">
        <p class="text-xs text-gray-600 text-center">Type <strong class="font-mono">${escapeHtml(payload.agentId || "")}</strong> to confirm deletion:</p>
        <input type="text" x-model="deleteConfirmText" placeholder="${escapeHtml(payload.agentId || "")}"
          class="w-full px-3 py-2 border border-red-200 rounded-lg text-xs font-mono focus:border-red-400 focus:ring-1 focus:ring-red-200 outline-none"
          @keydown.enter.prevent="if (deleteConfirmText === '${escapeHtml(payload.agentId || "")}') deleteAgent()">
        <div class="flex gap-2">
          <button type="button" @click="showDeleteConfirm = false; deleteConfirmText = ''"
            class="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all">Cancel</button>
          <button type="button" @click="deleteAgent()" :disabled="deleteConfirmText !== '${escapeHtml(payload.agentId || "")}' || deleting"
            class="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-all disabled:opacity-60"
            x-text="deleting ? 'Deleting...' : 'Delete'"></button>
        </div>
      </div>
    </div>

    <div x-show="successMsg" x-transition class="bg-green-100 text-green-800 px-3 py-2 rounded-lg mb-4 text-center text-sm" x-text="successMsg"></div>
    <div x-show="errorMsg" x-transition class="bg-red-100 text-red-800 px-3 py-2 rounded-lg mb-4 text-center text-sm" x-text="errorMsg"></div>
    ${
      payload.message
        ? `<div class="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg mb-4 text-sm">
      <div class="flex items-start gap-2">
        <span class="text-lg">&#128161;</span>
        <div>${escapeHtml(payload.message)}</div>
      </div>
    </div>`
        : ""
    }
    <!-- Prefill Confirmation Banner -->
    <div x-show="hasPrefills && !prefillBannerDismissed" x-transition class="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-4">
      <div class="flex items-start gap-2 mb-3">
        <span class="text-lg">&#9888;&#65039;</span>
        <div>
          <h3 class="text-sm font-semibold text-amber-900">Pending changes from your agent</h3>
          <p class="text-xs text-amber-700 mt-0.5">Review and approve the requested configuration changes.</p>
        </div>
      </div>
      <div class="space-y-2 mb-3">
        <template x-if="prefillGrants.length > 0">
          <div>
            <p class="text-xs font-medium text-amber-800 mb-1">&#127760; Network Access Domains</p>
            <div class="flex flex-wrap gap-1">
              <template x-for="d in prefillGrants" :key="d">
                <span class="inline-block px-1.5 py-0.5 bg-white border border-amber-200 rounded text-xs font-mono text-amber-900" x-text="d"></span>
              </template>
            </div>
          </div>
        </template>
        <template x-if="prefillNixPackages.length > 0">
          <div>
            <p class="text-xs font-medium text-amber-800 mb-1">&#128230; System Packages</p>
            <div class="flex flex-wrap gap-1">
              <template x-for="p in prefillNixPackages" :key="p">
                <span class="inline-block px-1.5 py-0.5 bg-white border border-amber-200 rounded text-xs font-mono text-amber-900" x-text="p"></span>
              </template>
            </div>
          </div>
        </template>
        <template x-if="prefillEnvVars.length > 0">
          <div>
            <p class="text-xs font-medium text-amber-800 mb-1">&#128203; Secrets</p>
            <div class="flex flex-wrap gap-1">
              <template x-for="v in prefillEnvVars" :key="v">
                <span class="inline-block px-1.5 py-0.5 bg-white border border-amber-200 rounded text-xs font-mono text-amber-900" x-text="v"></span>
              </template>
            </div>
            <p class="text-xs text-amber-700 mt-1">You'll need to fill in values after approving.</p>
          </div>
        </template>
        <template x-if="prefillSkills.length > 0">
          <div>
            <p class="text-xs font-medium text-amber-800 mb-1">&#9889; Skills</p>
            <div class="space-y-1">
              <template x-for="s in prefillSkills" :key="s.repo">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium text-amber-900" x-text="s.name || s.repo"></span>
                  <span class="text-xs text-amber-600 font-mono" x-text="s.repo"></span>
                </div>
              </template>
            </div>
          </div>
        </template>
        <template x-if="prefillMcpServers.length > 0">
          <div>
            <p class="text-xs font-medium text-amber-800 mb-1">&#128268; MCP Servers</p>
            <div class="space-y-1">
              <template x-for="m in prefillMcpServers" :key="m.id">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium text-amber-900" x-text="m.name || m.id"></span>
                  <span class="text-xs text-amber-600 font-mono" x-text="m.url || ''"></span>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
      <div class="flex gap-2">
        <button type="button" @click="approveAllPrefills()" :disabled="approvingPrefills"
          class="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-all disabled:opacity-60"
          x-text="approvingPrefills ? 'Approving...' : 'Approve All'">
        </button>
        <button type="button" @click="prefillBannerDismissed = true; var u = new URL(window.location.href); u.searchParams.set('dismissed','1'); window.history.replaceState({}, '', u.toString())"
          class="px-4 py-2 text-xs font-medium rounded-lg border border-amber-300 text-amber-800 hover:bg-amber-100 transition-all">
          Dismiss
        </button>
      </div>
    </div>

    <form @submit.prevent="saveSettings()" @keydown.enter="if ($event.target.tagName !== 'TEXTAREA' && $event.target.type !== 'submit') $event.preventDefault()" class="space-y-3">
      <!-- Model Selection -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('model')">
          <span>&#129302;</span>
          Models
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.model ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.model" x-transition class="pt-3">
          <div id="provider-list">
          ${
            providers.length === 0
              ? `<div class="text-center py-6 text-gray-500">
              <p class="text-sm font-medium text-gray-700 mb-1">No model providers configured</p>
              <p class="text-xs">Add a provider below to get started.</p>
            </div>`
              : ""
          }
          ${providers
            .map(
              (p, i) => `
      <div id="provider-card-${escapeHtml(p.id)}"
        class="${i > 0 ? "mt-3 pt-3 border-t border-gray-200" : ""}">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-3 min-w-0">
            <label class="inline-flex items-center cursor-pointer" title="Set as primary provider">
              <input type="radio" name="primaryProvider" value="${escapeHtml(p.id)}" x-model="primaryProvider"
                class="w-4 h-4 accent-slate-600 cursor-pointer">
            </label>
            <img src="${escapeHtml(p.iconUrl)}" alt="${escapeHtml(p.name)}" class="w-5 h-5 rounded">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium text-gray-800">${escapeHtml(p.name)}</p>
              </div>
              <p class="text-xs"
                :class="providerState['${p.id}']?.connected ? (providerState['${p.id}']?.userConnected ? 'text-emerald-600' : 'text-amber-600') : 'text-gray-500'"
                x-text="providerState['${p.id}']?.status || 'Checking...'"></p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <div x-show="providerState['${p.id}']?.connected" x-transition class="sm:flex-none relative"
              @click.outside="providerState['${p.id}'].showModelDropdown = false">
              <input type="text"
                x-model="providerState['${p.id}'].modelQuery"
                @focus="providerState['${p.id}'].showModelDropdown = true"
                @input="providerState['${p.id}'].showModelDropdown = true; providerState['${p.id}'].selectedModel = $event.target.value"
                @keydown.escape="providerState['${p.id}'].showModelDropdown = false"
                @keydown.enter.prevent="providerState['${p.id}'].showModelDropdown = false"
                :placeholder="providerState['${p.id}'].selectedModel || 'Auto model'"
                aria-label="${escapeHtml(p.name)} model"
                class="w-36 sm:w-44 px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none bg-white placeholder-gray-500">
              <div x-show="providerState['${p.id}'].showModelDropdown" x-transition
                class="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <button type="button"
                  @click="providerState['${p.id}'].selectedModel = ''; providerState['${p.id}'].modelQuery = ''; providerState['${p.id}'].showModelDropdown = false"
                  class="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 text-gray-500">
                  Auto model
                </button>
                <template x-for="opt in (providerModels['${p.id}'] || []).filter(o => !providerState['${p.id}'].modelQuery || o.label.toLowerCase().includes(providerState['${p.id}'].modelQuery.toLowerCase()) || o.value.toLowerCase().includes(providerState['${p.id}'].modelQuery.toLowerCase()))" :key="opt.value">
                  <button type="button"
                    @click="providerState['${p.id}'].selectedModel = opt.value; providerState['${p.id}'].modelQuery = opt.label; providerState['${p.id}'].showModelDropdown = false"
                    class="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 text-gray-800"
                    x-text="opt.label">
                  </button>
                </template>
              </div>
            </div>
            <template x-if="!providerState['${p.id}']?.authMethods?.length">
              <button type="button" @click="providerState['${p.id}']?.userConnected ? disconnectProvider('${p.id}') : connectProvider('${p.id}')"
                class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all"
                :class="providerState['${p.id}']?.userConnected ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'"
                x-text="providerState['${p.id}']?.userConnected ? 'Disconnect' : 'Connect'">
              </button>
            </template>
            <button type="button" @click="uninstallProvider('${p.id}')"
              title="Remove ${escapeHtml(p.name)}"
              class="p-1.5 text-xs rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-all">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>
        ${(() => {
          const authTypes = p.supportedAuthTypes || [p.authType];
          const hasMultiAuth = authTypes.length > 1;
          const hasApiKey = authTypes.includes("api-key");
          const hasOAuth = authTypes.includes("oauth");
          const hasDeviceCode = authTypes.includes("device-code");

          // Build tab bar + content panels
          let html = `<!-- Auth flow (${authTypes.join(", ")}) -->
        <div x-show="providerState['${p.id}']?.showAuthFlow" x-transition class="mt-3 pt-3 border-t border-gray-200">`;

          if (hasMultiAuth) {
            // Tab bar
            html += `
          <div class="flex gap-1 mb-3 border-b border-gray-200">`;
            for (const at of authTypes) {
              const label =
                at === "api-key"
                  ? "API Key"
                  : at === "device-code"
                    ? "Device Auth"
                    : "OAuth";
              html += `
            <button type="button" @click="providerState['${p.id}'].activeAuthTab = '${at}'"
              class="px-3 py-1.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px"
              :class="providerState['${p.id}']?.activeAuthTab === '${at}' ? 'border-slate-600 text-slate-800 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700'">${label}</button>`;
            }
            html += `
          </div>`;
          }

          // OAuth code input panel
          if (hasOAuth) {
            const showCond = hasMultiAuth
              ? `providerState['${p.id}']?.activeAuthTab === 'oauth' && providerState['${p.id}']?.showCodeInput`
              : `providerState['${p.id}']?.showCodeInput`;
            html += `
						          <div x-show="${showCond}" x-transition>
						            <div class="mb-3 text-center">
						              <a :href="'/api/v1/oauth/providers/${p.id}/login?token=' + encodeURIComponent(token)" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
						                Login with ${escapeHtml(p.name)}
						              </a>
						            </div>
						            <p class="text-xs text-gray-600 mb-2">Paste the authentication code from ${escapeHtml(p.name)}:</p>
						            <div class="flex gap-2">
						              <input type="text" x-model="providerState['${p.id}'].code" placeholder="CODE#STATE" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
						              <button type="button" @click="submitOAuthCode('${p.id}')" class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
						                Submit
						              </button>
						            </div>
						            <p class="text-xs text-gray-400 mt-1">Format: CODE#STATE (copy the entire code shown after login)</p>
						          </div>`;
          }

          // Device code panel
          if (hasDeviceCode) {
            const showCond = hasMultiAuth
              ? `providerState['${p.id}']?.activeAuthTab === 'device-code' && providerState['${p.id}']?.showDeviceCode`
              : `providerState['${p.id}']?.showDeviceCode`;
            html += `
          <div x-show="${showCond}" x-transition>
            <div class="text-center">
              <p class="text-xs text-gray-600 mb-2">Enter this code at the verification page:</p>
              <p class="text-2xl font-mono font-bold text-slate-800 mb-2" x-text="providerState['${p.id}']?.userCode || ''"></p>
              <a :href="providerState['${p.id}']?.verificationUrl || 'https://auth.openai.com/codex/device'" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all mb-2">
                Login
              </a>
              <p class="text-xs text-gray-400" x-text="providerState['${p.id}']?.pollStatus || 'Waiting for authorization...'"></p>
            </div>
          </div>`;
          }

          // API key panel
          if (hasApiKey) {
            const showCond = hasMultiAuth
              ? `providerState['${p.id}']?.activeAuthTab === 'api-key'`
              : `providerState['${p.id}']?.showApiKeyInput`;
            html += `
          <div x-show="${showCond}" x-transition>
            <p class="text-xs text-gray-600 mb-2">${p.apiKeyInstructions}</p>
            <div class="flex gap-2">
              <input type="password" x-model="providerState['${p.id}'].apiKey" placeholder="${escapeHtml(p.apiKeyPlaceholder)}" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <button type="button" @click="submitApiKey('${p.id}')" class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
                Save
              </button>
            </div>
          </div>`;
          }

          html += `
        </div>`;
          return html;
        })()}
      </div>`
            )
            .join("")}
          </div>

          <!-- Add Provider Catalog -->
          <div class="mt-3 pt-3 border-t border-gray-200" x-show="catalogProviders.length > 0">
            <div class="relative">
              <button type="button" @click="showCatalog = !showCatalog"
                class="w-full px-3 py-2 text-xs font-medium rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-all flex items-center justify-center gap-2">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                Add Provider
              </button>
              <div x-show="showCatalog" @click.away="showCatalog = false" x-transition
                class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <template x-for="cp in catalogProviders" :key="cp.id">
                  <div class="p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                    @click="addProvider(cp.id)">
                    <div class="flex items-center gap-2">
                      <img :src="cp.iconUrl" :alt="cp.name" class="w-4 h-4 rounded">
                      <div class="flex-1 min-w-0">
                        <p class="text-xs font-medium text-gray-800" x-text="cp.name"></p>
                      </div>
                      <div class="flex flex-wrap gap-1 justify-end">
                        <template x-for="at in (cp.supportedAuthTypes || [cp.authType])" :key="at">
                          <span class="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 border border-gray-100"
                            x-text="at"></span>
                        </template>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- Pending Provider Auth (shown during add flow) -->
          <div x-show="pendingProvider" x-transition class="mt-3 pt-3 border-t border-gray-200">
            <div class="bg-white border border-slate-200 rounded-lg p-3">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <img :src="pendingProvider?.iconUrl || ''" :alt="pendingProvider?.name || ''" class="w-5 h-5 rounded">
                  <p class="text-sm font-medium text-gray-800" x-text="'Connect ' + (pendingProvider?.name || '')"></p>
                </div>
                <button type="button" @click="cancelPendingProvider()"
                  class="px-2 py-1 text-xs font-medium rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-all">
                  Cancel
                </button>
              </div>

              <!-- Tab bar for multi-auth pending providers -->
              <template x-if="pendingProvider && !pendingProvider.success && (pendingProvider.supportedAuthTypes || [pendingProvider.authType]).length > 1">
                <div class="flex gap-1 mb-3 border-b border-gray-200">
                  <template x-for="at in (pendingProvider.supportedAuthTypes || [pendingProvider.authType])" :key="at">
                    <button type="button" @click="providerState[pendingProvider.id].activeAuthTab = at; if (at !== 'api-key') connectProvider(pendingProvider.id)"
                      class="px-3 py-1.5 text-xs font-medium rounded-t-lg transition-all border-b-2 -mb-px"
                      :class="providerState[pendingProvider.id]?.activeAuthTab === at ? 'border-slate-600 text-slate-800 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700'"
                      x-text="at">
                    </button>
                  </template>
                </div>
              </template>

              <!-- API Key input for pending provider -->
              <template x-if="pendingProvider && !pendingProvider.success && (providerState[pendingProvider.id]?.activeAuthTab === 'api-key' || ((pendingProvider.supportedAuthTypes || [pendingProvider.authType]).length === 1 && pendingProvider.authType === 'api-key'))">
                <div>
                  <p class="text-xs text-gray-600 mb-2" x-html="pendingProvider.apiKeyInstructions || 'Enter your API key:'"></p>
                  <div class="flex gap-2">
                    <input type="password" x-model="providerState[pendingProvider.id].apiKey" :placeholder="pendingProvider.apiKeyPlaceholder || 'API key'" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
                    <button type="button" @click="submitApiKey(pendingProvider.id)" class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
                      Save
                    </button>
                  </div>
                </div>
              </template>

              <!-- OAuth code input for pending provider -->
              <template x-if="pendingProvider && !pendingProvider.success && providerState[pendingProvider.id]?.activeAuthTab !== 'api-key' && (providerState[pendingProvider.id]?.showCodeInput || ((pendingProvider.supportedAuthTypes || [pendingProvider.authType]).length === 1 && pendingProvider.authType === 'oauth'))">
                <div>
                  <div class="mb-3 text-center">
                    <a :href="'/api/v1/oauth/providers/' + pendingProvider.id + '/login?token=' + encodeURIComponent(token)" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all" x-text="'Login with ' + pendingProvider.name">
                    </a>
                  </div>
                  <p class="text-xs text-gray-600 mb-2" x-text="'Paste the authentication code from ' + pendingProvider.name + ':'"></p>
                  <div class="flex gap-2">
                    <input type="text" x-model="providerState[pendingProvider.id].code" placeholder="CODE#STATE" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
                    <button type="button" @click="submitOAuthCode(pendingProvider.id)" class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
                      Submit
                    </button>
                  </div>
                  <p class="text-xs text-gray-400 mt-1">Format: CODE#STATE (copy the entire code shown after login)</p>
                </div>
              </template>

              <!-- Device code flow for pending provider -->
              <template x-if="pendingProvider && !pendingProvider.success && providerState[pendingProvider.id]?.activeAuthTab !== 'api-key' && (providerState[pendingProvider.id]?.showDeviceCode || ((pendingProvider.supportedAuthTypes || [pendingProvider.authType]).length === 1 && pendingProvider.authType === 'device-code'))">
                <div class="text-center">
                  <p class="text-xs text-gray-600 mb-2">Enter this code at the verification page:</p>
                  <p class="text-2xl font-mono font-bold text-slate-800 mb-2" x-text="providerState[pendingProvider.id].userCode || ''"></p>
                  <a :href="providerState[pendingProvider.id].verificationUrl || '#'" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all mb-2">
                    Login
                  </a>
                  <p class="text-xs text-gray-400" x-text="providerState[pendingProvider.id].pollStatus || 'Waiting for authorization...'"></p>
                </div>
              </template>

              <!-- Success state for pending provider -->
              <template x-if="pendingProvider?.success">
                <div class="text-center py-4">
                  <svg class="w-8 h-8 mx-auto text-emerald-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                  </svg>
                  <p class="text-sm font-medium text-emerald-700">Connected!</p>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Instructions -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('instructions')">
          <span>&#128220;</span>
          Instructions
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.instructions ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.instructions" x-transition class="pt-3 space-y-3">
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">IDENTITY.md <span class="text-gray-400">- Who the agent is</span></label>
            <textarea id="identityMd" name="identityMd" x-model="identityMd" placeholder="You are a helpful coding assistant named Alex.&#10;You specialize in TypeScript and React development." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"></textarea>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">SOUL.md <span class="text-gray-400">- Behavior rules &amp; instructions</span></label>
            <textarea id="soulMd" name="soulMd" x-model="soulMd" placeholder="Always write tests before implementation.&#10;Prefer functional programming patterns.&#10;Never commit directly to main branch." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[80px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"></textarea>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">USER.md <span class="text-gray-400">- User-specific context</span></label>
            <textarea id="userMd" name="userMd" x-model="userMd" placeholder="The user prefers concise responses.&#10;Their timezone is UTC+3.&#10;They use VS Code as their IDE." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"></textarea>
          </div>
        </div>
      </div>

      <!-- Skills and MCP Section -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('integrations')">
          <span>&#128268;</span>
          Skills and MCP
          <span x-show="skillsLoading || mcpsLoading" class="animate-spin text-slate-600">&#8635;</span>
          <span x-show="skills.length + mcpServerIds.length > 0" class="text-xs text-gray-400" x-text="'(' + (skills.length + mcpServerIds.length) + ')'"></span>
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.integrations ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.integrations" x-transition class="pt-3 space-y-3">

          <!-- Errors -->
          <div x-show="skillsError" x-transition class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs" x-text="skillsError"></div>
          <div x-show="mcpsError" x-transition class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs" x-text="mcpsError"></div>

          <!-- Installed Skills and MCP List -->
          <div class="space-y-2">
            <template x-if="skills.length === 0 && mcpServerIds.length === 0">
              <p class="text-xs text-gray-500">No skills or MCP servers configured yet.</p>
            </template>
            <template x-for="skill in skills" :key="'skill-' + skill.repo">
              <div class="flex items-center justify-between p-2 bg-white rounded border border-gray-100">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span class="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 shrink-0">skill</span>
                  <div class="min-w-0">
                    <a :href="'https://clawhub.ai/skills/' + encodeURIComponent(skill.repo)" target="_blank" class="text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline truncate block" x-text="skill.name"></a>
                    <p x-show="skill.description" class="text-xs text-gray-500 truncate" x-text="skill.description"></p>
                  </div>
                </div>
                <div class="flex items-center gap-2 ml-2 flex-shrink-0">
                  <button type="button" @click="toggleSkill(skill.repo)"
                    class="px-2 py-1 text-xs rounded"
                    :class="skill.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'"
                    x-text="skill.enabled ? 'Enabled' : 'Disabled'"></button>
                  <button type="button" @click="removeSkill(skill.repo)" class="px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200">Remove</button>
                </div>
              </div>
            </template>
            <template x-for="mcpId in mcpServerIds" :key="'mcp-' + mcpId">
              <div class="flex items-center justify-between p-2 bg-white rounded border border-gray-100">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span class="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 shrink-0">mcp</span>
                  <div class="min-w-0">
                    <p class="text-xs font-medium text-gray-800 truncate" x-text="mcpId"></p>
                    <p x-show="getMcpDescription(mcpId)" class="text-xs text-gray-500 truncate" x-text="getMcpDescription(mcpId)"></p>
                  </div>
                </div>
                <div class="flex items-center gap-2 ml-2 flex-shrink-0">
                  <button type="button" @click="toggleMcp(mcpId)"
                    class="px-2 py-1 text-xs rounded"
                    :class="mcpServers[mcpId]?.enabled !== false ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'"
                    x-text="mcpServers[mcpId]?.enabled !== false ? 'Enabled' : 'Disabled'"></button>
                  <button type="button" @click="removeMcp(mcpId)" class="px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200">Remove</button>
                </div>
              </div>
            </template>
          </div>

          <!-- Unified Search -->
          <div class="border-t border-gray-100 pt-2">
            <div class="relative mb-2">
              <input type="text" x-model="integrationSearch" @input.debounce.300ms="searchIntegrations()" @focus="if (integrationSearch.trim() && !integrationSearch.trim().startsWith('http') && !integrationSearch.trim().includes('://')) integrationSearchVisible = true" placeholder="Search skills/MCP or paste MCP URL..." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <div x-show="integrationSearchVisible" @click.away="integrationSearchVisible = false" class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <template x-for="result in integrationSearchResults" :key="result.type + '-' + result.id">
                  <div class="p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0" @click="addIntegrationFromSearch(result)">
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-2 flex-1 min-w-0">
                        <span class="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded shrink-0" :class="result.type === 'skill' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'" x-text="result.type"></span>
                        <div class="min-w-0">
                          <p class="text-xs font-medium text-gray-800 truncate" x-text="result.name"></p>
                          <p x-show="result.description" class="text-xs text-gray-500 truncate" x-text="result.description"></p>
                        </div>
                      </div>
                      <div class="flex items-center gap-2 ml-2">
                        <span x-show="result.type === 'skill' && result.installs" class="text-xs text-gray-400" x-text="formatInstalls(result.installs)"></span>
                        <span class="text-xs" :class="isIntegrationAdded(result) ? 'text-green-600' : 'text-slate-600'" x-text="isIntegrationAdded(result) ? 'Added' : '+ Add'"></span>
                      </div>
                    </div>
                  </div>
                </template>
                <template x-if="integrationSearchResults.length === 0 && integrationSearchVisible">
                  <div class="p-2 text-xs text-gray-500">No skills or MCP servers found</div>
                </template>
              </div>
            </div>

            <!-- Curated Chips (only when no integrations exist) -->
            <div class="mb-2" x-show="skills.length === 0 && mcpServerIds.length === 0">
              <div class="flex flex-wrap gap-1">
                <template x-for="cs in curatedSkills" :key="'cs-' + cs.repo">
                  <button type="button" @click="addSkillFromChip(cs.repo)"
                    class="px-2 py-1 text-xs rounded-full bg-purple-50 text-slate-800 border border-purple-200"
                    :class="skills.some(function(sk) { return sk.repo === cs.repo }) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-purple-100'"
                    :disabled="skills.some(function(sk) { return sk.repo === cs.repo })"
                    :title="skills.some(function(sk) { return sk.repo === cs.repo }) ? 'Already added' : cs.description"
                    x-text="cs.name"></button>
                </template>
                <template x-for="cm in curatedMcps" :key="'cm-' + cm.id">
                  <button type="button" @click="addMcpFromChip(cm.id)"
                    class="px-2 py-1 text-xs rounded-full bg-blue-50 text-slate-800 border border-blue-200"
                    :class="mcpServers.hasOwnProperty(cm.id) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-blue-100'"
                    :disabled="mcpServers.hasOwnProperty(cm.id)"
                    :title="mcpServers.hasOwnProperty(cm.id) ? 'Already added' : cm.description"
                    x-text="cm.name"></button>
                </template>
              </div>
            </div>

            <p class="text-xs text-gray-400 mt-1">Extend your agent with <a href="https://clawhub.ai/skills" target="_blank" class="text-blue-600 hover:underline">skills from ClawHub</a> and MCP servers.</p>
          </div>

        </div>
      </div>

      <!-- Scheduled Reminders Section -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('reminders')">
          <span>&#9200;</span>
          Scheduled Reminders
          <span x-show="schedulesLoading" class="animate-spin text-slate-600">&#8635;</span>
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.reminders ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.reminders" x-transition class="pt-3">
          <div x-show="schedulesError" x-transition class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs mb-2" x-text="schedulesError"></div>
          <div class="space-y-2">
            <template x-if="schedules.length === 0">
              <p class="text-xs text-gray-500">No scheduled reminders.</p>
            </template>
            <template x-for="schedule in schedules" :key="schedule.scheduleId">
              <div class="flex items-start justify-between p-2 bg-white rounded border border-gray-200">
                <div class="flex-1 min-w-0">
                  <p class="text-xs font-medium text-gray-800 truncate" :title="schedule.task" x-text="truncateText(schedule.task, 60)"></p>
                  <p class="text-xs text-gray-500">
                    <span class="inline-block px-1.5 py-0.5 rounded text-xs"
                      :class="schedule.status === 'pending' ? 'bg-slate-100 text-slate-800' : schedule.status === 'triggered' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'"
                      x-text="schedule.status"></span>
                    <template x-if="schedule.isRecurring && schedule.cron">
                      <span class="inline-block px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-800 ml-1" :title="'Cron: ' + schedule.cron" x-text="'&#128260; ' + schedule.iteration + '/' + schedule.maxIterations"></span>
                    </template>
                    <span :title="new Date(schedule.scheduledFor).toLocaleString()" class="ml-1" x-text="formatTimeRemaining(schedule.scheduledFor)"></span>
                    <template x-if="schedule.isRecurring && schedule.cron">
                      <span class="text-gray-400 ml-1" x-text="'(' + schedule.cron + ')'"></span>
                    </template>
                  </p>
                </div>
                <template x-if="schedule.status === 'pending'">
                  <button type="button" @click="cancelSchedule(schedule.scheduleId)" class="ml-2 px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200 flex-shrink-0">Cancel</button>
                </template>
              </div>
            </template>
          </div>
          <div class="mt-3 pt-3 border-t border-gray-200">
            <p class="text-xs font-medium text-gray-600 mb-1">Example prompts:</p>
            <p class="text-xs text-gray-500 mb-1 font-medium">One-time:</p>
            <ul class="text-xs text-gray-500 space-y-1 mb-2">
              <li>&bull; "Remind me in 30 minutes to check the build status"</li>
              <li>&bull; "Set a reminder for 2 hours from now to review the PR"</li>
            </ul>
            <p class="text-xs text-gray-500 mb-1 font-medium">Recurring:</p>
            <ul class="text-xs text-gray-500 space-y-1">
              <li>&bull; "Check the API status every 30 minutes for the next 2 hours"</li>
              <li>&bull; "Poll the deployment health every hour until it succeeds (max 12 checks)"</li>
              <li>&bull; "Send me a morning standup reminder at 9am on weekdays"</li>
            </ul>
            <p class="text-xs text-gray-400 mt-2">One-time: max 24 hours. Recurring: min 5 min interval, max 100 iterations.</p>
          </div>
        </div>
      </div>

      <!-- Permissions (unified domains + MCP tool grants) -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="permissionsSection()">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('permissions')">
          <span>&#128274;</span>
          Permissions
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.permissions ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.permissions" x-transition class="pt-3 space-y-2">
          <!-- Permission list -->
          <template x-if="permissionItems.length === 0 && !permissionsLoading">
            <p class="text-xs text-gray-500">No permissions configured yet. The agent will ask for confirmation before using browser tools, accessing online data, or running destructive MCP actions.</p>
          </template>
          <template x-if="permissionsLoading">
            <p class="text-xs text-gray-400">Loading...</p>
          </template>
          <template x-for="(item, idx) in permissionItems" :key="item.pattern + item.type">
            <div class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
              <span class="flex-1 text-xs font-mono text-gray-800 truncate" :title="item.pattern" x-text="item.pattern"></span>
              <span class="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
                :class="badgeClass(item)"
                x-text="badgeText(item)"></span>
              <button type="button" @click="removePermission(item)" class="text-gray-400 hover:text-red-500 transition-colors" title="Remove">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
          </template>

          <!-- Add permission form -->
          <div class="mt-2 border border-dashed border-gray-300 rounded-lg p-2 space-y-2" x-show="showAddForm">
            <div>
              <input type="text" x-model="newPattern" placeholder="e.g. api.openai.com, /mcp/gmail/tools/*" class="w-full px-2 py-1.5 border border-gray-200 rounded text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
            </div>
            <div class="flex items-center gap-3 text-xs">
              <label class="flex items-center gap-1 cursor-pointer"><input type="radio" x-model="newAccess" value="always" class="accent-slate-700"> Always</label>
              <label class="flex items-center gap-1 cursor-pointer"><input type="radio" x-model="newAccess" value="1h" class="accent-slate-700"> 1 hour</label>
              <label class="flex items-center gap-1 cursor-pointer"><input type="radio" x-model="newAccess" value="session" class="accent-slate-700"> Session</label>
              <label class="flex items-center gap-1 cursor-pointer"><input type="radio" x-model="newAccess" value="denied" class="accent-slate-700"> Denied</label>
            </div>
            <div class="flex gap-2">
              <button type="button" @click="addPermission()" :disabled="!newPattern.trim()" class="px-3 py-1 text-xs font-medium rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40 transition-all">Add</button>
              <button type="button" @click="showAddForm = false" class="px-3 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition-all">Cancel</button>
            </div>
          </div>
          <button type="button" x-show="!showAddForm" @click="showAddForm = true; newAccess = '1h'" class="text-xs text-slate-600 hover:text-slate-800 font-medium">+ Add permission</button>
        </div>
      </div>

      <!-- System Packages -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('packages')">
          <span>&#128230;</span>
          System Packages
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.packages ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.packages" x-transition class="pt-3 space-y-3">
          <template x-if="nixPackages.length === 0">
            <p class="text-xs text-gray-400 italic">No packages added.</p>
          </template>
          <template x-for="pkg in nixPackages" :key="pkg">
            <div class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
              <span class="flex-1 text-xs font-mono text-gray-800 break-all" x-text="pkg"></span>
              <button type="button" @click="removeNixPackage(pkg)" class="text-xs font-medium text-red-600 hover:text-red-700 transition-colors" title="Uninstall package">
                Uninstall
              </button>
            </div>
          </template>

          <div class="relative">
            <input
              id="nixPackageSearch"
              type="text"
              x-model="nixPackageQuery"
              @input.debounce.300ms="searchNixPackages()"
              @focus="if (nixPackageQuery.trim()) nixPackageSuggestionsVisible = true"
              @keydown.enter.prevent="addNixPackageFromQuery()"
              placeholder="Search Nix packages (e.g. python311)"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
            >

            <div x-show="nixPackageSuggestionsVisible" @click.away="nixPackageSuggestionsVisible = false" class="absolute z-10 left-2 right-2 mt-0.5 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
              <template x-if="nixPackageSearchLoading">
                <div class="px-3 py-2 text-xs text-gray-500">Searching packages...</div>
              </template>
              <template x-for="suggestion in nixPackageSuggestions" :key="suggestion.name">
                <button type="button" @click="addNixPackage(suggestion.name)" class="w-full text-left px-3 py-2 border-b border-gray-100 last:border-b-0 hover:bg-slate-50 transition-colors">
                  <div class="text-xs font-mono text-gray-800" x-text="suggestion.name"></div>
                  <div class="text-[11px] text-gray-500 truncate" x-text="suggestion.description || suggestion.pname || ''"></div>
                </button>
              </template>
              <template x-if="!nixPackageSearchLoading && nixPackageQuery.trim() && nixPackageSuggestions.length === 0">
                <div class="px-3 py-2 text-xs text-gray-500">No matching packages.</div>
              </template>
            </div>
          </div>
          <p class="text-xs text-gray-400 mt-1">Install system tools from <a href="https://search.nixos.org/packages" target="_blank" class="text-blue-600 hover:underline">Nix Packages</a> to make them available in your workspace.</p>
        </div>
      </div>

      <!-- Secrets -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="toggleSection('envvars')">
          <span>&#128203;</span>
          Secrets
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="openSections.envvars ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="openSections.envvars" x-transition class="pt-3 space-y-2">
          <template x-if="secrets.length === 0">
            <p class="text-xs text-gray-400 italic">No secrets configured.</p>
          </template>
          <template x-for="(secret, idx) in secrets" :key="secret.id">
            <div class="bg-white border border-gray-200 rounded-lg p-2">
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  x-model="secret.key"
                  placeholder="API_KEY"
                  class="w-40 px-2 py-1.5 border border-gray-200 rounded text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                >
                <span class="text-xs font-mono text-gray-500 select-none">=</span>
                <input
                  :type="secret.reveal ? 'text' : 'password'"
                  @focus="secret.reveal = true"
                  @blur="secret.reveal = false"
                  x-model="secret.value"
                  placeholder="secret value"
                  class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                  autocomplete="new-password"
                >
                <button
                  type="button"
                  @click="removeSecret(secret.id)"
                  class="px-2.5 py-1.5 text-xs font-medium bg-transparent border-0 text-red-700 hover:text-red-800 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          </template>
          <button
            type="button"
            @click="addSecret('', '')"
            class="text-xs text-slate-600 hover:text-slate-800 font-medium"
          >
            + Add secret
          </button>
        </div>
      </div>

      <!-- Verbose Logging -->
      <div class="bg-gray-50 rounded-lg p-3">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="verboseLogging" name="verboseLogging" x-model="verboseLogging" class="w-4 h-4 text-slate-600 rounded focus:ring-slate-500">
          <span class="text-sm font-medium text-gray-800">Verbose logging</span>
        </label>
        <p class="text-xs text-gray-500 mt-1 ml-6">Show tool calls, reasoning tokens, and detailed output</p>
      </div>

      <button type="submit" :disabled="saving || !hasPendingSettingsChanges()"
        class="w-full py-3 bg-gradient-to-r from-slate-700 to-slate-800 text-white text-sm font-semibold rounded-lg hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
        x-text="saving ? 'Saving...' : (hasPendingSettingsChanges() ? 'Save Settings' : 'No Changes')">
      </button>
    </form>
  </div>

  <script>
    const __STATE__ = ${JSON.stringify(initialState)};

    function settingsApp() {
      return {
        // Config
        token: __STATE__.token,
        agentId: __STATE__.agentId,
        PROVIDERS: __STATE__.PROVIDERS,

        // Agent Identity
        agentName: __STATE__.agentName || '',
        agentDescription: __STATE__.agentDescription || '',
        _initialAgentName: __STATE__.agentName || '',
        _initialAgentDescription: __STATE__.agentDescription || '',
        savingIdentity: false,
        hasChannelId: __STATE__.hasChannelId || false,

        // UI
        successMsg: '',
        errorMsg: '',
        saving: false,
        initialSettingsSnapshot: null,
        verboseLogging: !!__STATE__.verboseLogging,
        identityMd: __STATE__.identityMd || '',
        soulMd: __STATE__.soulMd || '',
        userMd: __STATE__.userMd || '',

        // Providers
        providerState: {},
        providerOrder: Array.isArray(__STATE__.providerOrder)
          ? __STATE__.providerOrder.slice()
          : [],
        primaryProvider: '',
        providerModels: __STATE__.providerModels || {},
        catalogProviders: __STATE__.catalogProviders || [],
        showCatalog: false,
        pendingProvider: null,
        deviceCodePollTimer: null,

        // Skills
        skills: __STATE__.initialSkills,
        skillsLoading: false,
        skillsError: '',
        curatedSkills: [],

        // MCPs
        mcpServers: __STATE__.initialMcpServers,
        mcpsLoading: false,
        mcpsError: '',
        curatedMcps: [],

        // Secrets
        secrets: Array.isArray(__STATE__.initialSecrets)
          ? __STATE__.initialSecrets.map(function(secret, idx) {
              return {
                id: idx + 1,
                key: secret && typeof secret.key === 'string' ? secret.key : '',
                value: secret && typeof secret.value === 'string' ? secret.value : '',
                reveal: false
              };
            })
          : [],
        nextSecretId: (Array.isArray(__STATE__.initialSecrets) ? __STATE__.initialSecrets.length : 0) + 1,

        // Nix packages
        nixPackages: Array.isArray(__STATE__.initialNixPackages)
          ? __STATE__.initialNixPackages.slice()
          : [],
        nixPackageQuery: '',
        nixPackageSuggestions: [],
        nixPackageSuggestionsVisible: false,
        nixPackageSearchLoading: false,

        // Unified integration search
        integrationSearch: '',
        integrationSearchResults: [],
        integrationSearchVisible: false,

        // Schedules
        schedules: [],
        schedulesLoading: false,
        schedulesError: '',

        // Prefills
        prefillSkills: __STATE__.prefillSkills,
        prefillMcpServers: __STATE__.prefillMcpServers,
        prefillGrants: __STATE__.prefillGrants,
        prefillNixPackages: __STATE__.prefillNixPackages,
        prefillEnvVars: __STATE__.prefillEnvVars,
        prefillBannerDismissed: new URL(window.location.href).searchParams.has('dismissed'),
        approvingPrefills: false,

        // Section open states (unified, persisted in URL ?open=id,id)
        openSections: {},

        get hasPrefills() {
          return !!(this.prefillGrants.length || this.prefillNixPackages.length || this.prefillEnvVars.length || this.prefillSkills.length || this.prefillMcpServers.length);
        },

        get mcpServerIds() {
          return Object.keys(this.mcpServers);
        },

        init() {
          var providerIds = this.providerOrder.length
            ? this.providerOrder.slice()
            : Object.keys(this.PROVIDERS);
          this.providerOrder = providerIds.filter(function(pid) {
            return !!__STATE__.PROVIDERS[pid];
          });

          // Initialize provider state
          for (var i = 0; i < this.providerOrder.length; i++) {
            var pid = this.providerOrder[i];
            var selectedModel = '';
            var pInfo = this.PROVIDERS[pid] || {};
            var authTypes = pInfo.supportedAuthTypes || [pInfo.authType || 'oauth'];
            this.providerState[pid] = {
              status: 'Checking...',
              connected: false,
              userConnected: false,
              systemConnected: false,
              showAuthFlow: false,
              showCodeInput: false,
              showDeviceCode: false,
              showApiKeyInput: false,
              activeAuthTab: authTypes[0] || 'oauth',
              code: '',
              apiKey: '',
              userCode: '',
              verificationUrl: '',
              pollStatus: 'Waiting for authorization...',
              deviceAuthId: '',
              selectedModel: selectedModel,
              modelQuery: '',
              showModelDropdown: false
            };
          }
          this.primaryProvider = this.providerOrder.length ? this.providerOrder[0] : '';

          var urlParams = new URLSearchParams(window.location.search);

          // Restore open accordion sections from URL
          var openParam = urlParams.get('open');
          if (openParam) {
            openParam.split(',').forEach(function(id) {
              this.openSections[id] = true;
            }.bind(this));
          }
${
  providers.length === 0
    ? `          // Auto-open model section when no providers configured
          if (!openParam) this.openSections.model = true;`
    : ""
}

          this.checkProviders();
          this.initIntegrations();
          this.initSchedules();
          this.initialSettingsSnapshot = this.buildSettingsSnapshot();
        },

        // === Section toggle + URL sync ===
        toggleSection(id) {
          this.openSections[id] = !this.openSections[id];
          this.updateSectionsUrl();
        },
        updateSectionsUrl() {
          var ids = Object.keys(this.openSections).filter(function(k) {
            return this.openSections[k];
          }.bind(this));
          var url = new URL(window.location.href);
          if (ids.length > 0) {
            url.searchParams.set('open', ids.join(','));
          } else {
            url.searchParams.delete('open');
          }
          window.history.replaceState({}, '', url.toString());
        },

        // === Helpers ===
        parseLines(text) {
          return text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
        },

        buildCurrentEnvVars() {
          var envVars = {};
          for (var i = 0; i < this.secrets.length; i++) {
            var secret = this.secrets[i];
            var key = this.normalizeSecretKey(secret && secret.key);
            if (!key) continue;
            if (envVars[key] === undefined) {
              envVars[key] = (secret && secret.value) || '';
            }
          }
          return envVars;
        },

        envVarsSignature(envVars) {
          return Object.keys(envVars)
            .sort()
            .map(function(key) { return key + '=' + (envVars[key] || ''); })
            .join('\\n');
        },

        nixPackagesSignature() {
          return this.nixPackages
            .map(function(pkg) { return (pkg || '').trim(); })
            .filter(function(pkg) { return !!pkg; })
            .join('\\n');
        },

        buildSettingsSnapshot() {
          var envVars = this.buildCurrentEnvVars();

          return {
            identityMd: this.identityMd || '',
            soulMd: this.soulMd || '',
            userMd: this.userMd || '',
            verboseLogging: !!this.verboseLogging,
            primaryProvider: this.primaryProvider || '',
            providerOrder: this.providerOrder.join(','),
            nixPackages: this.nixPackagesSignature(),
            envVars: this.envVarsSignature(envVars)
          };
        },

        hasPendingSettingsChanges() {
          if (!this.initialSettingsSnapshot) return false;
          var current = this.buildSettingsSnapshot();
          return JSON.stringify(current) !== JSON.stringify(this.initialSettingsSnapshot);
        },

        normalizeSecretKey(key) {
          return (key || '').trim();
        },

        addSecret(key, value) {
          this.secrets = this.secrets.concat([{
            id: this.nextSecretId++,
            key: this.normalizeSecretKey(key),
            value: value || '',
            reveal: false
          }]);
        },

        removeSecret(id) {
          this.secrets = this.secrets.filter(function(secret) {
            return secret.id !== id;
          });
        },

        normalizeNixPackageName(name) {
          return (name || '').trim();
        },

        addNixPackage(name) {
          var packageName = this.normalizeNixPackageName(name);
          if (!packageName) return;
          if (this.nixPackages.indexOf(packageName) !== -1) {
            this.nixPackageQuery = '';
            this.nixPackageSuggestions = [];
            this.nixPackageSuggestionsVisible = false;
            return;
          }
          this.nixPackages = this.nixPackages.concat([packageName]);
          this.nixPackageQuery = '';
          this.nixPackageSuggestions = [];
          this.nixPackageSuggestionsVisible = false;
        },

        addNixPackageFromQuery() {
          this.addNixPackage(this.nixPackageQuery);
        },

        removeNixPackage(name) {
          this.nixPackages = this.nixPackages.filter(function(pkg) {
            return pkg !== name;
          });
        },

        async searchNixPackages() {
          var query = this.normalizeNixPackageName(this.nixPackageQuery);
          if (!query) {
            this.nixPackageSuggestionsVisible = false;
            this.nixPackageSuggestions = [];
            this.nixPackageSearchLoading = false;
            return;
          }

          this.nixPackageSuggestionsVisible = true;
          this.nixPackageSearchLoading = true;
          try {
            var response = await fetch(
              this.apiUrl('/config/packages/search') + '&q=' + encodeURIComponent(query)
            );
            var data = await response.json().catch(function() { return {}; });
            if (!response.ok) throw new Error(data.error || 'Failed to search packages');

            var suggestions = Array.isArray(data.packages) ? data.packages : [];
            var seen = {};
            var filtered = [];
            for (var i = 0; i < suggestions.length; i++) {
              var item = suggestions[i] || {};
              var name = this.normalizeNixPackageName(item.name);
              if (!name) continue;
              if (this.nixPackages.indexOf(name) !== -1) continue;
              if (seen[name]) continue;
              seen[name] = true;
              filtered.push({
                name: name,
                pname: typeof item.pname === 'string' ? item.pname : '',
                description: typeof item.description === 'string' ? item.description : ''
              });
            }
            this.nixPackageSuggestions = filtered;
          } catch (e) {
            this.nixPackageSuggestions = [];
          } finally {
            this.nixPackageSearchLoading = false;
          }
        },

        formatInstalls(num) {
          if (!num) return '0';
          if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
          return num.toString();
        },

        truncateText(text, maxLength) {
          if (!text) return '';
          if (text.length <= maxLength) return text;
          return text.slice(0, maxLength - 3) + '...';
        },

        mcpIdFromUrl(url) {
          try {
            var hostname = new URL(url).hostname;
            return hostname.replace(/./g, '-');
          } catch (e) {
            return url.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
          }
        },

        formatTimeRemaining(scheduledFor) {
          var scheduledDate = new Date(scheduledFor);
          var now = new Date();
          var minutesRemaining = Math.max(0, Math.round((scheduledDate - now) / (1000 * 60)));
          if (minutesRemaining === 0) return 'Due now';
          if (minutesRemaining < 60) return 'in ' + minutesRemaining + ' min';
          var hours = Math.floor(minutesRemaining / 60);
          var mins = minutesRemaining % 60;
          return 'in ' + hours + 'h ' + mins + 'm';
        },

        getMcpDescription(mcpId) {
          var config = this.mcpServers[mcpId];
          if (!config) return '';
          if (config.description) return config.description;
          if (config.url) return config.url;
          if (config.command) return config.command + ' ' + (config.args || []).join(' ');
          return '';
        },

        apiUrl(path) {
          return '/api/v1/agents/' + encodeURIComponent(this.agentId) + path + '?token=' + encodeURIComponent(this.token);
        },

        async switchAgent(agentId) {
          try {
            var resp = await fetch('/settings/switch-agent?token=' + encodeURIComponent(this.token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: agentId })
            });
            var result = await resp.json();
            if (resp.ok) {
              window.location.reload();
            } else {
              this.errorMsg = result.error || 'Failed to switch agent';
            }
          } catch (e) {
            this.errorMsg = 'Network error: ' + e.message;
          }
        },

        // === Agent Identity ===
        async saveIdentity() {
          this.savingIdentity = true;
          this.successMsg = '';
          this.errorMsg = '';

          try {
            var body = {};
            if (this.agentName !== this._initialAgentName) body.name = this.agentName;
            if (this.agentDescription !== this._initialAgentDescription) body.description = this.agentDescription;

            var resp = await fetch('/settings/update-agent?token=' + encodeURIComponent(this.token), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            var result = await resp.json();
            if (resp.ok) {
              this._initialAgentName = this.agentName;
              this._initialAgentDescription = this.agentDescription;
              this.successMsg = 'Agent identity updated!';
              window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
              throw new Error(result.error || 'Failed to update');
            }
          } catch (e) {
            this.errorMsg = e.message;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } finally {
            this.savingIdentity = false;
          }
        },

        async createAgentFromSwitcher(name) {
          if (!name || !name.trim()) return;
          var agentId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (agentId.length > 40) agentId = agentId.substring(0, 40);
          if (agentId.length < 3 || !/^[a-z]/.test(agentId)) {
            this.errorMsg = 'Invalid agent name (must start with a letter, at least 3 characters)';
            return;
          }

          try {
            var resp = await fetch('/settings/create-agent?token=' + encodeURIComponent(this.token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: agentId, name: name.trim() })
            });
            var result = await resp.json();
            if (resp.ok) {
              window.location.reload();
            } else {
              this.errorMsg = result.error || 'Failed to create agent';
            }
          } catch (e) {
            this.errorMsg = 'Network error: ' + e.message;
          }
        },

        async deleteAgent() {
          try {
            var resp = await fetch('/api/v1/agent-management/agents/' + encodeURIComponent(this.agentId) + '?token=' + encodeURIComponent(this.token), {
              method: 'DELETE'
            });
            var result = await resp.json();
            if (resp.ok) {
              if (this.hasChannelId) {
                window.location.reload();
              } else {
                document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center;color:white"><p style="font-size:1.5rem;margin-bottom:0.5rem">Agent deleted</p><p style="font-size:0.875rem;opacity:0.7">This agent has been permanently removed.</p></div></div>';
              }
            } else {
              this.errorMsg = result.error || 'Failed to delete agent';
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          } catch (e) {
            this.errorMsg = 'Network error: ' + e.message;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        },

        // === Provider Install/Uninstall ===
        addProvider(providerId) {
          var cp = this.catalogProviders.find(function(c) { return c.id === providerId; });
          if (!cp) return;

          this.showCatalog = false;
          this.pendingProvider = cp;

          var authTypes = cp.supportedAuthTypes || [cp.authType];
          var primaryAuth = authTypes[0] || cp.authType;

          // Initialize temporary provider state for the auth flow
          this.providerState[providerId] = {
            status: 'Connecting...',
            connected: false,
            userConnected: false,
            systemConnected: false,
            showAuthFlow: true,
            showCodeInput: false,
            showDeviceCode: false,
            showApiKeyInput: false,
            activeAuthTab: primaryAuth,
            code: '',
            apiKey: '',
            userCode: '',
            verificationUrl: '',
            pollStatus: '',
            deviceAuthId: '',
            selectedModel: '',
            modelQuery: '',
            showModelDropdown: false
          };

          // Start the auth flow based on primary authType
          if (primaryAuth === 'api-key') {
            this.providerState[providerId].showApiKeyInput = true;
            this.providerState[providerId].status = 'Enter your API key...';
          } else if (primaryAuth === 'device-code') {
            this.connectDeviceCode(providerId);
          } else {
            // OAuth
            this.providerState[providerId].showCodeInput = true;
            this.providerState[providerId].status = 'Click Login to start authentication.';
          }
        },

        cancelPendingProvider() {
          if (this.pendingProvider) {
            var pid = this.pendingProvider.id;
            if (this.deviceCodePollTimer) {
              clearInterval(this.deviceCodePollTimer);
              this.deviceCodePollTimer = null;
            }
            delete this.providerState[pid];
            this.pendingProvider = null;
          }
        },

        async installAndReload(providerId, message) {
          try {
            var resp = await fetch(this.apiUrl('/config/providers/install'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId: providerId })
            });
            if (resp.ok) {
              this.successMsg = message || 'Provider added and connected!';
              window.scrollTo({ top: 0, behavior: 'smooth' });
              setTimeout(function() { window.location.reload(); }, 800);
            } else {
              var data = await resp.json().catch(function() { return {}; });
              this.errorMsg = data.error || 'Failed to install provider';
            }
          } catch (e) {
            this.errorMsg = e.message || 'Failed to install provider';
          }
        },

        async uninstallProvider(providerId) {
          if (!confirm('Remove ' + (this.PROVIDERS[providerId]?.name || providerId) + '? This will also remove saved credentials.')) return;
          try {
            var resp = await fetch(this.apiUrl('/config/providers/uninstall'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId: providerId })
            });
            if (resp.ok) {
              this.successMsg = 'Provider removed! Refreshing...';
              window.scrollTo({ top: 0, behavior: 'smooth' });
              setTimeout(function() { window.location.reload(); }, 800);
            } else {
              var data = await resp.json().catch(function() { return {}; });
              this.errorMsg = data.error || 'Failed to remove provider';
            }
          } catch (e) {
            this.errorMsg = e.message || 'Failed to remove provider';
          }
        },

        // === Form Submission ===
        async saveSettings() {
          this.saving = true;
          this.successMsg = '';
          this.errorMsg = '';

          var settings = {};

          // Reorder installed providers via catalog API (primary provider first)
          if (this.providerOrder.length > 0 && this.primaryProvider) {
            try {
              var orderedIds = [this.primaryProvider].concat(
                this.providerOrder.filter(function(pid) { return pid !== this.primaryProvider; }.bind(this))
              );
              await fetch(this.apiUrl('/config/providers/reorder'), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ providerIds: orderedIds })
              });
            } catch (e) {
              // Non-fatal: continue saving other settings
            }
          }

          // Always clear explicit model override so provider order controls routing.
          settings.model = '';

          // Workspace files
          settings.identityMd = this.identityMd || '';
          settings.soulMd = this.soulMd || '';
          settings.userMd = this.userMd || '';

          // System packages
          var nixPackages = this.nixPackages
            .map(function(pkg) { return (pkg || '').trim(); })
            .filter(function(pkg) { return !!pkg; });
          if (nixPackages.length) {
            settings.nixConfig = { packages: nixPackages };
          } else {
            settings.nixConfig = null;
          }

          // Secrets
          settings.envVars = this.buildCurrentEnvVars();

          // Verbose logging
          settings.verboseLogging = !!this.verboseLogging;

          try {
            var response = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings)
            });

            var result = await response.json();

            if (response.ok) {
              this.successMsg = 'Settings saved!';
              this.initialSettingsSnapshot = this.buildSettingsSnapshot();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
              throw new Error(result.error || 'Failed to save settings');
            }
          } catch (error) {
            this.errorMsg = error.message;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } finally {
            this.saving = false;
          }
        },

        // === Provider Auth ===
        async checkProviders() {
          try {
            var resp = await fetch(this.apiUrl('/config'));
            var data = await resp.json();
            for (var provider in (data.providers || {})) {
              var info = data.providers[provider];
              this.updateProviderStatus(
                provider,
                info.connected,
                info.userConnected,
                info.systemConnected,
                info.activeAuthType,
                info.authMethods
              );
            }
          } catch (e) {
            if (this.providerState['claude']) {
              this.providerState['claude'].status = 'Error checking status';
            }
          }
        },

        updateProviderStatus(provider, connected, userConnected, systemConnected, activeAuthType, authMethods) {
          if (!this.providerState[provider]) return;
          var ps = this.providerState[provider];
          ps.connected = !!connected;
          ps.userConnected = !!userConnected;
          ps.systemConnected = !!systemConnected;
          ps.activeAuthType = activeAuthType || null;
          ps.authMethods = authMethods || [];
          ps.status = !ps.connected
            ? 'Not connected'
            : ps.userConnected
              ? 'Connected via ' + (ps.activeAuthType || 'unknown')
              : 'Using system key';
        },

        connectProvider(provider) {
          var info = this.PROVIDERS[provider];
          if (!info) return;

          var ps = this.providerState[provider];
          if (!ps) return;

          var authTypes = info.supportedAuthTypes || [info.authType || 'oauth'];
          var hasMultiAuth = authTypes.length > 1;

          // Show the auth flow container
          ps.showAuthFlow = true;

          // Determine which auth tab to activate
          var activeTab = hasMultiAuth ? (ps.activeAuthTab || authTypes[0]) : info.authType;

          if (activeTab === 'api-key') {
            ps.activeAuthTab = 'api-key';
            ps.showApiKeyInput = true;
            ps.status = 'Enter your API key...';
            return;
          }

          if (activeTab === 'device-code') {
            ps.activeAuthTab = 'device-code';
            this.connectDeviceCode(provider);
            return;
          }

          // OAuth flow
          ps.activeAuthTab = 'oauth';
          ps.showCodeInput = true;
          ps.status = 'Click Login to start authentication.';
        },

        async submitOAuthCode(provider) {
          var code = (this.providerState[provider].code || '').trim();
          if (!code) {
            this.errorMsg = 'Please enter the authentication code';
            return;
          }

          try {
            var resp = await fetch('/api/v1/oauth/providers/' + provider + '/code?token=' + encodeURIComponent(this.token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: code })
            });

            var result = await resp.json();

            if (resp.ok) {
              this.providerState[provider].showCodeInput = false;
              this.providerState[provider].showAuthFlow = false;
              this.providerState[provider].code = '';

              // If this is a pending add flow, show success then install
              if (this.pendingProvider && this.pendingProvider.id === provider) {
                this.pendingProvider = Object.assign({}, this.pendingProvider, { success: true });
                var self = this;
                setTimeout(async function() {
                  self.pendingProvider = null;
                  await self.installAndReload(provider, 'Provider added and connected!');
                }, 800);
                return;
              }

              this.updateProviderStatus(provider, true, true, false);
              this.successMsg = 'Connected to ' + (this.PROVIDERS[provider]?.name || provider) + '!';
            } else {
              throw new Error(result.error || 'Failed to verify code');
            }
          } catch (e) {
            this.errorMsg = e.message;
          }
        },

        async submitApiKey(provider) {
          var apiKey = (this.providerState[provider].apiKey || '').trim();
          if (!apiKey) return;

          try {
            var resp = await fetch('/api/v1/auth/' + provider + '/save-key', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: this.agentId, apiKey: apiKey })
            });

            var result = await resp.json();

            if (resp.ok) {
              this.providerState[provider].showApiKeyInput = false;
              this.providerState[provider].showAuthFlow = false;
              this.providerState[provider].apiKey = '';

              // If this is a pending add flow, show success then install
              if (this.pendingProvider && this.pendingProvider.id === provider) {
                this.pendingProvider = Object.assign({}, this.pendingProvider, { success: true });
                var self = this;
                setTimeout(async function() {
                  self.pendingProvider = null;
                  await self.installAndReload(provider, 'Provider added and connected!');
                }, 800);
                return;
              }

              this.updateProviderStatus(provider, true, true, false);
              this.successMsg = 'Connected to ' + (this.PROVIDERS[provider]?.name || provider) + '!';
            } else {
              throw new Error(result.error || 'Failed to save API key');
            }
          } catch (e) {
            this.errorMsg = e.message;
          }
        },

        async connectDeviceCode(provider) {
          var ps = this.providerState[provider];
          try {
            ps.status = 'Starting...';

            var resp = await fetch('/api/v1/auth/' + provider + '/start', { method: 'POST' });
            var data = await resp.json();

            if (!resp.ok) throw new Error(data.error || 'Failed to start auth');

            ps.userCode = data.userCode;
            ps.verificationUrl = data.verificationUrl || 'https://auth.openai.com/codex/device';
            ps.deviceAuthId = data.deviceAuthId;
            ps.showDeviceCode = true;
            ps.status = 'Waiting for authorization...';
            ps.pollStatus = 'Waiting for authorization...';

            var interval = Math.max((data.interval || 5) * 1000, 3000);
            var self = this;
            this.deviceCodePollTimer = setInterval(function() {
              self.pollDeviceCodeToken(provider);
            }, interval);

          } catch (e) {
            ps.status = 'Error: ' + e.message;
          }
        },

        async pollDeviceCodeToken(provider) {
          var ps = this.providerState[provider];
          try {
            var resp = await fetch('/api/v1/auth/' + provider + '/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                deviceAuthId: ps.deviceAuthId,
                userCode: ps.userCode,
                agentId: this.agentId
              })
            });
            var data = await resp.json();

            if (data.status === 'success') {
              clearInterval(this.deviceCodePollTimer);
              this.deviceCodePollTimer = null;
              ps.showDeviceCode = false;
              ps.showAuthFlow = false;

              // If this is a pending add flow, show success then install
              if (this.pendingProvider && this.pendingProvider.id === provider) {
                this.pendingProvider = Object.assign({}, this.pendingProvider, { success: true });
                var self = this;
                setTimeout(async function() {
                  self.pendingProvider = null;
                  await self.installAndReload(provider, 'Provider added and connected!');
                }, 800);
                return;
              }

              this.updateProviderStatus(provider, true, true, false);
              this.successMsg = 'Connected to ' + (this.PROVIDERS[provider]?.name || provider) + '!';
            } else if (data.error) {
              clearInterval(this.deviceCodePollTimer);
              this.deviceCodePollTimer = null;
              ps.pollStatus = 'Error: ' + data.error;
            }
          } catch (e) {
            console.error('Poll error:', e);
          }
        },

        async disconnectProvider(provider, profileId) {
          var info = this.PROVIDERS[provider];
          var name = info?.name || provider;
          if (!confirm('Disconnect from ' + name + '?')) return;

          var body = { agentId: this.agentId };
          if (profileId) body.profileId = profileId;

          // All providers have /logout on their auth app; try that first, fall back to OAuth route
          var resp = await fetch('/api/v1/auth/' + provider + '/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!resp.ok && info?.authType === 'oauth') {
            await fetch('/api/v1/oauth/providers/' + provider + '/logout?token=' + encodeURIComponent(this.token), { method: 'POST' });
          }
          // Reset auth flow state
          var ps = this.providerState[provider];
          if (ps) {
            ps.showAuthFlow = false;
            ps.showCodeInput = false;
            ps.showDeviceCode = false;
            ps.showApiKeyInput = false;
          }
          this.checkProviders();
        },

        // === Integrations (Skills + MCPs) ===
        async initIntegrations() {
          try {
            var resp = await fetch('/api/v1/integrations/registry?token=' + encodeURIComponent(this.token));
            var data = await resp.json();
            this.curatedSkills = data.skills || [];
            this.curatedMcps = data.mcps || [];
          } catch (e) {
            console.error('Failed to load curated integrations:', e);
          }
        },

        async addSkillFromChip(repo) {
          if (this.skills.some(function(s) { return s.repo === repo; })) return;
          await this.addSkill(repo);
        },

        async addSkill(repo) {
          if (!repo) return;
          this.skillsLoading = true;
          this.skillsError = '';

          try {
            var fetchResp = await fetch('/api/v1/integrations/skills/fetch?token=' + encodeURIComponent(this.token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: repo })
            });

            var fetchResult = await fetchResp.json();
            if (!fetchResp.ok) {
              throw new Error(fetchResult.error || 'Failed to fetch skill');
            }

            var newSkill = {
              repo: fetchResult.repo,
              name: fetchResult.name,
              description: fetchResult.description,
              enabled: true,
              content: fetchResult.content,
              contentFetchedAt: fetchResult.fetchedAt
            };

            var updatedSkills = this.skills.concat([newSkill]);

            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ skillsConfig: { skills: updatedSkills } })
            });

            if (resp.ok) {
              this.skills = updatedSkills;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to add skill');
            }
          } catch (e) {
            this.showSkillsError(e.message);
          } finally {
            this.skillsLoading = false;
          }
        },

        async toggleSkill(repo) {
          var skill = this.skills.find(function(s) { return s.repo === repo; });
          if (!skill) return;

          var newEnabled = !skill.enabled;
          var updatedSkills = this.skills.map(function(s) {
            if (s.repo === repo) {
              var copy = {};
              for (var k in s) copy[k] = s[k];
              copy.enabled = newEnabled;
              return copy;
            }
            return s;
          });

          try {
            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ skillsConfig: { skills: updatedSkills } })
            });

            if (resp.ok) {
              this.skills = updatedSkills;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to toggle skill');
            }
          } catch (e) {
            this.showSkillsError(e.message);
          }
        },

        async removeSkill(repo) {
          if (!confirm('Remove this skill?')) return;

          var updatedSkills = this.skills.filter(function(s) { return s.repo !== repo; });

          try {
            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ skillsConfig: { skills: updatedSkills } })
            });

            if (resp.ok) {
              this.skills = updatedSkills;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to remove skill');
            }
          } catch (e) {
            this.showSkillsError(e.message);
          }
        },

        showSkillsError(msg) {
          var self = this;
          self.skillsError = msg;
          setTimeout(function() { self.skillsError = ''; }, 5000);
        },

        // === MCPs ===

        // === Unified Integration Search ===
        async searchIntegrations() {
          var q = this.integrationSearch.trim();
          if (!q) {
            this.integrationSearchVisible = false;
            this.integrationSearchResults = [];
            return;
          }

          // Auto-detect URL — add as MCP directly
          if (q.startsWith('http://') || q.startsWith('https://') || q.includes('://')) {
            var id = this.mcpIdFromUrl(q);
            await this.addMcp(id, q);
            this.integrationSearch = '';
            this.integrationSearchVisible = false;
            this.integrationSearchResults = [];
            return;
          }

          this.integrationSearchVisible = true;
          this.integrationSearchResults = [];

          try {
            var resp = await fetch('/api/v1/integrations/registry?token=' + encodeURIComponent(this.token) + '&q=' + encodeURIComponent(q));
            var data = await resp.json();
            var skillResults = (data.skills || []).map(function(s) {
              return { id: s.id, name: s.name, description: s.description, installs: s.installs, type: 'skill' };
            });
            var mcpResults = (data.mcps || []).map(function(m) {
              return { id: m.id, name: m.name, description: m.description, type: 'mcp' };
            });
            this.integrationSearchResults = skillResults.concat(mcpResults);
          } catch (e) {
            this.integrationSearchResults = [];
          }
        },

        isIntegrationAdded(result) {
          if (result.type === 'skill') {
            return this.skills.some(function(sk) { return sk.repo === result.id; });
          }
          return this.mcpServers.hasOwnProperty(result.id);
        },

        async addIntegrationFromSearch(result) {
          if (this.isIntegrationAdded(result)) return;
          if (result.type === 'skill') {
            await this.addSkill(result.id);
          } else {
            await this.addMcp(result.id, null);
          }
          this.integrationSearch = '';
          this.integrationSearchVisible = false;
          this.integrationSearchResults = [];
        },

        async addMcpFromChip(mcpId) {
          if (this.mcpServers.hasOwnProperty(mcpId)) return;
          await this.addMcp(mcpId, null);
        },

        async addMcp(mcpId, customUrl) {
          this.mcpsLoading = true;
          this.mcpsError = '';

          try {
            var mcpConfig = { enabled: true };
            if (customUrl) mcpConfig.url = customUrl;

            var updatedMcpServers = {};
            for (var k in this.mcpServers) updatedMcpServers[k] = this.mcpServers[k];
            updatedMcpServers[mcpId] = mcpConfig;

            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mcpServers: updatedMcpServers })
            });

            if (resp.ok) {
              this.mcpServers = updatedMcpServers;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to add MCP');
            }
          } catch (e) {
            this.showMcpsError(e.message);
          } finally {
            this.mcpsLoading = false;
          }
        },

        async toggleMcp(mcpId) {
          var config = this.mcpServers[mcpId];
          if (!config) return;

          var newEnabled = config.enabled === false;
          var updatedMcpServers = {};
          for (var k in this.mcpServers) updatedMcpServers[k] = this.mcpServers[k];
          var configCopy = {};
          for (var ck in config) configCopy[ck] = config[ck];
          configCopy.enabled = newEnabled;
          updatedMcpServers[mcpId] = configCopy;

          try {
            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mcpServers: updatedMcpServers })
            });

            if (resp.ok) {
              this.mcpServers = updatedMcpServers;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to toggle MCP');
            }
          } catch (e) {
            this.showMcpsError(e.message);
          }
        },

        async removeMcp(mcpId) {
          if (!confirm('Remove this MCP server?')) return;

          var updatedMcpServers = {};
          for (var k in this.mcpServers) {
            if (k !== mcpId) updatedMcpServers[k] = this.mcpServers[k];
          }

          try {
            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mcpServers: updatedMcpServers })
            });

            if (resp.ok) {
              this.mcpServers = updatedMcpServers;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to remove MCP');
            }
          } catch (e) {
            this.showMcpsError(e.message);
          }
        },

        showMcpsError(msg) {
          var self = this;
          self.mcpsError = msg;
          setTimeout(function() { self.mcpsError = ''; }, 5000);
        },

        // === Schedules ===
        async initSchedules() {
          this.schedulesLoading = true;

          try {
            var resp = await fetch(this.apiUrl('/schedules'));
            var data = await resp.json();

            if (!resp.ok) {
              throw new Error(data.error || 'Failed to load schedules');
            }

            this.schedules = data.schedules || [];
          } catch (e) {
            console.error('Failed to load schedules:', e);
            this.schedulesError = 'Failed to load scheduled reminders.';
          } finally {
            this.schedulesLoading = false;
          }
        },

        async cancelSchedule(scheduleId) {
          if (!confirm('Cancel this scheduled reminder?')) return;

          this.schedulesLoading = true;

          try {
            var resp = await fetch('/api/v1/agents/' + encodeURIComponent(this.agentId) + '/schedules/' + encodeURIComponent(scheduleId) + '?token=' + encodeURIComponent(this.token), {
              method: 'DELETE'
            });

            var result = await resp.json();

            if (resp.ok) {
              this.schedules = this.schedules.filter(function(s) { return s.scheduleId !== scheduleId; });
              this.successMsg = 'Reminder cancelled!';
            } else {
              throw new Error(result.error || 'Failed to cancel reminder');
            }
          } catch (e) {
            this.showSchedulesError(e.message);
          } finally {
            this.schedulesLoading = false;
          }
        },

        showSchedulesError(msg) {
          var self = this;
          self.schedulesError = msg;
          setTimeout(function() { self.schedulesError = ''; }, 5000);
        },

        // === Prefill Skills/MCPs ===
        async addPrefillSkill(index) {
          var skill = this.prefillSkills[index];
          if (!skill) return;

          try {
            var fetchResp = await fetch('/api/v1/integrations/skills/fetch?token=' + encodeURIComponent(this.token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: skill.repo })
            });

            var fetchResult = await fetchResp.json();
            if (!fetchResp.ok) {
              throw new Error(fetchResult.error || 'Failed to fetch skill');
            }

            var newSkill = {
              repo: fetchResult.repo,
              name: fetchResult.name || skill.name,
              description: fetchResult.description || skill.description,
              enabled: true,
              content: fetchResult.content,
              contentFetchedAt: fetchResult.fetchedAt
            };

            var updatedSkills = this.skills.concat([newSkill]);

            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ skillsConfig: { skills: updatedSkills } })
            });

            if (resp.ok) {
              this.skills = updatedSkills;
              this.successMsg = 'Skill "' + (skill.name || skill.repo) + '" added!';
              return true;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to add skill');
            }
          } catch (e) {
            this.errorMsg = 'Error: ' + e.message;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return false;
          }
        },

        async addPrefillMcp(index) {
          var mcp = this.prefillMcpServers[index];
          if (!mcp) return;

          try {
            var getResp = await fetch(this.apiUrl('/config'));
            var currentConfig = await getResp.json();
            var currentMcpServersData = currentConfig.settings?.mcpServers || {};

            var mcpConfig = {};
            if (mcp.url) mcpConfig.url = mcp.url;
            if (mcp.type) mcpConfig.type = mcp.type;
            if (mcp.command) mcpConfig.command = mcp.command;
            if (mcp.args) mcpConfig.args = mcp.args;
            if (mcp.name) mcpConfig.description = mcp.name;

            var updatedMcpServers = {};
            for (var k in currentMcpServersData) updatedMcpServers[k] = currentMcpServersData[k];
            updatedMcpServers[mcp.id] = mcpConfig;

            // If MCP requires env vars, add them
            if (mcp.envVars && mcp.envVars.length > 0) {
              var currentEnvVars = currentConfig.settings?.envVars || {};
              for (var i = 0; i < mcp.envVars.length; i++) {
                var envVar = mcp.envVars[i];
                var normalizedKey = this.normalizeSecretKey(envVar);
                if (!normalizedKey) continue;
                var existsInForm = this.secrets.some(function(secret) {
                  return this.normalizeSecretKey(secret && secret.key) === normalizedKey;
                }.bind(this));
                var existsInSavedConfig = Object.prototype.hasOwnProperty.call(
                  currentEnvVars,
                  normalizedKey
                );
                if (!existsInSavedConfig && !existsInForm) {
                  this.addSecret(normalizedKey, '');
                }
              }
            }

            var resp = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mcpServers: updatedMcpServers })
            });

            if (resp.ok) {
              var mcpName = mcp.name || mcp.id;
              var msg = 'MCP server "' + mcpName + '" added!';
              if (mcp.envVars && mcp.envVars.length > 0) {
                msg += ' Please fill in the required secrets below.';
              }
              this.successMsg = msg;
              return true;
            } else {
              var result = await resp.json();
              throw new Error(result.error || 'Failed to add MCP server');
            }
          } catch (e) {
            this.errorMsg = 'Error: ' + e.message;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return false;
          }
        },

        // === Approve All Prefills ===
        async approveAllPrefills() {
          this.approvingPrefills = true;
          this.errorMsg = '';
          this.successMsg = '';
          var hasEnvVars = this.prefillEnvVars.length > 0;

          try {
            // 1. Create grants for pre-filled domains
            for (var d = 0; d < this.prefillGrants.length; d++) {
              await fetch(this.apiUrl('/grants'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pattern: this.prefillGrants[d], expiresAt: null })
              });
            }

            // 2. Save nix packages if any
            if (this.prefillNixPackages.length > 0) {
              var mergedPkgs = this.nixPackages.slice();
              for (var p = 0; p < this.prefillNixPackages.length; p++) {
                var packageName = this.normalizeNixPackageName(this.prefillNixPackages[p]);
                if (packageName && mergedPkgs.indexOf(packageName) === -1) {
                  mergedPkgs.push(packageName);
                }
              }
              this.nixPackages = mergedPkgs;
              var nixResp = await fetch(this.apiUrl('/config'), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nixConfig: { packages: mergedPkgs } })
              });
              if (!nixResp.ok) {
                var nixErr = await nixResp.json();
                throw new Error(nixErr.error || 'Failed to save package config');
              }
            }

            // 2. Add prefill skills (skip already installed)
            var failures = [];
            for (var si = 0; si < this.prefillSkills.length; si++) {
              var skill = this.prefillSkills[si];
              var alreadyInstalled = false;
              for (var j = 0; j < this.skills.length; j++) {
                if (this.skills[j].repo === skill.repo) { alreadyInstalled = true; break; }
              }
              if (!alreadyInstalled) {
                // Suppress per-item messages during batch
                this.successMsg = '';
                this.errorMsg = '';
                var ok = await this.addPrefillSkill(si);
                if (!ok) failures.push(skill.name || skill.repo);
              }
            }

            // 3. Add prefill MCPs (skip already installed)
            for (var mi = 0; mi < this.prefillMcpServers.length; mi++) {
              var mcp = this.prefillMcpServers[mi];
              if (!this.mcpServers[mcp.id]) {
                this.successMsg = '';
                this.errorMsg = '';
                var ok2 = await this.addPrefillMcp(mi);
                if (!ok2) failures.push(mcp.name || mcp.id);
              }
            }

            // 4. Handle env vars — add keys to secrets list, expand sections
            if (hasEnvVars) {
              var existingSecretKeys = {};
              for (var es = 0; es < this.secrets.length; es++) {
                var existingKey = this.normalizeSecretKey(
                  this.secrets[es] && this.secrets[es].key
                );
                if (existingKey) existingSecretKeys[existingKey] = true;
              }
              for (var ei = 0; ei < this.prefillEnvVars.length; ei++) {
                var envKey = this.normalizeSecretKey(this.prefillEnvVars[ei]);
                if (!envKey) continue;
                if (!existingSecretKeys[envKey]) {
                  this.addSecret(envKey, '');
                  existingSecretKeys[envKey] = true;
                }
              }
              this.openSections.envvars = true;
              this.updateSectionsUrl();
            }

            // 5. Dismiss banner and show result
            this.prefillBannerDismissed = true;
            this.errorMsg = '';
            if (failures.length > 0) {
              this.errorMsg = 'Some items failed to add: ' + failures.join(', ');
            }
            if (hasEnvVars) {
              // Don't persist dismissed to URL — env vars still need values + save.
              // On refresh the banner will reappear so the user can re-approve.
              this.successMsg = 'Changes approved! Please fill in secret values below, then Save Settings.';
            } else {
              var u = new URL(window.location.href); u.searchParams.set('dismissed','1'); window.history.replaceState({}, '', u.toString());
              this.successMsg = failures.length > 0 ? 'Changes partially applied.' : 'All changes approved and saved!';
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } catch (e) {
            this.errorMsg = 'Error approving changes: ' + e.message;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } finally {
            this.approvingPrefills = false;
          }
        }
      };
    }

    function permissionsSection() {
      return {
        permissionItems: [],
        permissionsLoading: true,
        showAddForm: false,
        newPattern: '',
        newAccess: '1h',

        init() {
          this.loadPermissions();
        },

        apiUrl(path) {
          return '/api/v1/agents/' + encodeURIComponent(__STATE__.agentId) + '/config' + path + '?token=' + encodeURIComponent(__STATE__.token);
        },

        async loadPermissions() {
          this.permissionsLoading = true;
          var items = [];

          try {
            var grantResp = await fetch(this.apiUrl('/grants'));
            if (grantResp.ok) {
              var grants = await grantResp.json();
              for (var k = 0; k < grants.length; k++) {
                var g = grants[k];
                var type = g.denied ? 'denied' : (g.expiresAt === null ? 'always' : 'grant');
                items.push({ pattern: g.pattern, type: type, expiresAt: g.expiresAt, grantedAt: g.grantedAt, denied: !!g.denied });
              }
            }
          } catch (e) { /* ignore */ }

          // Sort: domains first, then MCP tools
          items.sort(function(a, b) {
            var aIsTool = a.pattern.startsWith('/') ? 1 : 0;
            var bIsTool = b.pattern.startsWith('/') ? 1 : 0;
            if (aIsTool !== bIsTool) return aIsTool - bIsTool;
            return a.pattern.localeCompare(b.pattern);
          });

          this.permissionItems = items;
          this.permissionsLoading = false;
        },

        badgeText(item) {
          if (item.denied) return 'Denied';
          if (item.expiresAt === null) return 'Always';
          var remaining = item.expiresAt - Date.now();
          if (remaining <= 0) return 'Expired';
          if (remaining > 86400000) return Math.ceil(remaining / 86400000) + 'd left';
          if (remaining > 3600000) return Math.ceil(remaining / 3600000) + 'h left';
          return Math.ceil(remaining / 60000) + 'min left';
        },

        badgeClass(item) {
          if (item.denied) return 'bg-red-100 text-red-700';
          if (item.expiresAt === null) return 'bg-green-100 text-green-700';
          var remaining = item.expiresAt - Date.now();
          if (remaining <= 0) return 'bg-gray-100 text-gray-500';
          return 'bg-blue-100 text-blue-700';
        },

        async addPermission() {
          var pattern = this.newPattern.trim();
          if (!pattern) return;

          var expiresAt = null;
          var denied = false;
          if (this.newAccess === '1h') expiresAt = Date.now() + 3600000;
          else if (this.newAccess === 'session') expiresAt = Date.now() + 86400000;
          else if (this.newAccess === 'denied') denied = true;

          await fetch(this.apiUrl('/grants'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pattern: pattern, expiresAt: expiresAt, denied: denied || undefined })
          });

          this.newPattern = '';
          this.showAddForm = false;
          await this.loadPermissions();
        },

        async removePermission(item) {
          await fetch(this.apiUrl('/grants/' + encodeURIComponent(item.pattern)), { method: 'DELETE' });
          await this.loadPermissions();
        }
      };
    }
  </script>
</body>
</html>`;
}

/**
 * Render the agent picker / creation page.
 * Shown when a channel-based token has no agent bound.
 */
export function renderPickerPage(
  payload: SettingsTokenPayload,
  agents: (AgentMetadata & { channelCount: number })[],
  token: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configure Agent - Lobu</title>
  <style>${settingsPageCSS}</style>
</head>
<body class="min-h-screen bg-gradient-to-br from-slate-700 to-slate-900 p-4">
  <div class="max-w-xl mx-auto bg-white rounded-2xl shadow-2xl p-6">
    <div class="text-center mb-5">
      <div class="text-4xl mb-1">&#129438;</div>
      <h1 class="text-xl font-bold text-slate-900">Configure Agent</h1>
      <p class="text-xs text-gray-500">${getPlatformDisplay(payload.platform).icon} ${escapeHtml(formatUserId(payload.userId))}</p>
      ${payload.channelId ? `<p class="text-xs text-gray-400 mt-1">Channel: ${escapeHtml(payload.channelId)}</p>` : ""}
    </div>

    <div id="success-msg" class="hidden bg-green-100 text-green-800 px-3 py-2 rounded-lg mb-4 text-center text-sm"></div>
    <div id="error-msg" class="hidden bg-red-100 text-red-800 px-3 py-2 rounded-lg mb-4 text-center text-sm"></div>

    ${
      agents.length > 0
        ? `<!-- Existing Agents -->
    <div class="mb-4">
      <h2 class="text-sm font-medium text-gray-800 mb-2">Your Agents</h2>
      <div class="space-y-2" id="agents-list">
${agents
  .map(
    (agent) => `
        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-800">${escapeHtml(agent.name)}${agent.isWorkspaceAgent ? ' <span class="text-xs text-slate-600">(workspace)</span>' : ""}</p>
            <p class="text-xs text-gray-500">${escapeHtml(agent.agentId)} &middot; ${agent.channelCount} channel${agent.channelCount !== 1 ? "s" : ""}</p>
            ${agent.description ? `<p class="text-xs text-gray-400 truncate">${escapeHtml(agent.description)}</p>` : ""}
          </div>
          <button type="button" onclick="selectAgent('${escapeHtml(agent.agentId)}')"
            class="ml-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all flex-shrink-0">
            Select
          </button>
        </div>`
  )
  .join("")}
      </div>
    </div>`
        : `<div class="mb-4">
      <p class="text-sm text-gray-500 p-3 bg-gray-50 rounded-lg text-center">No agents yet. Create one below to get started.</p>
    </div>`
    }

    <!-- Create New Agent -->
    <div class="border-t border-gray-200 pt-4">
      <h2 class="text-sm font-medium text-gray-800 mb-3">Create New Agent</h2>
      <div class="space-y-2">
        <div>
          <label for="agentName" class="block text-xs font-medium text-gray-600 mb-1">Name</label>
          <input type="text" id="agentName" placeholder="My Agent" maxlength="100"
            oninput="autoGenerateId()"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
        </div>
        <div>
          <label for="agentId" class="block text-xs font-medium text-gray-600 mb-1">Agent ID</label>
          <input type="text" id="agentId" placeholder="my-agent" pattern="[a-z][a-z0-9-]*" minlength="3" maxlength="40"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
          <p class="text-xs text-gray-400 mt-1">Auto-generated from name. Lowercase letters, numbers, hyphens.</p>
        </div>
        <button type="button" id="create-btn" onclick="createAgent()"
          class="w-full py-2.5 bg-gradient-to-r from-slate-700 to-slate-800 text-white text-sm font-semibold rounded-lg hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all">
          Create Agent
        </button>
      </div>
    </div>
  </div>

  <script>
    var token = ${JSON.stringify(token)};
    var idManuallyEdited = false;

    document.getElementById('agentId').addEventListener('input', function() {
      idManuallyEdited = true;
    });

    function autoGenerateId() {
      if (idManuallyEdited) return;
      var name = document.getElementById('agentName').value;
      var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slug.length > 40) slug = slug.substring(0, 40);
      document.getElementById('agentId').value = slug;
    }

    async function selectAgent(agentId) {
      hideMessages();
      try {
        var resp = await fetch('/settings/switch-agent?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agentId })
        });
        var result = await resp.json();
        if (resp.ok) {
          showSuccess('Agent selected! Loading settings...');
          setTimeout(function() { window.location.reload(); }, 500);
        } else {
          showError(result.error || 'Failed to select agent');
        }
      } catch (e) {
        showError('Network error: ' + e.message);
      }
    }

    async function createAgent() {
      var agentId = document.getElementById('agentId').value.trim();
      var name = document.getElementById('agentName').value.trim();

      if (!name) {
        showError('Agent name is required.');
        return;
      }
      if (!agentId) {
        showError('Agent ID is required.');
        return;
      }

      var btn = document.getElementById('create-btn');
      btn.disabled = true;
      btn.textContent = 'Creating...';
      hideMessages();

      try {
        var resp = await fetch('/settings/create-agent?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agentId, name: name })
        });
        var result = await resp.json();
        if (resp.ok) {
          showSuccess('Agent created! Loading settings...');
          setTimeout(function() { window.location.reload(); }, 500);
        } else {
          showError(result.error || 'Failed to create agent');
        }
      } catch (e) {
        showError('Network error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Agent';
      }
    }

    function showSuccess(msg) {
      var el = document.getElementById('success-msg');
      el.textContent = msg;
      el.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function showError(msg) {
      var el = document.getElementById('error-msg');
      el.textContent = msg;
      el.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function hideMessages() {
      document.getElementById('success-msg').classList.add('hidden');
      document.getElementById('error-msg').classList.add('hidden');
    }
  </script>
</body>
</html>`;
}

export function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settings Error - Lobu</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.25rem; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(to bottom right, #ef4444, #b91c1c); }
    .card { background: #fff; border-radius: 1rem; box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25); padding: 2.5rem; max-width: 28rem; width: 100%; text-align: center; }
    .icon { font-size: 3.75rem; margin-bottom: 1.25rem; }
    h1 { font-size: 1.5rem; font-weight: 700; color: #dc2626; margin: 0 0 1rem 0; }
    p { color: #4b5563; margin: 0 0 1.25rem 0; }
    .error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.5rem; padding: 1rem; color: #b91c1c; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10060;</div>
    <h1>Settings Error</h1>
    <p>Unable to load settings page.</p>
    <div class="error-box">
      ${escapeHtml(message)}
    </div>
  </div>
</body>
</html>`;
}
