/**
 * Settings Page HTML Templates (Tailwind CSS)
 */

import type { AgentSettings } from "../../auth/settings";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import { platformRegistry } from "../../platform";

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
  // If it looks like a phone number (starts with +), show as-is
  if (userId.startsWith("+")) {
    return userId;
  }
  // If it's a JID-style format (contains @), show a friendlier format
  if (userId.includes("@")) {
    const parts = userId.split("@");
    const id = parts[0] || "";
    const domain = parts[1] || "";
    // Handle linked IDs (very long internal IDs)
    if (domain === "lid") {
      return `ID: ${id.slice(0, 8)}...`;
    }
    // Handle phone number JIDs
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
  // Try to get display info from the platform adapter
  const adapter = platformRegistry.get(platform);
  if (adapter?.getDisplayInfo) {
    const info = adapter.getDisplayInfo();
    // Wrap the icon SVG with proper sizing class
    const icon = info.icon.includes('class="')
      ? info.icon.replace('class="', 'class="w-4 h-4 inline-block ')
      : info.icon.replace("<svg", '<svg class="w-4 h-4 inline-block"');
    return { icon, name: info.name };
  }

  // Fallback for unknown platforms
  return {
    icon: '<svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>',
    name: platform || "API",
  };
}

export interface GitHubOptions {
  githubAppConfigured: boolean;
  githubAppInstallUrl?: string;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Settings - Peerbot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-amber-700 to-amber-900 p-4">
  <div class="max-w-xl mx-auto bg-white rounded-2xl shadow-2xl p-6">
    <div class="text-center mb-5">
      <div class="text-4xl mb-1">🦉</div>
      <h1 class="text-xl font-bold text-amber-900">Agent Settings</h1>
      <p class="text-xs text-gray-500">${getPlatformDisplay(payload.platform).icon} ${escapeHtml(formatUserId(payload.userId))}</p>
    </div>

    <div id="success-msg" class="hidden bg-green-100 text-green-800 px-3 py-2 rounded-lg mb-4 text-center text-sm">
      Settings saved!
    </div>
    <div id="error-msg" class="hidden bg-red-100 text-red-800 px-3 py-2 rounded-lg mb-4 text-center text-sm"></div>

    <!-- Providers Section (outside form) -->
    <div class="bg-gray-50 rounded-lg p-4 mb-4">
      <div class="flex items-center justify-between" id="provider-claude">
        <div class="flex items-center gap-3">
          <img src="https://www.anthropic.com/favicon.ico" alt="Claude" class="w-5 h-5 rounded">
          <div>
            <p class="text-sm font-medium text-gray-800">Claude</p>
            <p class="text-xs text-gray-500" id="claude-status">Checking...</p>
          </div>
        </div>
        <button type="button" id="claude-auth-btn" class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all bg-amber-100 text-amber-800 hover:bg-amber-200">
          Connect
        </button>
      </div>
      <!-- Code input (hidden by default) -->
      <div id="claude-code-input" class="hidden mt-3 pt-3 border-t border-gray-200">
        <p class="text-xs text-gray-600 mb-2">Paste the authentication code from Claude:</p>
        <div class="flex gap-2">
          <input type="text" id="claude-auth-code" placeholder="CODE#STATE" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">
          <button type="button" id="claude-submit-code" class="px-3 py-2 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-all">
            Submit
          </button>
        </div>
        <p class="text-xs text-gray-400 mt-1">Format: CODE#STATE (copy the entire code shown after login)</p>
      </div>
    </div>

    <form id="settings-form" class="space-y-3">
      <!-- Model Selection -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" onclick="toggleSection(this)">
          <span>&#129302;</span>
          Model
          <span class="ml-auto text-xs text-gray-400 transition-transform rotate-[-90deg]" id="model-arrow">&#9660;</span>
        </h3>
        <div id="model-content" class="hidden pt-3">
          <select id="model" name="model" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">
            <option value="">Default</option>
            <option value="claude-sonnet-4" ${s.model === "claude-sonnet-4" ? "selected" : ""}>Claude Sonnet 4</option>
            <option value="claude-sonnet-4-5" ${s.model === "claude-sonnet-4-5" ? "selected" : ""}>Claude Sonnet 4.5</option>
            <option value="claude-opus-4" ${s.model === "claude-opus-4" ? "selected" : ""}>Claude Opus 4</option>
            <option value="claude-haiku-4" ${s.model === "claude-haiku-4" ? "selected" : ""}>Claude Haiku 4</option>
            <option value="claude-haiku-4-5" ${s.model === "claude-haiku-4-5" ? "selected" : ""}>Claude Haiku 4.5</option>
          </select>
        </div>
      </div>

      <!-- Skills Section -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" onclick="toggleSection(this)">
          <span>&#128736;</span>
          Skills
          <span id="skills-loading" class="hidden animate-spin text-amber-600">&#8635;</span>
          <span class="ml-auto text-xs text-gray-400 transition-transform rotate-[-90deg]" id="skills-arrow">&#9660;</span>
        </h3>
        <div id="skills-content" class="hidden pt-3 space-y-3">
          <!-- Skills Error -->
          <div id="skills-error" class="hidden bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs"></div>

          <!-- Enabled Skills List -->
          <div id="skills-list" class="space-y-2">
            <p class="text-xs text-gray-500">No skills configured yet.</p>
          </div>

          <!-- Add Skill Section -->
          <div class="border-t border-gray-200 pt-3">
            <p class="text-xs font-medium text-gray-600 mb-2">Add Skills</p>

            <!-- Search Input -->
            <div class="relative mb-2">
              <input type="text" id="skillSearchInput" placeholder="Search skills from skills.sh..." class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">
              <div id="skillSearchResults" class="hidden absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <!-- Search results will be populated here -->
              </div>
            </div>

            <!-- Quick Add: Curated Skills -->
            <div class="mb-2">
              <p class="text-xs text-gray-500 mb-1">Quick add popular skills:</p>
              <div id="curatedSkillsChips" class="flex flex-wrap gap-1">
                <!-- Curated skill chips will be populated here -->
              </div>
            </div>

            <!-- Manual Entry -->
            <div class="flex gap-2">
              <input type="text" id="customSkillRepo" placeholder="Or enter repo: owner/repo" class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">
              <button type="button" id="addCustomSkillBtn" class="px-3 py-2 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition-all">
                Add
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">Skills from <a href="https://skills.sh" target="_blank" class="text-amber-600 hover:underline">skills.sh</a> extend Claude's capabilities.</p>
          </div>
        </div>
      </div>

      <!-- Network Configuration -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" onclick="toggleSection(this)">
          <span>&#127760;</span>
          Network Access
          <span class="ml-auto text-xs text-gray-400 transition-transform rotate-[-90deg]" id="network-arrow">&#9660;</span>
        </h3>
        <div id="network-content" class="hidden pt-3 space-y-3">
          <div>
            <label for="allowedDomains" class="block text-xs font-medium text-gray-600 mb-1">Allowed Domains</label>
            <textarea id="allowedDomains" name="allowedDomains" placeholder="github.com&#10;*.trusted.com" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">${escapeHtml((s.networkConfig?.allowedDomains || []).join("\n"))}</textarea>
          </div>
          <div>
            <label for="deniedDomains" class="block text-xs font-medium text-gray-600 mb-1">Denied Domains</label>
            <textarea id="deniedDomains" name="deniedDomains" placeholder="malicious.com" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">${escapeHtml((s.networkConfig?.deniedDomains || []).join("\n"))}</textarea>
          </div>
        </div>
      </div>

      <!-- Git Configuration (only shown when GitHub App is configured) -->
      ${
        githubAppConfigured
          ? `
      <div class="bg-gray-50 rounded-lg p-3" id="git-section">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" onclick="toggleSection(this)">
          <span>&#128230;</span>
          Git Repository
          <span class="ml-auto text-xs text-gray-400 transition-transform rotate-[-90deg]" id="git-arrow">&#9660;</span>
        </h3>
        <div id="git-content" class="hidden pt-3 space-y-2">
          <!-- GitHub User Connection (required to see repos) -->
          <div id="github-user-section" class="mb-3 pb-3 border-b border-gray-200">
            <div id="github-user-loading" class="text-center py-2">
              <p class="text-xs text-gray-500">Checking GitHub connection...</p>
            </div>
            <div id="github-user-connect" class="hidden text-center py-2">
              <p class="text-xs text-gray-600 mb-2">Connect your GitHub account to see your repositories</p>
              <a id="github-connect-btn" href="#" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-all">
                <svg class="w-4 h-4 inline-block mr-1" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/></svg>
                Connect with GitHub
              </a>
            </div>
            <div id="github-user-connected" class="hidden flex items-center justify-between">
              <div class="flex items-center gap-2">
                <img id="github-user-avatar" src="" alt="" class="w-6 h-6 rounded-full">
                <div>
                  <p class="text-xs font-medium text-gray-800" id="github-user-login"></p>
                  <p class="text-xs text-green-600">Connected</p>
                </div>
              </div>
              <button type="button" onclick="disconnectGitHub()" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-100 text-red-700 hover:bg-red-200 transition-all">
                Disconnect
              </button>
            </div>
            <div id="github-oauth-unavailable" class="hidden text-center py-2">
              <p class="text-xs text-gray-400">GitHub authentication not configured</p>
            </div>
          </div>

          <!-- Loading state -->
          <div id="git-loading" class="hidden text-center py-4">
            <p class="text-xs text-gray-500">Loading GitHub installations...</p>
          </div>

          <!-- Install prompt (shown when no installations) -->
          <div id="git-install-prompt" class="hidden text-center py-4 border-2 border-dashed border-gray-200 rounded-lg">
            <p class="text-xs text-gray-600 mb-2">Install the GitHub App to enable repository access</p>
            <div class="flex items-center justify-center gap-2">
              ${
                githubAppInstallUrl
                  ? `<a href="${escapeHtml(githubAppInstallUrl)}" target="_blank" class="inline-block px-4 py-2 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-all">
                Install on GitHub &rarr;
              </a>`
                  : `<p class="text-xs text-gray-400">Contact administrator to install the GitHub App</p>`
              }
              <button type="button" onclick="refreshGitHub()" class="px-4 py-2 text-xs font-medium rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-all">
                &#8635; Refresh
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-2">After installing, click Refresh to see your repositories</p>
          </div>

          <!-- Repo selection (shown when installations exist) -->
          <div id="git-repo-selection" class="hidden space-y-2">
            <div>
              <label for="gitOrg" class="block text-xs font-medium text-gray-600 mb-1">Organization / User</label>
              <select id="gitOrg" name="gitOrg" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">
                <option value="">Select...</option>
              </select>
            </div>
            <div>
              <label for="gitRepo" class="block text-xs font-medium text-gray-600 mb-1">Repository</label>
              <select id="gitRepo" name="gitRepo" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none" disabled>
                <option value="">Select organization first...</option>
              </select>
            </div>
            <div>
              <label for="gitBranch" class="block text-xs font-medium text-gray-600 mb-1">Branch</label>
              <select id="gitBranch" name="gitBranch" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none" disabled>
                <option value="">Select repository first...</option>
              </select>
            </div>
            <div>
              <label for="sparse" class="block text-xs font-medium text-gray-600 mb-1">Sparse Checkout (optional)</label>
              <textarea id="sparse" name="sparse" placeholder="src/&#10;docs/" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[50px] resize-y focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">${escapeHtml((s.gitConfig?.sparse || []).join("\n"))}</textarea>
              <p class="text-xs text-gray-400 mt-1">Only checkout specific directories (one per line)</p>
            </div>
          </div>

          <!-- Hidden fields for form submission -->
          <input type="hidden" id="repoUrl" name="repoUrl" value="${escapeHtml(s.gitConfig?.repoUrl || "")}">
          <input type="hidden" id="branch" name="branch" value="${escapeHtml(s.gitConfig?.branch || "")}">
          <input type="hidden" id="selectedInstallationId" name="selectedInstallationId" value="">
        </div>
      </div>
      `
          : `<!-- Git section hidden - GitHub App not configured -->`
      }

      <!-- Environment Variables -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" onclick="toggleSection(this)">
          <span>&#128203;</span>
          Environment Variables
          <span class="ml-auto text-xs text-gray-400 transition-transform rotate-[-90deg]" id="envvars-arrow">&#9660;</span>
        </h3>
        <div id="envvars-content" class="hidden pt-3">
          <textarea id="envVars" name="envVars" placeholder="API_KEY=your_key&#10;DEBUG=true" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono min-h-[60px] resize-y focus:border-amber-600 focus:ring-1 focus:ring-amber-200 outline-none">${escapeHtml(
            Object.entries(s.envVars || {})
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")
          )}</textarea>
        </div>
      </div>

      <!-- Scheduled Reminders Section (outside form - read-only display) -->
      <div class="bg-gray-50 rounded-lg p-3">
        <h3 class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none" onclick="toggleSection(this)">
          <span>&#9200;</span>
          Scheduled Reminders
          <span id="schedules-loading" class="hidden animate-spin text-amber-600">&#8635;</span>
          <span class="ml-auto text-xs text-gray-400 transition-transform rotate-[-90deg]" id="schedules-arrow">&#9660;</span>
        </h3>
        <div id="schedules-content" class="hidden pt-3">
          <div id="schedules-error" class="hidden bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs mb-2"></div>
          <div id="schedules-list">
            <p class="text-xs text-gray-500">Loading scheduled reminders...</p>
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

      <!-- History Configuration -->
      <div class="bg-gray-50 rounded-lg p-3">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="historyEnabled" name="historyEnabled" ${s.historyConfig?.enabled ? "checked" : ""} class="w-4 h-4 text-amber-600 rounded focus:ring-amber-500">
          <span class="text-sm font-medium text-gray-800">Include conversation history</span>
        </label>
      </div>

      <button type="submit" id="save-btn" class="w-full py-3 bg-gradient-to-r from-amber-700 to-amber-800 text-white text-sm font-semibold rounded-lg hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none">
        Save Settings
      </button>
    </form>
  </div>

  <script>
    const token = ${JSON.stringify(token)};

    function toggleSection(header) {
      const sectionId = header.querySelector('[id$="-arrow"]').id.replace('-arrow', '-content');
      const content = document.getElementById(sectionId);
      const arrow = header.querySelector('[id$="-arrow"]');

      if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        arrow.classList.remove('rotate-[-90deg]');
      } else {
        content.classList.add('hidden');
        arrow.classList.add('rotate-[-90deg]');
      }
    }

    function parseLines(text) {
      return text.split('\\n').map(l => l.trim()).filter(l => l);
    }

    // Prevent Enter key from submitting form (only submit via button click)
    document.getElementById('settings-form').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
        e.preventDefault();
      }
    });

    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const btn = document.getElementById('save-btn');
      const successMsg = document.getElementById('success-msg');
      const errorMsg = document.getElementById('error-msg');

      btn.disabled = true;
      btn.textContent = 'Saving...';
      successMsg.classList.add('hidden');
      errorMsg.classList.add('hidden');

      const settings = {};

      // Model
      const model = document.getElementById('model').value;
      if (model) settings.model = model;

      // Network config
      const allowedDomains = parseLines(document.getElementById('allowedDomains').value);
      const deniedDomains = parseLines(document.getElementById('deniedDomains').value);
      if (allowedDomains.length || deniedDomains.length) {
        settings.networkConfig = {};
        if (allowedDomains.length) settings.networkConfig.allowedDomains = allowedDomains;
        if (deniedDomains.length) settings.networkConfig.deniedDomains = deniedDomains;
      }

      // Git config
      const repoUrl = document.getElementById('repoUrl').value.trim();
      const branch = document.getElementById('branch').value.trim();
      const sparse = parseLines(document.getElementById('sparse').value);
      if (repoUrl || branch || sparse.length) {
        settings.gitConfig = {};
        if (repoUrl) settings.gitConfig.repoUrl = repoUrl;
        if (branch) settings.gitConfig.branch = branch;
        if (sparse.length) settings.gitConfig.sparse = sparse;
      }

      // Environment variables
      const envVarsText = document.getElementById('envVars').value;
      const envVarsLines = parseLines(envVarsText);
      if (envVarsLines.length) {
        settings.envVars = {};
        for (const line of envVarsLines) {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            const key = line.slice(0, eqIdx).trim();
            const value = line.slice(eqIdx + 1);
            if (key) settings.envVars[key] = value;
          }
        }
      }

      // History config
      const historyEnabled = document.getElementById('historyEnabled').checked;
      settings.historyConfig = { enabled: historyEnabled };

      try {
        const response = await fetch('/api/settings?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });

        const result = await response.json();

        if (response.ok) {
          successMsg.classList.remove('hidden');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          throw new Error(result.error || 'Failed to save settings');
        }
      } catch (error) {
        errorMsg.textContent = error.message;
        errorMsg.classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
      }
    });

    // Provider handling
    const PROVIDERS = {
      claude: { name: 'Claude' }
    };

    async function checkProviders() {
      try {
        const resp = await fetch('/api/settings/providers?token=' + encodeURIComponent(token));
        const data = await resp.json();
        for (const [provider, info] of Object.entries(data.providers || {})) {
          updateProviderStatus(provider, info.connected);
        }
      } catch (e) {
        document.getElementById('claude-status').textContent = 'Error checking status';
      }
    }

    function updateProviderStatus(provider, connected) {
      const status = document.getElementById(provider + '-status');
      const btn = document.getElementById(provider + '-auth-btn');
      if (!status || !btn) return;

      if (connected) {
        status.textContent = 'Connected';
        status.className = 'text-xs text-emerald-600';
        btn.textContent = 'Disconnect';
        btn.className = 'px-3 py-1.5 text-xs font-medium rounded-lg bg-red-100 text-red-700 hover:bg-red-200 transition-all';
        btn.onclick = () => disconnectProvider(provider);
      } else {
        status.textContent = 'Not connected';
        status.className = 'text-xs text-gray-500';
        btn.textContent = 'Connect';
        btn.className = 'px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-all';
        btn.onclick = () => connectProvider(provider);
      }
    }

    function connectProvider(provider) {
      // Open OAuth in new tab so user can complete auth flow
      window.open('/api/settings/providers/' + provider + '/login?token=' + encodeURIComponent(token), '_blank');

      // Show the code input section
      const codeInput = document.getElementById(provider + '-code-input');
      if (codeInput) {
        codeInput.classList.remove('hidden');
      }

      // Update status
      const status = document.getElementById(provider + '-status');
      if (status) {
        status.textContent = 'Waiting for code...';
        status.className = 'text-xs text-amber-600';
      }

      // Setup submit handler
      const submitBtn = document.getElementById(provider + '-submit-code');
      const codeField = document.getElementById(provider + '-auth-code');

      if (submitBtn && codeField) {
        submitBtn.onclick = async () => {
          const code = codeField.value.trim();
          if (!code) {
            alert('Please enter the authentication code');
            return;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = 'Verifying...';

          try {
            const resp = await fetch('/api/settings/providers/' + provider + '/code?token=' + encodeURIComponent(token), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code })
            });

            const result = await resp.json();

            if (resp.ok) {
              codeInput.classList.add('hidden');
              codeField.value = '';
              updateProviderStatus(provider, true);
              document.getElementById('success-msg').textContent = 'Connected to Claude!';
              document.getElementById('success-msg').classList.remove('hidden');
            } else {
              throw new Error(result.error || 'Failed to verify code');
            }
          } catch (e) {
            alert('Error: ' + e.message);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit';
          }
        };
      }
    }

    async function disconnectProvider(provider) {
      const name = PROVIDERS[provider]?.name || provider;
      if (!confirm('Disconnect from ' + name + '? You will need to reconnect to use this provider.')) return;
      await fetch('/api/settings/providers/' + provider + '/logout?token=' + encodeURIComponent(token), { method: 'POST' });
      checkProviders();
    }

    // Check providers on page load
    checkProviders();

    // ============================================================================
    // GitHub App Integration
    // ============================================================================
    const githubAppConfigured = ${githubAppConfigured};

    // Store for GitHub data
    let githubInstallations = [];
    let githubRepos = {};
    let currentInstallationId = null;
    let currentRepoFullName = null;
    let connectedGitHubUser = null;

    // Check for github_connected query param (after OAuth redirect)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('github_connected') === 'true') {
      document.getElementById('success-msg').textContent = 'GitHub account connected!';
      document.getElementById('success-msg').classList.remove('hidden');
      // Clean up URL
      const newUrl = window.location.pathname + '?token=' + encodeURIComponent(token);
      window.history.replaceState({}, '', newUrl);
    }

    async function initGitHubUser() {
      if (!githubAppConfigured) return;

      const loadingEl = document.getElementById('github-user-loading');
      const connectEl = document.getElementById('github-user-connect');
      const connectedEl = document.getElementById('github-user-connected');
      const unavailableEl = document.getElementById('github-oauth-unavailable');

      try {
        const resp = await fetch('/api/settings/github/user?token=' + encodeURIComponent(token));
        const data = await resp.json();

        loadingEl?.classList.add('hidden');

        if (!data.oauthConfigured) {
          // GitHub OAuth not set up - show unavailable message but still allow app install
          unavailableEl?.classList.remove('hidden');
          initGitHub();
          return;
        }

        if (data.connected && data.user) {
          connectedGitHubUser = data.user;
          document.getElementById('github-user-avatar').src = data.user.avatarUrl;
          document.getElementById('github-user-login').textContent = data.user.login;
          connectedEl?.classList.remove('hidden');
          // Now load GitHub repos
          initGitHub();
        } else {
          // Show connect button
          const connectBtn = document.getElementById('github-connect-btn');
          connectBtn.href = '/api/settings/github/oauth/login?token=' + encodeURIComponent(token);
          connectEl?.classList.remove('hidden');
        }
      } catch (e) {
        console.error('Failed to check GitHub user:', e);
        loadingEl?.classList.add('hidden');
        unavailableEl?.classList.remove('hidden');
      }
    }

    async function disconnectGitHub() {
      if (!confirm('Disconnect your GitHub account?')) return;

      try {
        const resp = await fetch('/api/settings/github/oauth/logout?token=' + encodeURIComponent(token), {
          method: 'POST'
        });

        if (resp.ok) {
          connectedGitHubUser = null;
          // Reset UI
          document.getElementById('github-user-connected')?.classList.add('hidden');
          document.getElementById('github-user-connect')?.classList.remove('hidden');
          document.getElementById('git-loading')?.classList.add('hidden');
          document.getElementById('git-install-prompt')?.classList.add('hidden');
          document.getElementById('git-repo-selection')?.classList.add('hidden');
          document.getElementById('success-msg').textContent = 'GitHub disconnected';
          document.getElementById('success-msg').classList.remove('hidden');
        }
      } catch (e) {
        console.error('Failed to disconnect GitHub:', e);
      }
    }

    async function initGitHub() {
      if (!githubAppConfigured) return;

      const loading = document.getElementById('git-loading');
      const installPrompt = document.getElementById('git-install-prompt');
      const repoSelection = document.getElementById('git-repo-selection');

      // Show loading
      loading?.classList.remove('hidden');

      try {
        const resp = await fetch('/api/settings/github/status?token=' + encodeURIComponent(token));
        const data = await resp.json();

        if (!data.configured) {
          loading?.classList.add('hidden');
          return;
        }

        githubInstallations = data.installations || [];

        if (githubInstallations.length === 0) {
          loading?.classList.add('hidden');
          installPrompt?.classList.remove('hidden');
          return;
        }

        // Populate org dropdown
        const orgSelect = document.getElementById('gitOrg');
        orgSelect.innerHTML = '<option value="">Select...</option>';
        for (const inst of githubInstallations) {
          const opt = document.createElement('option');
          opt.value = inst.id;
          opt.textContent = inst.account + (inst.accountType === 'Organization' ? ' (org)' : '');
          orgSelect.appendChild(opt);
        }

        // Check if there's a saved repo URL and try to pre-select
        const savedRepoUrl = document.getElementById('repoUrl').value;
        if (savedRepoUrl) {
          await preselectFromRepoUrl(savedRepoUrl);
        }

        loading?.classList.add('hidden');
        repoSelection?.classList.remove('hidden');

        // Setup change handlers
        orgSelect.addEventListener('change', onOrgChange);
        document.getElementById('gitRepo').addEventListener('change', onRepoChange);
        document.getElementById('gitBranch').addEventListener('change', onBranchChange);

      } catch (e) {
        console.error('Failed to init GitHub:', e);
        loading?.classList.add('hidden');
      }
    }

    async function preselectFromRepoUrl(repoUrl) {
      // Parse owner from URL (https://github.com/owner/repo)
      const match = repoUrl.match(/github\\.com\\/([^\\/]+)\\/([^\\/]+)/);
      if (!match) return;

      const [, owner, repo] = match;
      const savedBranch = document.getElementById('branch').value;

      // Find matching installation
      const installation = githubInstallations.find(i => i.account.toLowerCase() === owner.toLowerCase());
      if (!installation) return;

      // Select the org
      document.getElementById('gitOrg').value = installation.id;
      await onOrgChange({ target: { value: installation.id } });

      // Select the repo
      const repoSelect = document.getElementById('gitRepo');
      for (const opt of repoSelect.options) {
        if (opt.dataset.fullName?.toLowerCase() === (owner + '/' + repo).toLowerCase()) {
          repoSelect.value = opt.value;
          await onRepoChange({ target: { value: opt.value, selectedOptions: [opt] } });
          break;
        }
      }

      // Select the branch
      if (savedBranch) {
        const branchSelect = document.getElementById('gitBranch');
        branchSelect.value = savedBranch;
      }
    }

    async function onOrgChange(e) {
      const installationId = e.target.value;
      const repoSelect = document.getElementById('gitRepo');
      const branchSelect = document.getElementById('gitBranch');

      // Reset repo and branch
      repoSelect.innerHTML = '<option value="">Loading...</option>';
      repoSelect.disabled = true;
      branchSelect.innerHTML = '<option value="">Select repository first...</option>';
      branchSelect.disabled = true;
      document.getElementById('repoUrl').value = '';
      document.getElementById('branch').value = '';

      if (!installationId) {
        repoSelect.innerHTML = '<option value="">Select organization first...</option>';
        return;
      }

      currentInstallationId = installationId;

      try {
        const resp = await fetch('/api/settings/github/repos?token=' + encodeURIComponent(token) + '&installation_id=' + installationId);
        const data = await resp.json();

        githubRepos[installationId] = data.repos || [];

        repoSelect.innerHTML = '<option value="">Select...</option>';
        for (const repo of data.repos) {
          const opt = document.createElement('option');
          opt.value = repo.name;
          opt.textContent = repo.name + (repo.private ? ' 🔒' : '');
          opt.dataset.fullName = repo.fullName;
          opt.dataset.owner = repo.owner;
          opt.dataset.defaultBranch = repo.defaultBranch;
          repoSelect.appendChild(opt);
        }
        repoSelect.disabled = false;
      } catch (e) {
        console.error('Failed to fetch repos:', e);
        repoSelect.innerHTML = '<option value="">Error loading repos</option>';
      }
    }

    async function onRepoChange(e) {
      const repoName = e.target.value;
      const branchSelect = document.getElementById('gitBranch');
      const selectedOpt = e.target.selectedOptions?.[0];

      branchSelect.innerHTML = '<option value="">Loading...</option>';
      branchSelect.disabled = true;

      if (!repoName || !selectedOpt) {
        branchSelect.innerHTML = '<option value="">Select repository first...</option>';
        document.getElementById('repoUrl').value = '';
        document.getElementById('branch').value = '';
        return;
      }

      const owner = selectedOpt.dataset.owner;
      const fullName = selectedOpt.dataset.fullName;
      const defaultBranch = selectedOpt.dataset.defaultBranch;
      currentRepoFullName = fullName;

      // Update hidden repoUrl field
      document.getElementById('repoUrl').value = 'https://github.com/' + fullName;
      document.getElementById('selectedInstallationId').value = currentInstallationId;

      try {
        const resp = await fetch('/api/settings/github/branches?token=' + encodeURIComponent(token) + '&owner=' + owner + '&repo=' + repoName + '&installation_id=' + currentInstallationId);
        const data = await resp.json();

        branchSelect.innerHTML = '';
        for (const branch of data.branches) {
          const opt = document.createElement('option');
          opt.value = branch.name;
          opt.textContent = branch.name + (branch.protected ? ' 🛡️' : '') + (branch.name === defaultBranch ? ' (default)' : '');
          if (branch.name === defaultBranch) {
            opt.selected = true;
          }
          branchSelect.appendChild(opt);
        }
        branchSelect.disabled = false;

        // Set initial branch value
        document.getElementById('branch').value = branchSelect.value || defaultBranch;
      } catch (e) {
        console.error('Failed to fetch branches:', e);
        branchSelect.innerHTML = '<option value="">Error loading branches</option>';
      }
    }

    function onBranchChange(e) {
      document.getElementById('branch').value = e.target.value;
    }

    async function refreshGitHub() {
      const loading = document.getElementById('git-loading');
      const installPrompt = document.getElementById('git-install-prompt');
      const repoSelection = document.getElementById('git-repo-selection');

      // Show loading, hide others
      loading?.classList.remove('hidden');
      installPrompt?.classList.add('hidden');
      repoSelection?.classList.add('hidden');

      // Re-initialize
      await initGitHub();
    }

    // Initialize GitHub on page load (check user first, then load repos)
    if (githubAppConfigured) {
      initGitHubUser();
    }

    // ============================================================================
    // Skills Management
    // ============================================================================

    let currentSkills = ${JSON.stringify(s.skillsConfig?.skills || [])};
    let searchTimeout = null;

    async function initSkills() {
      // Load curated skills as chips
      try {
        const resp = await fetch('/api/settings/skills/curated?token=' + encodeURIComponent(token));
        const data = await resp.json();

        const chipsContainer = document.getElementById('curatedSkillsChips');
        chipsContainer.innerHTML = data.skills.map(function(skill) {
          // Check if already added
          const alreadyAdded = currentSkills.some(function(s) { return s.repo === skill.repo; });
          const disabledClass = alreadyAdded ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-amber-200';
          return '<button type="button" onclick="addSkillFromChip(\\'' + escapeHtmlJS(skill.repo) + '\\')" ' +
            'class="px-2 py-1 text-xs rounded-full bg-amber-100 text-amber-800 ' + disabledClass + '" ' +
            (alreadyAdded ? 'disabled title="Already added"' : 'title="' + escapeHtmlJS(skill.description) + '"') + '>' +
            escapeHtmlJS(skill.name) +
          '</button>';
        }).join('');
      } catch (e) {
        console.error('Failed to load curated skills:', e);
      }

      // Setup search input
      const searchInput = document.getElementById('skillSearchInput');
      searchInput.addEventListener('input', function(e) {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function() {
          searchSkills(e.target.value);
        }, 300);
      });

      searchInput.addEventListener('focus', function() {
        if (searchInput.value.trim()) {
          document.getElementById('skillSearchResults').classList.remove('hidden');
        }
      });

      // Hide search results when clicking outside
      document.addEventListener('click', function(e) {
        if (!e.target.closest('#skillSearchInput') && !e.target.closest('#skillSearchResults')) {
          document.getElementById('skillSearchResults').classList.add('hidden');
        }
      });

      // Render current skills
      renderSkillsList();
    }

    async function searchSkills(query) {
      const resultsContainer = document.getElementById('skillSearchResults');

      if (!query.trim()) {
        resultsContainer.classList.add('hidden');
        return;
      }

      resultsContainer.innerHTML = '<div class="p-2 text-xs text-gray-500">Searching...</div>';
      resultsContainer.classList.remove('hidden');

      try {
        const resp = await fetch('/api/settings/skills/search?token=' + encodeURIComponent(token) + '&q=' + encodeURIComponent(query));
        const data = await resp.json();

        if (data.skills.length === 0) {
          resultsContainer.innerHTML = '<div class="p-2 text-xs text-gray-500">No skills found</div>';
          return;
        }

        resultsContainer.innerHTML = data.skills.map(function(skill) {
          const alreadyAdded = currentSkills.some(function(s) { return s.repo === skill.id; });
          return '<div class="p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0" ' +
            'onclick="addSkillFromSearch(\\'' + escapeHtmlJS(skill.id) + '\\')">' +
            '<div class="flex items-center justify-between">' +
              '<div class="flex-1 min-w-0">' +
                '<p class="text-xs font-medium text-gray-800 truncate">' + escapeHtmlJS(skill.name) + '</p>' +
                '<p class="text-xs text-gray-500 truncate">' + escapeHtmlJS(skill.id) + '</p>' +
              '</div>' +
              '<div class="flex items-center gap-2 ml-2">' +
                '<span class="text-xs text-gray-400">' + formatInstalls(skill.installs) + '</span>' +
                (alreadyAdded ? '<span class="text-xs text-green-600">Added</span>' : '<span class="text-xs text-amber-600">+ Add</span>') +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      } catch (e) {
        resultsContainer.innerHTML = '<div class="p-2 text-xs text-red-500">Search failed</div>';
      }
    }

    function formatInstalls(num) {
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
      return num.toString();
    }

    async function addSkillFromChip(repo) {
      if (currentSkills.some(function(s) { return s.repo === repo; })) return;
      await addSkill(repo);
      initSkills(); // Refresh chips to show disabled state
    }

    async function addSkillFromSearch(repo) {
      if (currentSkills.some(function(s) { return s.repo === repo; })) return;
      await addSkill(repo);
      document.getElementById('skillSearchInput').value = '';
      document.getElementById('skillSearchResults').classList.add('hidden');
      initSkills(); // Refresh chips
    }

    function renderSkillsList() {
      const container = document.getElementById('skills-list');

      if (currentSkills.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-500">No skills configured yet.</p>';
        return;
      }

      container.innerHTML = currentSkills.map(function(skill) {
        const enabledClass = skill.enabled
          ? 'bg-green-100 text-green-800'
          : 'bg-gray-100 text-gray-500';
        const toggleLabel = skill.enabled ? 'Enabled' : 'Disabled';

        return '<div class="flex items-center justify-between p-2 bg-white rounded border border-gray-200">' +
          '<div class="flex-1 min-w-0">' +
            '<p class="text-xs font-medium text-gray-800 truncate">' + escapeHtmlJS(skill.name) + '</p>' +
            '<p class="text-xs text-gray-500 truncate">' + escapeHtmlJS(skill.repo) + '</p>' +
          '</div>' +
          '<div class="flex items-center gap-2 ml-2 flex-shrink-0">' +
            '<button type="button" onclick="toggleSkill(\\'' + escapeHtmlJS(skill.repo) + '\\')" ' +
              'class="px-2 py-1 text-xs rounded ' + enabledClass + '">' + toggleLabel + '</button>' +
            '<button type="button" onclick="removeSkill(\\'' + escapeHtmlJS(skill.repo) + '\\')" ' +
              'class="px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200">Remove</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function escapeHtmlJS(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    async function addSkill(repo) {
      if (!repo) return;

      setSkillsLoading(true);

      try {
        const resp = await fetch('/api/settings/skills/add?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repo })
        });

        const result = await resp.json();

        if (resp.ok) {
          currentSkills.push(result.skill);
          renderSkillsList();
          document.getElementById('customSkillRepo').value = '';
        } else {
          throw new Error(result.error || 'Failed to add skill');
        }
      } catch (e) {
        showSkillsError(e.message);
      } finally {
        setSkillsLoading(false);
      }
    }

    async function toggleSkill(repo) {
      const skill = currentSkills.find(function(s) { return s.repo === repo; });
      if (!skill) return;

      const newEnabled = !skill.enabled;

      try {
        const resp = await fetch('/api/settings/skills/toggle?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repo, enabled: newEnabled })
        });

        if (resp.ok) {
          skill.enabled = newEnabled;
          renderSkillsList();
        } else {
          const result = await resp.json();
          throw new Error(result.error || 'Failed to toggle skill');
        }
      } catch (e) {
        showSkillsError(e.message);
      }
    }

    async function removeSkill(repo) {
      if (!confirm('Remove this skill?')) return;

      try {
        const resp = await fetch('/api/settings/skills/remove?token=' + encodeURIComponent(token), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repo })
        });

        if (resp.ok) {
          currentSkills = currentSkills.filter(function(s) { return s.repo !== repo; });
          renderSkillsList();
        } else {
          const result = await resp.json();
          throw new Error(result.error || 'Failed to remove skill');
        }
      } catch (e) {
        showSkillsError(e.message);
      }
    }

    function setSkillsLoading(loading) {
      const spinner = document.getElementById('skills-loading');
      if (loading) {
        spinner.classList.remove('hidden');
        document.getElementById('skills-error').classList.add('hidden');
      } else {
        spinner.classList.add('hidden');
      }
    }

    function showSkillsError(msg) {
      const el = document.getElementById('skills-error');
      el.textContent = msg;
      el.classList.remove('hidden');
      setTimeout(function() { el.classList.add('hidden'); }, 5000);
    }

    // Event listener for custom skill add button
    document.getElementById('addCustomSkillBtn').addEventListener('click', async function() {
      const repo = document.getElementById('customSkillRepo').value.trim();
      if (repo) {
        await addSkill(repo);
        document.getElementById('customSkillRepo').value = '';
        initSkills(); // Refresh chips
      }
    });

    // Initialize skills on page load
    initSkills();

    // ============================================================================
    // Scheduled Reminders Management
    // ============================================================================

    let currentSchedules = [];

    async function initSchedules() {
      const listContainer = document.getElementById('schedules-list');
      const loadingSpinner = document.getElementById('schedules-loading');

      loadingSpinner.classList.remove('hidden');

      try {
        const resp = await fetch('/api/settings/schedules?token=' + encodeURIComponent(token));
        const data = await resp.json();

        if (!resp.ok) {
          throw new Error(data.error || 'Failed to load schedules');
        }

        currentSchedules = data.schedules || [];
        renderSchedulesList();
      } catch (e) {
        console.error('Failed to load schedules:', e);
        listContainer.innerHTML = '<p class="text-xs text-red-500">Failed to load scheduled reminders.</p>';
      } finally {
        loadingSpinner.classList.add('hidden');
      }
    }

    function renderSchedulesList() {
      const container = document.getElementById('schedules-list');

      if (currentSchedules.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-500">No scheduled reminders.</p>';
        return;
      }

      container.innerHTML = currentSchedules.map(function(schedule) {
        const scheduledFor = new Date(schedule.scheduledFor);
        const now = new Date();
        const minutesRemaining = Math.max(0, Math.round((scheduledFor - now) / (1000 * 60)));

        let timeDisplay;
        if (minutesRemaining === 0) {
          timeDisplay = 'Due now';
        } else if (minutesRemaining < 60) {
          timeDisplay = 'in ' + minutesRemaining + ' min';
        } else {
          const hours = Math.floor(minutesRemaining / 60);
          const mins = minutesRemaining % 60;
          timeDisplay = 'in ' + hours + 'h ' + mins + 'm';
        }

        const statusClass = schedule.status === 'pending'
          ? 'bg-amber-100 text-amber-800'
          : schedule.status === 'triggered'
            ? 'bg-green-100 text-green-800'
            : 'bg-gray-100 text-gray-500';

        // Build recurring info display
        let recurringInfo = '';
        if (schedule.isRecurring && schedule.cron) {
          recurringInfo = '<span class="inline-block px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-800 ml-1" title="Cron: ' + escapeHtmlJS(schedule.cron) + '">' +
            '&#128260; ' + schedule.iteration + '/' + schedule.maxIterations +
          '</span>';
        }

        return '<div class="flex items-start justify-between p-2 bg-white rounded border border-gray-200 mb-2">' +
          '<div class="flex-1 min-w-0">' +
            '<p class="text-xs font-medium text-gray-800 truncate" title="' + escapeHtmlJS(schedule.task) + '">' + escapeHtmlJS(truncateText(schedule.task, 60)) + '</p>' +
            '<p class="text-xs text-gray-500">' +
              '<span class="inline-block px-1.5 py-0.5 rounded text-xs ' + statusClass + '">' + schedule.status + '</span> ' +
              recurringInfo +
              '<span title="' + scheduledFor.toLocaleString() + '" class="ml-1">' + timeDisplay + '</span>' +
              (schedule.isRecurring && schedule.cron ? '<span class="text-gray-400 ml-1">(' + escapeHtmlJS(schedule.cron) + ')</span>' : '') +
            '</p>' +
          '</div>' +
          (schedule.status === 'pending' ?
            '<button type="button" onclick="cancelSchedule(\\'' + escapeHtmlJS(schedule.scheduleId) + '\\')" ' +
              'class="ml-2 px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200 flex-shrink-0">Cancel</button>'
            : '') +
        '</div>';
      }).join('');
    }

    function truncateText(text, maxLength) {
      if (!text) return '';
      if (text.length <= maxLength) return text;
      return text.slice(0, maxLength - 3) + '...';
    }

    async function cancelSchedule(scheduleId) {
      if (!confirm('Cancel this scheduled reminder?')) return;

      const loadingSpinner = document.getElementById('schedules-loading');
      loadingSpinner.classList.remove('hidden');

      try {
        const resp = await fetch('/api/settings/schedules/' + encodeURIComponent(scheduleId) + '?token=' + encodeURIComponent(token), {
          method: 'DELETE'
        });

        const result = await resp.json();

        if (resp.ok) {
          currentSchedules = currentSchedules.filter(function(s) { return s.scheduleId !== scheduleId; });
          renderSchedulesList();
          document.getElementById('success-msg').textContent = 'Reminder cancelled!';
          document.getElementById('success-msg').classList.remove('hidden');
        } else {
          throw new Error(result.error || 'Failed to cancel reminder');
        }
      } catch (e) {
        showSchedulesError(e.message);
      } finally {
        loadingSpinner.classList.add('hidden');
      }
    }

    function showSchedulesError(msg) {
      const el = document.getElementById('schedules-error');
      el.textContent = msg;
      el.classList.remove('hidden');
      setTimeout(function() { el.classList.add('hidden'); }, 5000);
    }

    // Initialize schedules on page load
    initSchedules();
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
  <title>Settings Error - Peerbot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center p-5">
  <div class="bg-white rounded-2xl shadow-2xl p-10 max-w-md w-full text-center">
    <div class="text-6xl mb-5">&#10060;</div>
    <h1 class="text-2xl font-bold text-red-600 mb-4">Settings Error</h1>
    <p class="text-gray-600 mb-5">Unable to load settings page.</p>
    <div class="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
      ${escapeHtml(message)}
    </div>
  </div>
</body>
</html>`;
}
