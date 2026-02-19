/**
 * Settings Page HTML Templates (Alpine.js + Pre-compiled Tailwind CSS)
 */

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
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
}

export interface GitHubOptions {
  githubAppConfigured: boolean;
  githubAppInstallUrl?: string;
  githubOAuthConfigured?: boolean;
  providers?: ProviderMeta[];
}

export function renderSettingsPage(
  payload: SettingsTokenPayload,
  settings: AgentSettings | null,
  token: string,
  options?: GitHubOptions
): string {
  const s: Partial<AgentSettings> = settings || {};
  const githubAppConfigured = options?.githubAppConfigured ?? false;
  const githubAppInstallUrl = options?.githubAppInstallUrl ?? "";
  const githubOAuthConfigured = options?.githubOAuthConfigured ?? false;
  const providers: ProviderMeta[] = options?.providers ?? [
    {
      id: "claude",
      name: "Claude",
      iconUrl: "https://www.anthropic.com/favicon.ico",
      authType: "oauth",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "",
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      iconUrl: "https://chatgpt.com/favicon.ico",
      authType: "device-code",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "",
    },
  ];

  const envVarsValue = (() => {
    const existingEnvVars = s.envVars || {};
    const prefillKeys = payload.prefillEnvVars || [];
    const allKeys = new Set([...Object.keys(existingEnvVars), ...prefillKeys]);
    return Array.from(allKeys)
      .map((k) => `${k}=${existingEnvVars[k] || ""}`)
      .join("\n");
  })();

  const initialState = {
    token,
    agentId: payload.agentId,
    githubOAuthConfigured,
    githubAppConfigured,
    githubAppInstallUrl,
    PROVIDERS: Object.fromEntries(
      providers.map((p) => [p.id, { name: p.name, authType: p.authType }])
    ),
    initialSkills: s.skillsConfig?.skills || [],
    initialMcpServers: s.mcpServers || {},
    prefillSkills: payload.prefillSkills || [],
    prefillMcpServers: payload.prefillMcpServers || [],
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
    <div class="text-center mb-5">
      <div class="text-4xl mb-1">&#129438;</div>
      <h1 class="text-xl font-bold text-slate-900">Agent Settings</h1>
      <p class="text-xs text-gray-500">${getPlatformDisplay(payload.platform).icon} ${escapeHtml(formatUserId(payload.userId))}</p>
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
    ${
      payload.prefillSkills?.length || payload.prefillMcpServers?.length
        ? `<!-- Suggested Additions Section -->
    <div class="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
      <h3 class="text-sm font-medium text-slate-900 mb-3 flex items-center gap-2">
        <span>&#9889;</span> Quick Setup
      </h3>
      ${
        payload.prefillSkills?.length
          ? `<div class="mb-3">
        <p class="text-xs font-medium text-slate-800 mb-2">Suggested Skills:</p>
        <div class="space-y-2">
          ${payload.prefillSkills
            .map(
              (skill, idx) => `
          <div class="flex items-center justify-between bg-white rounded-lg p-2 border border-slate-200" x-data="{ added: false, adding: false }">
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-gray-800">${escapeHtml(skill.name || skill.repo)}</p>
              ${skill.description ? `<p class="text-xs text-gray-500 truncate">${escapeHtml(skill.description)}</p>` : ""}
              <p class="text-xs text-gray-400 font-mono">${escapeHtml(skill.repo)}</p>
            </div>
            <button type="button" @click="adding = true; if (await addPrefillSkill(${idx})) added = true; adding = false" :disabled="adding || added"
              class="ml-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex-shrink-0"
              :class="added ? 'bg-green-600 text-white' : 'bg-slate-600 text-white hover:bg-slate-700'"
              x-text="adding ? 'Adding...' : (added ? 'Added \\u2713' : 'Add')">
            </button>
          </div>`
            )
            .join("")}
        </div>
      </div>`
          : ""
      }
      ${
        payload.prefillMcpServers?.length
          ? `<div>
        <p class="text-xs font-medium text-slate-800 mb-2">Suggested External Integrations (MCP):</p>
        <div class="space-y-2">
          ${payload.prefillMcpServers
            .map(
              (mcp, idx) => `
          <div class="flex items-center justify-between bg-white rounded-lg p-2 border border-slate-200" x-data="{ added: false, adding: false }">
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-gray-800">${escapeHtml(mcp.name || mcp.id)}</p>
              ${mcp.url ? `<p class="text-xs text-gray-500 truncate">${escapeHtml(mcp.url)}</p>` : ""}
              ${mcp.command ? `<p class="text-xs text-gray-400 font-mono">${escapeHtml(mcp.command)} ${(mcp.args || []).join(" ")}</p>` : ""}
              ${mcp.envVars?.length ? `<p class="text-xs text-slate-600">Requires: ${mcp.envVars.join(", ")}</p>` : ""}
            </div>
            <button type="button" @click="adding = true; if (await addPrefillMcp(${idx})) added = true; adding = false" :disabled="adding || added"
              class="ml-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex-shrink-0"
              :class="added ? 'bg-green-600 text-white' : 'bg-slate-600 text-white hover:bg-slate-700'"
              x-text="adding ? 'Adding...' : (added ? 'Added \\u2713' : 'Add')">
            </button>
          </div>`
            )
            .join("")}
        </div>
      </div>`
          : ""
      }
    </div>`
        : ""
    }

    <form @submit.prevent="saveSettings()" @keydown.enter="if ($event.target.tagName !== 'TEXTAREA' && $event.target.type !== 'submit') $event.preventDefault()" class="space-y-3">
      <!-- Model Selection -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#129302;</span>
          Model
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3">
          ${providers
            .map(
              (p, i) => `
      <div class="${i > 0 ? "mt-3 pt-3 border-t border-gray-200" : ""}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <img src="${escapeHtml(p.iconUrl)}" alt="${escapeHtml(p.name)}" class="w-5 h-5 rounded">
            <div>
              <p class="text-sm font-medium text-gray-800">${escapeHtml(p.name)}</p>
              <p class="text-xs"
                :class="providerState['${p.id}']?.connected ? 'text-emerald-600' : 'text-gray-500'"
                x-text="providerState['${p.id}']?.status || 'Checking...'"></p>
            </div>
          </div>
          <button type="button" @click="providerState['${p.id}']?.connected ? disconnectProvider('${p.id}') : connectProvider('${p.id}')"
            class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all"
            :class="providerState['${p.id}']?.connected ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'"
            x-text="providerState['${p.id}']?.connected ? 'Disconnect' : 'Connect'">
          </button>
        </div>
        ${
          p.authType === "oauth"
            ? `<!-- Code input -->
        <div x-show="providerState['${p.id}']?.showCodeInput" x-transition class="mt-3 pt-3 border-t border-gray-200">
          <p class="text-xs text-gray-600 mb-2">Paste the authentication code from ${escapeHtml(p.name)}:</p>
          <div class="flex gap-2">
            <input type="text" x-model="providerState['${p.id}'].code" placeholder="CODE#STATE" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
            <button type="button" @click="submitOAuthCode('${p.id}')" class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
              Submit
            </button>
          </div>
          <p class="text-xs text-gray-400 mt-1">Format: CODE#STATE (copy the entire code shown after login)</p>
        </div>`
            : ""
        }
        ${
          p.authType === "device-code"
            ? `<!-- Device code flow -->
        <div x-show="providerState['${p.id}']?.showDeviceCode" x-transition class="mt-3 pt-3 border-t border-gray-200">
          <div class="text-center">
            <p class="text-xs text-gray-600 mb-2">Enter this code at the verification page:</p>
            <p class="text-2xl font-mono font-bold text-slate-800 mb-2" x-text="providerState['${p.id}']?.userCode || ''"></p>
            <a :href="providerState['${p.id}']?.verificationUrl || 'https://auth.openai.com/codex/device'" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all mb-2">
              Open Verification Page
            </a>
            <p class="text-xs text-gray-400" x-text="providerState['${p.id}']?.pollStatus || 'Waiting for authorization...'"></p>
          </div>
        </div>`
            : ""
        }
        ${
          p.authType === "api-key"
            ? `<!-- API key input -->
        <div x-show="providerState['${p.id}']?.showApiKeyInput" x-transition class="mt-3 pt-3 border-t border-gray-200">
          <p class="text-xs text-gray-600 mb-2">${p.apiKeyInstructions}</p>
          <div class="flex gap-2">
            <input type="password" x-model="providerState['${p.id}'].apiKey" placeholder="${escapeHtml(p.apiKeyPlaceholder)}" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
            <button type="button" @click="submitApiKey('${p.id}')" class="px-3 py-2 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all">
              Save
            </button>
          </div>
        </div>`
            : ""
        }
      </div>`
            )
            .join("")}
          <label class="block text-xs font-medium text-gray-700 mt-3 pt-3 border-t border-gray-200 mb-1">Model</label>
          <select id="model" name="model" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
            <option value="">Default</option>
            <optgroup label="Claude">
              <option value="claude-sonnet-4" ${s.model === "claude-sonnet-4" ? "selected" : ""}>Claude Sonnet 4</option>
              <option value="claude-sonnet-4-5" ${s.model === "claude-sonnet-4-5" ? "selected" : ""}>Claude Sonnet 4.5</option>
              <option value="claude-opus-4" ${s.model === "claude-opus-4" ? "selected" : ""}>Claude Opus 4</option>
              <option value="claude-haiku-4" ${s.model === "claude-haiku-4" ? "selected" : ""}>Claude Haiku 4</option>
              <option value="claude-haiku-4-5" ${s.model === "claude-haiku-4-5" ? "selected" : ""}>Claude Haiku 4.5</option>
            </optgroup>
            <optgroup label="ChatGPT">
              <option value="openclaw/openai-codex/gpt-5.2-codex" ${s.model === "openclaw/openai-codex/gpt-5.2-codex" ? "selected" : ""}>GPT-5.2 Codex</option>
              <option value="openclaw/openai-codex/gpt-5.1" ${s.model === "openclaw/openai-codex/gpt-5.1" ? "selected" : ""}>GPT-5.1</option>
              <option value="openclaw/openai-codex/gpt-5.1-codex-max" ${s.model === "openclaw/openai-codex/gpt-5.1-codex-max" ? "selected" : ""}>GPT-5.1 Codex Max</option>
              <option value="openclaw/openai-codex/gpt-5.1-codex-mini" ${s.model === "openclaw/openai-codex/gpt-5.1-codex-mini" ? "selected" : ""}>GPT-5.1 Codex Mini</option>
            </optgroup>
          </select>
        </div>
      </div>

      <!-- Agent Instructions -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128220;</span>
          Agent Instructions
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-3">
          <p class="text-xs text-gray-500">Define your agent's identity, behavior rules, and user context. Supports Markdown with optional YAML frontmatter (auto-stripped).</p>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">IDENTITY.md <span class="text-gray-400">- Who the agent is</span></label>
            <textarea id="identityMd" name="identityMd" placeholder="You are a helpful coding assistant named Alex.&#10;You specialize in TypeScript and React development." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml(s.identityMd || "")}</textarea>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">SOUL.md <span class="text-gray-400">- Behavior rules &amp; instructions</span></label>
            <textarea id="soulMd" name="soulMd" placeholder="Always write tests before implementation.&#10;Prefer functional programming patterns.&#10;Never commit directly to main branch." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[80px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml(s.soulMd || "")}</textarea>
            <!-- Browse Souls from ClawHub -->
            <div class="mt-2">
              <div class="relative">
                <input type="text" x-model="soulSearch" @input.debounce.300ms="searchSouls()" @focus="if (!soulSearch.trim()) searchSouls(); else soulSearchVisible = true" placeholder="Browse community souls from ClawHub..." class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none" :disabled="soulSearchLoading">
                <div x-show="soulSearchVisible" @click.away="soulSearchVisible = false" class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  <template x-for="item in soulSearchResults" :key="item.slug">
                    <div class="p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0" @click="loadSoul(item.slug)">
                      <div class="flex items-center justify-between">
                        <div class="flex-1 min-w-0">
                          <p class="text-xs font-medium text-gray-800 truncate" x-text="item.displayName || item.slug"></p>
                          <p class="text-xs text-gray-500 truncate" x-text="(item.summary || '').substring(0, 80)"></p>
                        </div>
                        <span class="text-xs text-slate-600 ml-2 shrink-0">Use</span>
                      </div>
                    </div>
                  </template>
                  <template x-if="soulSearchResults.length === 0 && soulSearchVisible">
                    <div class="p-2 text-xs text-gray-500" x-text="soulSearchLoading ? 'Loading...' : 'No souls found'"></div>
                  </template>
                </div>
              </div>
              <p class="text-xs text-gray-400 mt-1">Browse <a href="https://clawhub.ai/souls" target="_blank" class="text-slate-600 hover:underline">ClawHub souls</a> to use as a starting point. Content will be loaded into the textarea above for editing.</p>
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">USER.md <span class="text-gray-400">- User-specific context</span></label>
            <textarea id="userMd" name="userMd" placeholder="The user prefers concise responses.&#10;Their timezone is UTC+3.&#10;They use VS Code as their IDE." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml(s.userMd || "")}</textarea>
          </div>
        </div>
      </div>

      <!-- Skills Section -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128736;</span>
          Skills
          <span x-show="skillsLoading" class="animate-spin text-slate-600">&#8635;</span>
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-3">
          <!-- Skills Error -->
          <div x-show="skillsError" x-transition class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs" x-text="skillsError"></div>

          <!-- Enabled Skills List -->
          <div class="space-y-2">
            <template x-if="skills.length === 0">
              <p class="text-xs text-gray-500">No skills configured yet.</p>
            </template>
            <template x-for="skill in skills" :key="skill.repo">
              <div class="flex items-center justify-between p-2 bg-white rounded border border-gray-200">
                <div class="flex-1 min-w-0">
                  <a :href="'https://clawhub.ai/skills/' + encodeURIComponent(skill.repo)" target="_blank" class="text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline truncate block" x-text="skill.name"></a>
                  <p x-show="skill.description" class="text-xs text-gray-500 truncate" x-text="skill.description"></p>
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
          </div>

          <!-- Add Skill Section -->
          <div class="border-t border-gray-200 pt-3">
            <p class="text-xs font-medium text-gray-600 mb-2">Add Skills</p>

            <!-- Search Input -->
            <div class="relative mb-2">
              <input type="text" x-model="skillSearch" @input.debounce.300ms="searchSkills()" @focus="if (skillSearch.trim()) skillSearchVisible = true" placeholder="Search skills from ClawHub..." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <div x-show="skillSearchVisible" @click.away="skillSearchVisible = false" class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <template x-for="result in skillSearchResults" :key="result.id">
                  <div class="p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0" @click="addSkillFromSearch(result.id)">
                    <div class="flex items-center justify-between">
                      <div class="flex-1 min-w-0">
                        <p class="text-xs font-medium text-gray-800 truncate" x-text="result.name"></p>
                        <p x-show="result.description" class="text-xs text-gray-500 truncate" x-text="result.description"></p>
                      </div>
                      <div class="flex items-center gap-2 ml-2">
                        <span class="text-xs text-gray-400" x-text="formatInstalls(result.installs)"></span>
                        <span class="text-xs" :class="skills.some(function(sk) { return sk.repo === result.id }) ? 'text-green-600' : 'text-slate-600'" x-text="skills.some(function(sk) { return sk.repo === result.id }) ? 'Added' : '+ Add'"></span>
                      </div>
                    </div>
                  </div>
                </template>
                <template x-if="skillSearchResults.length === 0 && skillSearchVisible">
                  <div class="p-2 text-xs text-gray-500">No skills found</div>
                </template>
              </div>
            </div>

            <!-- Quick Add: Curated Skills -->
            <div class="mb-2">
              <p class="text-xs text-gray-500 mb-1">Quick add popular skills:</p>
              <div class="flex flex-wrap gap-1">
                <template x-for="cs in curatedSkills" :key="cs.repo">
                  <button type="button" @click="addSkillFromChip(cs.repo)"
                    class="px-2 py-1 text-xs rounded-full bg-slate-100 text-slate-800"
                    :class="skills.some(function(sk) { return sk.repo === cs.repo }) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-200'"
                    :disabled="skills.some(function(sk) { return sk.repo === cs.repo })"
                    :title="skills.some(function(sk) { return sk.repo === cs.repo }) ? 'Already added' : cs.description"
                    x-text="cs.name"></button>
                </template>
              </div>
            </div>

            <!-- Manual Entry -->
            <div class="flex gap-2">
              <input type="text" x-model="customSkillRepo" placeholder="Or enter slug: skill-name" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <button type="button" @click="if (customSkillRepo.trim()) { addSkill(customSkillRepo.trim()); customSkillRepo = ''; }" class="px-3 py-2 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition-all">
                Add
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">Skills from <a href="https://clawhub.ai/skills" target="_blank" class="text-slate-600 hover:underline">ClawHub</a> extend your agent's capabilities.</p>
          </div>
        </div>
      </div>

      <!-- External Integrations (MCP) Section -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128268;</span>
          External Integrations (MCP)
          <span x-show="mcpsLoading" class="animate-spin text-slate-600">&#8635;</span>
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-3">
          <!-- MCPs Error -->
          <div x-show="mcpsError" x-transition class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs" x-text="mcpsError"></div>

          <!-- Enabled MCPs List -->
          <div class="space-y-2">
            <template x-if="mcpServerIds.length === 0">
              <p class="text-xs text-gray-500">No MCP servers configured yet.</p>
            </template>
            <template x-for="mcpId in mcpServerIds" :key="mcpId">
              <div class="flex items-center justify-between p-2 bg-white rounded border border-gray-200">
                <div class="flex-1 min-w-0">
                  <p class="text-xs font-medium text-gray-800 truncate" x-text="mcpId"></p>
                  <p x-show="getMcpDescription(mcpId)" class="text-xs text-gray-500 truncate" x-text="getMcpDescription(mcpId)"></p>
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

          <!-- Add MCP Section -->
          <div class="border-t border-gray-200 pt-3">
            <p class="text-xs font-medium text-gray-600 mb-2">Add Integrations</p>

            <!-- Search Input -->
            <div class="relative mb-2">
              <input type="text" x-model="mcpSearch" @input.debounce.300ms="searchMcps()" @focus="if (mcpSearch.trim()) mcpSearchVisible = true" placeholder="Search MCP servers..." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <div x-show="mcpSearchVisible" @click.away="mcpSearchVisible = false" class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <template x-for="result in mcpSearchResults" :key="result.id">
                  <div class="p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0" @click="addMcpFromSearch(result.id)">
                    <div class="flex items-center justify-between">
                      <div class="flex-1 min-w-0">
                        <p class="text-xs font-medium text-gray-800 truncate" x-text="result.name"></p>
                        <p class="text-xs text-gray-500 truncate" x-text="result.description"></p>
                      </div>
                      <div class="flex items-center gap-2 ml-2">
                        <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600" x-text="result.type"></span>
                        <span class="text-xs" :class="mcpServers.hasOwnProperty(result.id) ? 'text-green-600' : 'text-slate-600'" x-text="mcpServers.hasOwnProperty(result.id) ? 'Added' : '+ Add'"></span>
                      </div>
                    </div>
                  </div>
                </template>
                <template x-if="mcpSearchResults.length === 0 && mcpSearchVisible">
                  <div class="p-2 text-xs text-gray-500">No MCPs found</div>
                </template>
              </div>
            </div>

            <!-- Quick Add: Curated MCPs -->
            <div class="mb-2">
              <p class="text-xs text-gray-500 mb-1">Quick add popular MCPs:</p>
              <div class="flex flex-wrap gap-1">
                <template x-for="cm in curatedMcps" :key="cm.id">
                  <button type="button" @click="addMcpFromChip(cm.id)"
                    class="px-2 py-1 text-xs rounded-full bg-slate-100 text-slate-800"
                    :class="mcpServers.hasOwnProperty(cm.id) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-200'"
                    :disabled="mcpServers.hasOwnProperty(cm.id)"
                    :title="mcpServers.hasOwnProperty(cm.id) ? 'Already added' : cm.description"
                    x-text="cm.name"></button>
                </template>
              </div>
            </div>

            <!-- Manual Entry -->
            <div class="space-y-2">
              <input type="text" x-model="customMcpId" placeholder="MCP ID (e.g., my-custom-mcp)" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <input type="text" x-model="customMcpUrl" placeholder="URL (e.g., https://mcp.example.com/sse)" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
              <button type="button" @click="if (customMcpId.trim()) { addMcp(customMcpId.trim(), customMcpUrl.trim() || null); customMcpId = ''; customMcpUrl = ''; }" class="px-3 py-2 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition-all">
                Add Custom MCP
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">MCP servers extend Claude's capabilities with external tools and data sources.</p>
          </div>
        </div>
      </div>

      <!-- Scheduled Reminders Section -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#9200;</span>
          Scheduled Reminders
          <span x-show="schedulesLoading" class="animate-spin text-slate-600">&#8635;</span>
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3">
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

      <!-- Advanced Section -->
      <div class="border border-gray-200 rounded-lg" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none p-3" @click="open = !open">
          <span>&#9881;</span>
          Advanced
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="px-3 pb-3 space-y-3">

      <!-- Network Configuration -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#127760;</span>
          Network Access
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-3">
          <div>
            <label for="allowedDomains" class="block text-xs font-medium text-gray-600 mb-1">Allowed Domains</label>
            <textarea id="allowedDomains" name="allowedDomains" placeholder="github.com&#10;*.trusted.com" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml((s.networkConfig?.allowedDomains || []).join("\n"))}</textarea>
          </div>
          <div>
            <label for="deniedDomains" class="block text-xs font-medium text-gray-600 mb-1">Denied Domains</label>
            <textarea id="deniedDomains" name="deniedDomains" placeholder="malicious.com" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml((s.networkConfig?.deniedDomains || []).join("\n"))}</textarea>
          </div>
        </div>
      </div>

      <!-- Git Configuration -->
      ${
        githubAppConfigured
          ? `
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128193;</span>
          Git Repository
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-2">
          <!-- GitHub User Connection -->
          <div class="mb-3 pb-3 border-b border-gray-200">
            <div x-show="githubUserLoading" class="text-center py-2">
              <p class="text-xs text-gray-500">Checking GitHub connection...</p>
            </div>
            <div x-show="!githubUserLoading && !githubUser && githubOAuthConfigured" class="text-center py-2">
              <p class="text-xs text-gray-600 mb-2">Connect your GitHub account to see your repositories</p>
              <a :href="'/api/v1/oauth/github/login?token=' + encodeURIComponent(token)" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-all">
                <svg class="w-4 h-4 inline-block mr-1" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/></svg>
                Connect with GitHub
              </a>
            </div>
            <div x-show="!githubUserLoading && githubUser" class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <img :src="githubUser?.avatarUrl || ''" :alt="githubUser?.login || ''" class="w-6 h-6 rounded-full">
                <div>
                  <p class="text-xs font-medium text-gray-800" x-text="githubUser?.login || ''"></p>
                  <p class="text-xs text-green-600">Connected</p>
                </div>
              </div>
              <button type="button" @click="disconnectGitHub()" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-100 text-red-700 hover:bg-red-200 transition-all">
                Disconnect
              </button>
            </div>
            <div x-show="!githubUserLoading && !githubUser && !githubOAuthConfigured" class="text-center py-2">
              <p class="text-xs text-gray-400">GitHub authentication not configured</p>
            </div>
          </div>

          <!-- Loading state -->
          <div x-show="gitLoading" class="text-center py-4">
            <p class="text-xs text-gray-500">Loading GitHub installations...</p>
          </div>

          <!-- Install prompt -->
          <div x-show="showInstallPrompt && !gitLoading" class="text-center py-4 border-2 border-dashed border-gray-200 rounded-lg">
            <p class="text-xs text-gray-600 mb-2">Install the GitHub App to enable repository access</p>
            <div class="flex items-center justify-center gap-2">
              ${
                githubAppInstallUrl
                  ? `<a href="${escapeHtml(githubAppInstallUrl)}" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-all">
                Install on GitHub &rarr;
              </a>`
                  : `<p class="text-xs text-gray-400">Contact administrator to install the GitHub App</p>`
              }
              <button type="button" @click="refreshGitHub()" class="px-4 py-2 text-xs font-medium rounded-lg bg-slate-100 text-slate-800 hover:bg-slate-200 transition-all">
                &#8635; Refresh
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-2">After installing, click Refresh to see your repositories</p>
          </div>

          <!-- Repo selection -->
          <div x-show="showRepoSelection && !gitLoading" class="space-y-2">
            <div>
              <label for="gitOrg" class="block text-xs font-medium text-gray-600 mb-1">Organization / User</label>
              <select id="gitOrg" name="gitOrg" @change="onOrgChange($event.target.value)" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
                <option value="">Select...</option>
                <template x-for="inst in githubInstallations" :key="inst.id">
                  <option :value="inst.id" :selected="inst.id == selectedOrg" x-text="inst.account + (inst.accountType === 'Organization' ? ' (org)' : '')"></option>
                </template>
              </select>
            </div>
            <div>
              <label for="gitRepo" class="block text-xs font-medium text-gray-600 mb-1">Repository</label>
              <select id="gitRepo" name="gitRepo" @change="onRepoChange($event.target)" :disabled="!selectedOrg" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
                <template x-if="!selectedOrg">
                  <option value="">Select organization first...</option>
                </template>
                <template x-if="selectedOrg && repoOptions.length === 0">
                  <option value="">Loading...</option>
                </template>
                <template x-if="selectedOrg && repoOptions.length > 0">
                  <option value="">Select...</option>
                </template>
                <template x-for="repo in repoOptions" :key="repo.name">
                  <option :value="repo.name" :data-full-name="repo.fullName" :data-owner="repo.owner" :data-default-branch="repo.defaultBranch" :selected="repo.name === selectedRepo" x-text="repo.name + (repo.private ? ' &#128274;' : '')"></option>
                </template>
              </select>
            </div>
            <div>
              <label for="gitBranch" class="block text-xs font-medium text-gray-600 mb-1">Branch</label>
              <select id="gitBranch" name="gitBranch" @change="onBranchChange($event.target.value)" :disabled="!selectedRepo" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
                <template x-if="!selectedRepo">
                  <option value="">Select repository first...</option>
                </template>
                <template x-for="br in branchOptions" :key="br.name">
                  <option :value="br.name" :selected="br.name === selectedBranch" x-text="br.name + (br.protected ? ' &#128737;&#65039;' : '') + (br.isDefault ? ' (default)' : '')"></option>
                </template>
              </select>
            </div>
            <div>
              <label for="sparse" class="block text-xs font-medium text-gray-600 mb-1">Sparse Checkout (optional)</label>
              <textarea id="sparse" name="sparse" placeholder="src/&#10;docs/" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[50px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml((s.gitConfig?.sparse || []).join("\n"))}</textarea>
              <p class="text-xs text-gray-400 mt-1">Only checkout specific directories (one per line)</p>
            </div>
          </div>

          <!-- Hidden fields for form submission -->
          <input type="hidden" id="repoUrl" name="repoUrl" :value="repoUrlValue">
          <input type="hidden" id="branch" name="branch" :value="selectedBranch">
          <input type="hidden" id="selectedInstallationId" name="selectedInstallationId" :value="currentInstallationId || ''">
        </div>
      </div>
      `
          : `
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: false }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128193;</span>
          Git Repository
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-2">
          <p class="text-xs text-gray-500">GitHub App is not configured. You can still use a manual repository URL.</p>
          <div>
            <label for="repoUrl" class="block text-xs font-medium text-gray-600 mb-1">Repository URL</label>
            <input id="repoUrl" name="repoUrl" type="text" placeholder="https://github.com/owner/repo" value="${escapeHtml(s.gitConfig?.repoUrl || "")}" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
          </div>
          <div>
            <label for="branch" class="block text-xs font-medium text-gray-600 mb-1">Branch (optional)</label>
            <input id="branch" name="branch" type="text" placeholder="main" value="${escapeHtml(s.gitConfig?.branch || "")}" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">
          </div>
          <div>
            <label for="sparse" class="block text-xs font-medium text-gray-600 mb-1">Sparse Checkout (optional)</label>
            <textarea id="sparse" name="sparse" placeholder="src/&#10;docs/" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[50px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml((s.gitConfig?.sparse || []).join("\n"))}</textarea>
            <p class="text-xs text-gray-400 mt-1">Only checkout specific directories (one per line)</p>
          </div>
        </div>
      </div>
      `
      }

      <!-- System Packages -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: ${payload.prefillNixPackages?.length ? "true" : "false"} }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128230;</span>
          System Packages
          ${payload.prefillNixPackages?.length ? '<span class="text-xs text-slate-600 font-normal">(action needed)</span>' : ""}
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3 space-y-3">
          <div>
            <label for="nixPackages" class="block text-xs font-medium text-gray-600 mb-1">Packages (one per line)</label>
            <textarea id="nixPackages" name="nixPackages" placeholder="python311&#10;ffmpeg&#10;jq" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml(
              (() => {
                const existing = s.nixConfig?.packages || [];
                const prefill = payload.prefillNixPackages || [];
                const merged = [...new Set([...existing, ...prefill])];
                return merged.join("\n");
              })()
            )}</textarea>
            ${payload.prefillNixPackages?.length ? '<p class="text-xs text-slate-600 mt-1">&#11014;&#65039; Suggested packages have been pre-filled. Review and save to apply.</p>' : ""}
          </div>
        </div>
      </div>

      <!-- Environment Variables -->
      <div class="bg-gray-50 rounded-lg p-3" x-data="{ open: ${payload.prefillEnvVars?.length ? "true" : "false"} }">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" @click="open = !open">
          <span>&#128203;</span>
          Environment Variables
          ${payload.prefillEnvVars?.length ? '<span class="text-xs text-slate-600 font-normal">(action needed)</span>' : ""}
          <span class="ml-auto text-xs text-gray-400 transition-transform" :class="open ? '' : 'rotate-[-90deg]'">&#9660;</span>
        </h3>
        <div x-show="open" x-transition class="pt-3">
          <textarea id="envVars" name="envVars" placeholder="API_KEY=your_key&#10;DEBUG=true" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none">${escapeHtml(envVarsValue)}</textarea>
          ${
            payload.prefillEnvVars?.length
              ? `<p class="text-xs text-slate-600 mt-1">&#11014;&#65039; Please fill in the values for the highlighted variables above.</p>`
              : ""
          }
        </div>
      </div>

      <!-- Verbose Logging -->
      <div class="bg-gray-50 rounded-lg p-3">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="verboseLogging" name="verboseLogging" ${s.verboseLogging ? "checked" : ""} class="w-4 h-4 text-slate-600 rounded focus:ring-slate-500">
          <span class="text-sm font-medium text-gray-800">Verbose logging</span>
        </label>
        <p class="text-xs text-gray-500 mt-1 ml-6">Show tool calls, reasoning tokens, and detailed output</p>
      </div>

        </div>
      </div>

      <button type="submit" :disabled="saving"
        class="w-full py-3 bg-gradient-to-r from-slate-700 to-slate-800 text-white text-sm font-semibold rounded-lg hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
        x-text="saving ? 'Saving...' : 'Save Settings'">
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
        githubOAuthConfigured: __STATE__.githubOAuthConfigured,
        githubAppConfigured: __STATE__.githubAppConfigured,
        githubAppInstallUrl: __STATE__.githubAppInstallUrl,
        PROVIDERS: __STATE__.PROVIDERS,

        // UI
        successMsg: '',
        errorMsg: '',
        saving: false,

        // Providers
        providerState: {},
        chatgptPollTimer: null,

        // GitHub
        githubUser: null,
        githubUserLoading: true,
        githubInstallations: [],
        githubRepos: {},
        currentInstallationId: null,
        selectedOrg: '',
        selectedRepo: '',
        selectedBranch: '',
        repoUrlValue: ${JSON.stringify(s.gitConfig?.repoUrl || "")},
        repoOptions: [],
        branchOptions: [],
        gitLoading: false,
        showInstallPrompt: false,
        showRepoSelection: false,

        // Skills
        skills: __STATE__.initialSkills,
        skillSearch: '',
        skillSearchResults: [],
        skillSearchVisible: false,
        skillsLoading: false,
        skillsError: '',
        curatedSkills: [],
        customSkillRepo: '',

        // Soul search
        soulSearch: '',
        soulSearchResults: [],
        soulSearchVisible: false,
        soulSearchLoading: false,

        // MCPs
        mcpServers: __STATE__.initialMcpServers,
        mcpSearch: '',
        mcpSearchResults: [],
        mcpSearchVisible: false,
        mcpsLoading: false,
        mcpsError: '',
        curatedMcps: [],
        customMcpId: '',
        customMcpUrl: '',

        // Schedules
        schedules: [],
        schedulesLoading: false,
        schedulesError: '',

        // Prefills
        prefillSkills: __STATE__.prefillSkills,
        prefillMcpServers: __STATE__.prefillMcpServers,

        get mcpServerIds() {
          return Object.keys(this.mcpServers);
        },

        init() {
          // Initialize provider state
          for (var pid in this.PROVIDERS) {
            this.providerState[pid] = {
              status: 'Checking...',
              connected: false,
              showCodeInput: false,
              showDeviceCode: false,
              showApiKeyInput: false,
              code: '',
              apiKey: '',
              userCode: '',
              verificationUrl: '',
              pollStatus: 'Waiting for authorization...',
              deviceAuthId: ''
            };
          }

          // Check for github_connected query param
          var urlParams = new URLSearchParams(window.location.search);
          if (urlParams.get('github_connected') === 'true') {
            this.successMsg = 'GitHub account connected!';
            var newUrl = window.location.pathname + '?token=' + encodeURIComponent(this.token);
            window.history.replaceState({}, '', newUrl);
          }

          this.checkProviders();
          this.initSkills();
          this.initMcps();
          this.initSchedules();
          if (this.githubAppConfigured) {
            this.initGitHubUser();
          } else {
            this.githubUserLoading = false;
          }
        },

        // === Helpers ===
        parseLines(text) {
          return text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
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

        // === Form Submission ===
        async saveSettings() {
          this.saving = true;
          this.successMsg = '';
          this.errorMsg = '';

          var settings = {};

          // Model
          var model = document.getElementById('model').value;
          if (model) settings.model = model;

          // Workspace files
          settings.identityMd = document.getElementById('identityMd').value;
          settings.soulMd = document.getElementById('soulMd').value;
          settings.userMd = document.getElementById('userMd').value;

          // Network config
          var allowedDomains = this.parseLines(document.getElementById('allowedDomains').value);
          var deniedDomains = this.parseLines(document.getElementById('deniedDomains').value);
          if (allowedDomains.length || deniedDomains.length) {
            settings.networkConfig = {};
            if (allowedDomains.length) settings.networkConfig.allowedDomains = allowedDomains;
            if (deniedDomains.length) settings.networkConfig.deniedDomains = deniedDomains;
          }

          // Git config
          var repoUrl = document.getElementById('repoUrl').value.trim();
          var branch = document.getElementById('branch').value.trim();
          var sparse = this.parseLines(document.getElementById('sparse').value);
          if (repoUrl || branch || sparse.length) {
            if (!repoUrl) {
              this.errorMsg = 'Repository URL is required when Git config is set';
              this.saving = false;
              window.scrollTo({ top: 0, behavior: 'smooth' });
              return;
            }
            settings.gitConfig = {};
            settings.gitConfig.repoUrl = repoUrl;
            if (branch) settings.gitConfig.branch = branch;
            if (sparse.length) settings.gitConfig.sparse = sparse;
          } else {
            settings.gitConfig = null;
          }

          // System packages
          var nixPackages = this.parseLines(document.getElementById('nixPackages').value);
          if (nixPackages.length) {
            settings.nixConfig = { packages: nixPackages };
          } else {
            settings.nixConfig = null;
          }

          // Environment variables
          var envVarsText = document.getElementById('envVars').value;
          var envVarsLines = this.parseLines(envVarsText);
          if (envVarsLines.length) {
            settings.envVars = {};
            for (var i = 0; i < envVarsLines.length; i++) {
              var line = envVarsLines[i];
              var eqIdx = line.indexOf('=');
              if (eqIdx > 0) {
                var key = line.slice(0, eqIdx).trim();
                var value = line.slice(eqIdx + 1);
                if (key) settings.envVars[key] = value;
              }
            }
          }

          // Verbose logging
          settings.verboseLogging = document.getElementById('verboseLogging').checked;

          try {
            var response = await fetch(this.apiUrl('/config'), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings)
            });

            var result = await response.json();

            if (response.ok) {
              this.successMsg = 'Settings saved!';
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
              this.updateProviderStatus(provider, info.connected);
            }
          } catch (e) {
            if (this.providerState['claude']) {
              this.providerState['claude'].status = 'Error checking status';
            }
          }
        },

        updateProviderStatus(provider, connected) {
          if (!this.providerState[provider]) return;
          this.providerState[provider].connected = connected;
          this.providerState[provider].status = connected ? 'Connected' : 'Not connected';
        },

        connectProvider(provider) {
          var info = this.PROVIDERS[provider];
          if (!info) return;

          if (info.authType === 'device-code') {
            this.connectDeviceCode(provider);
            return;
          }

          if (info.authType === 'api-key') {
            this.providerState[provider].showApiKeyInput = true;
            this.providerState[provider].status = 'Enter your API key...';
            return;
          }

          // OAuth flow
          window.open('/api/v1/oauth/providers/' + provider + '/login?token=' + encodeURIComponent(this.token), '_blank');
          this.providerState[provider].showCodeInput = true;
          this.providerState[provider].status = 'Waiting for code...';
        },

        async submitOAuthCode(provider) {
          var code = (this.providerState[provider].code || '').trim();
          if (!code) {
            alert('Please enter the authentication code');
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
              this.providerState[provider].code = '';
              this.updateProviderStatus(provider, true);
              this.successMsg = 'Connected to ' + (this.PROVIDERS[provider]?.name || provider) + '!';
            } else {
              throw new Error(result.error || 'Failed to verify code');
            }
          } catch (e) {
            alert('Error: ' + e.message);
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
              this.providerState[provider].apiKey = '';
              this.updateProviderStatus(provider, true);
              this.successMsg = 'Connected to ' + (this.PROVIDERS[provider]?.name || provider) + '!';
            } else {
              throw new Error(result.error || 'Failed to save API key');
            }
          } catch (e) {
            alert('Error: ' + e.message);
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
            this.chatgptPollTimer = setInterval(function() {
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
              clearInterval(this.chatgptPollTimer);
              this.chatgptPollTimer = null;
              ps.showDeviceCode = false;
              this.updateProviderStatus(provider, true);
              this.successMsg = 'Connected to ' + (this.PROVIDERS[provider]?.name || provider) + '!';
            } else if (data.error) {
              clearInterval(this.chatgptPollTimer);
              this.chatgptPollTimer = null;
              ps.pollStatus = 'Error: ' + data.error;
            }
          } catch (e) {
            console.error('Poll error:', e);
          }
        },

        async disconnectProvider(provider) {
          var info = this.PROVIDERS[provider];
          var name = info?.name || provider;
          if (!confirm('Disconnect from ' + name + '? You will need to reconnect to use this provider.')) return;

          if (info?.authType === 'device-code' || info?.authType === 'api-key') {
            await fetch('/api/v1/auth/' + provider + '/logout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: this.agentId })
            });
          } else {
            await fetch('/api/v1/oauth/providers/' + provider + '/logout?token=' + encodeURIComponent(this.token), { method: 'POST' });
          }
          this.checkProviders();
        },

        // === GitHub App ===
        async initGitHubUser() {
          try {
            var resp = await fetch(this.apiUrl('/config'));
            var data = await resp.json();

            this.githubUserLoading = false;

            if (!this.githubOAuthConfigured) {
              this.initGitHub();
              return;
            }

            var githubUser = data.github?.user;
            if (githubUser) {
              this.githubUser = githubUser;
              this.initGitHub();
            }
            // else: show connect button (handled by x-show)
          } catch (e) {
            console.error('Failed to check GitHub user:', e);
            this.githubUserLoading = false;
          }
        },

        async disconnectGitHub() {
          if (!confirm('Disconnect your GitHub account?')) return;

          try {
            var resp = await fetch('/api/v1/oauth/github/logout?token=' + encodeURIComponent(this.token), {
              method: 'POST'
            });

            if (resp.ok) {
              this.githubUser = null;
              this.gitLoading = false;
              this.showInstallPrompt = false;
              this.showRepoSelection = false;
              this.successMsg = 'GitHub disconnected';
            }
          } catch (e) {
            console.error('Failed to disconnect GitHub:', e);
          }
        },

        async initGitHub() {
          this.gitLoading = true;

          try {
            var resp = await fetch(this.apiUrl('/config'));
            var data = await resp.json();

            if (!data.github?.configured) {
              this.gitLoading = false;
              return;
            }

            this.githubInstallations = data.github?.installations || [];

            if (this.githubInstallations.length === 0) {
              this.gitLoading = false;
              this.showInstallPrompt = true;
              return;
            }

            // Check if there's a saved repo URL and try to pre-select
            var savedRepoUrl = this.repoUrlValue;
            if (savedRepoUrl) {
              await this.preselectFromRepoUrl(savedRepoUrl);
            }

            this.gitLoading = false;
            this.showRepoSelection = true;

          } catch (e) {
            console.error('Failed to init GitHub:', e);
            this.gitLoading = false;
          }
        },

        async preselectFromRepoUrl(repoUrl) {
          var match = repoUrl.match(/github\\.com\\/([^\\/]+)\\/([^\\/]+)/);
          if (!match) return;

          var owner = match[1];
          var repo = match[2];
          var savedBranch = ${JSON.stringify(s.gitConfig?.branch || "")};

          var installation = this.githubInstallations.find(function(i) {
            return i.account.toLowerCase() === owner.toLowerCase();
          });
          if (!installation) return;

          this.selectedOrg = installation.id;
          await this.onOrgChange(installation.id);

          // Select the repo
          var foundRepo = this.repoOptions.find(function(r) {
            return r.fullName.toLowerCase() === (owner + '/' + repo).toLowerCase();
          });
          if (foundRepo) {
            this.selectedRepo = foundRepo.name;
            await this.fetchBranches(foundRepo.owner, foundRepo.name, foundRepo.defaultBranch);
          }

          if (savedBranch) {
            this.selectedBranch = savedBranch;
          }
        },

        async onOrgChange(installationId) {
          this.selectedRepo = '';
          this.selectedBranch = '';
          this.repoOptions = [];
          this.branchOptions = [];
          this.repoUrlValue = '';

          if (!installationId) {
            this.selectedOrg = '';
            return;
          }

          this.selectedOrg = installationId;
          this.currentInstallationId = installationId;

          try {
            var resp = await fetch('/api/v1/github/repos?token=' + encodeURIComponent(this.token) + '&installation_id=' + installationId);
            var data = await resp.json();

            this.githubRepos[installationId] = data.repos || [];
            this.repoOptions = data.repos || [];
          } catch (e) {
            console.error('Failed to fetch repos:', e);
            this.repoOptions = [];
          }
        },

        async onRepoChange(target) {
          var repoName = target.value;
          this.branchOptions = [];
          this.selectedBranch = '';

          if (!repoName) {
            this.selectedRepo = '';
            this.repoUrlValue = '';
            return;
          }

          var selectedOpt = target.selectedOptions?.[0];
          var owner = selectedOpt?.dataset?.owner || '';
          var fullName = selectedOpt?.dataset?.fullName || '';
          var defaultBranch = selectedOpt?.dataset?.defaultBranch || 'main';

          this.selectedRepo = repoName;
          this.repoUrlValue = 'https://github.com/' + fullName;

          await this.fetchBranches(owner, repoName, defaultBranch);
        },

        async fetchBranches(owner, repoName, defaultBranch) {
          try {
            var resp = await fetch('/api/v1/github/branches?token=' + encodeURIComponent(this.token) + '&owner=' + owner + '&repo=' + repoName + '&installation_id=' + this.currentInstallationId);
            var data = await resp.json();

            this.branchOptions = (data.branches || []).map(function(b) {
              return {
                name: b.name,
                protected: b.protected,
                isDefault: b.name === defaultBranch
              };
            });
            this.selectedBranch = defaultBranch;
          } catch (e) {
            console.error('Failed to fetch branches:', e);
            this.branchOptions = [];
          }
        },

        onBranchChange(value) {
          this.selectedBranch = value;
        },

        async refreshGitHub() {
          this.gitLoading = true;
          this.showInstallPrompt = false;
          this.showRepoSelection = false;
          await this.initGitHub();
        },

        // === Skills ===
        async initSkills() {
          try {
            var resp = await fetch('/api/v1/skills/registry?token=' + encodeURIComponent(this.token));
            var data = await resp.json();
            this.curatedSkills = data.skills || [];
          } catch (e) {
            console.error('Failed to load curated skills:', e);
          }
        },

        async searchSkills() {
          if (!this.skillSearch.trim()) {
            this.skillSearchVisible = false;
            this.skillSearchResults = [];
            return;
          }

          this.skillSearchVisible = true;
          this.skillSearchResults = [];

          try {
            var resp = await fetch('/api/v1/skills/registry?token=' + encodeURIComponent(this.token) + '&q=' + encodeURIComponent(this.skillSearch));
            var data = await resp.json();
            this.skillSearchResults = data.skills || [];
          } catch (e) {
            this.skillSearchResults = [];
          }
        },

        async addSkillFromChip(repo) {
          if (this.skills.some(function(s) { return s.repo === repo; })) return;
          await this.addSkill(repo);
        },

        async addSkillFromSearch(repo) {
          if (this.skills.some(function(s) { return s.repo === repo; })) return;
          await this.addSkill(repo);
          this.skillSearch = '';
          this.skillSearchVisible = false;
        },

        async addSkill(repo) {
          if (!repo) return;
          this.skillsLoading = true;
          this.skillsError = '';

          try {
            var fetchResp = await fetch('/api/v1/skills/fetch?token=' + encodeURIComponent(this.token), {
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
              this.customSkillRepo = '';
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

        // === Soul Search ===
        async searchSouls() {
          this.soulSearchLoading = true;
          this.soulSearchVisible = true;
          this.soulSearchResults = [];

          try {
            var url = this.soulSearch.trim()
              ? 'https://wry-manatee-359.convex.site/api/v1/search?q=' + encodeURIComponent(this.soulSearch) + '&limit=8'
              : 'https://wry-manatee-359.convex.site/api/v1/souls?limit=8';
            var resp = await fetch(url);
            var data = await resp.json();

            this.soulSearchResults = this.soulSearch.trim() ? (data.results || []) : (data.items || []);
          } catch (e) {
            this.soulSearchResults = [];
          } finally {
            this.soulSearchLoading = false;
          }
        },

        async loadSoul(slug) {
          var textarea = document.getElementById('soulMd');
          this.soulSearchVisible = false;
          this.soulSearch = 'Loading ' + slug + '...';
          this.soulSearchLoading = true;

          try {
            var resp = await fetch('https://wry-manatee-359.convex.site/api/v1/souls/' + encodeURIComponent(slug) + '/file?path=SOUL.md');
            if (!resp.ok) throw new Error('Failed to fetch soul');
            var content = await resp.text();
            textarea.value = content;
            textarea.style.minHeight = '200px';
            this.soulSearch = '';
          } catch (e) {
            this.soulSearch = '';
            this.errorMsg = 'Failed to load soul: ' + slug;
            setTimeout(function() { this.errorMsg = ''; }.bind(this), 3000);
          } finally {
            this.soulSearchLoading = false;
          }
        },

        // === MCPs ===
        async initMcps() {
          try {
            var resp = await fetch('/api/v1/mcps/registry?token=' + encodeURIComponent(this.token));
            var data = await resp.json();
            this.curatedMcps = data.mcps || [];
          } catch (e) {
            console.error('Failed to load curated MCPs:', e);
          }
        },

        async searchMcps() {
          if (!this.mcpSearch.trim()) {
            this.mcpSearchVisible = false;
            this.mcpSearchResults = [];
            return;
          }

          this.mcpSearchVisible = true;
          this.mcpSearchResults = [];

          try {
            var resp = await fetch('/api/v1/mcps/registry?token=' + encodeURIComponent(this.token) + '&q=' + encodeURIComponent(this.mcpSearch));
            var data = await resp.json();
            this.mcpSearchResults = data.mcps || [];
          } catch (e) {
            this.mcpSearchResults = [];
          }
        },

        async addMcpFromChip(mcpId) {
          if (this.mcpServers.hasOwnProperty(mcpId)) return;
          await this.addMcp(mcpId, null);
        },

        async addMcpFromSearch(mcpId) {
          if (this.mcpServers.hasOwnProperty(mcpId)) return;
          await this.addMcp(mcpId, null);
          this.mcpSearch = '';
          this.mcpSearchVisible = false;
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
              this.customMcpId = '';
              this.customMcpUrl = '';
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
            var fetchResp = await fetch('/api/v1/skills/fetch?token=' + encodeURIComponent(this.token), {
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
              var envVarsTextarea = document.getElementById('envVars');
              var currentText = envVarsTextarea.value;

              var newText = currentText;
              for (var i = 0; i < mcp.envVars.length; i++) {
                var envVar = mcp.envVars[i];
                if (!currentEnvVars[envVar] && currentText.indexOf(envVar + '=') === -1) {
                  newText = newText.trim() + (newText.trim() ? '\\n' : '') + envVar + '=';
                }
              }
              envVarsTextarea.value = newText;
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
                msg += ' Please fill in the required environment variables below.';
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
        }
      };
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
