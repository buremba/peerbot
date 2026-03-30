import { useSignal } from "@preact/signals";
import * as api from "../api";
import { useSettings } from "../app";

const PLATFORM_FAVICON_DOMAINS: Record<string, string> = {
  telegram: "telegram.org",
  slack: "slack.com",
  discord: "discord.com",
  whatsapp: "whatsapp.com",
  teams: "teams.microsoft.com",
};

const PLATFORM_LABELS: Record<string, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
  teams: "Teams",
};

function stripPlatformPrefix(name: string, platform: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith(`${platform} `)) return name.slice(platform.length + 1);
  const label = (PLATFORM_LABELS[platform] || "").toLowerCase();
  if (label && lower.startsWith(`${label} `))
    return name.slice(label.length + 1);
  return name;
}

export function AdminBar() {
  const ctx = useSettings();
  if (!ctx.isAdmin) return null;

  const editingName = useSignal(false);
  const editingDesc = useSignal(false);

  async function saveName() {
    if (ctx.agentName.value === ctx.initialAgentName.value) {
      editingName.value = false;
      return;
    }
    ctx.savingIdentity.value = true;
    try {
      await api.updateAgentIdentity(ctx.agentId, {
        name: ctx.agentName.value,
      });
      ctx.initialAgentName.value = ctx.agentName.value;
    } catch (e: unknown) {
      ctx.errorMsg.value =
        e instanceof Error ? e.message : "Failed to update name";
      ctx.agentName.value = ctx.initialAgentName.value;
    } finally {
      ctx.savingIdentity.value = false;
      editingName.value = false;
    }
  }

  async function saveDesc() {
    if (ctx.agentDescription.value === ctx.initialAgentDescription.value) {
      editingDesc.value = false;
      return;
    }
    ctx.savingIdentity.value = true;
    try {
      await api.updateAgentIdentity(ctx.agentId, {
        description: ctx.agentDescription.value,
      });
      ctx.initialAgentDescription.value = ctx.agentDescription.value;
    } catch (e: unknown) {
      ctx.errorMsg.value =
        e instanceof Error ? e.message : "Failed to update description";
      ctx.agentDescription.value = ctx.initialAgentDescription.value;
    } finally {
      ctx.savingIdentity.value = false;
      editingDesc.value = false;
    }
  }

  return (
    <div class="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between shadow-sm">
      <div class="flex items-center gap-3">
        {ctx.isAdmin && (
          <a
            href={(() => {
              const backUrl = new URLSearchParams(location.search).get("back");
              return backUrl || "/agents";
            })()}
            class="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
            title="Back"
            aria-label="Back"
          >
            <svg
              aria-hidden="true"
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 19l-7-7 7-7"
              />
            </svg>
            <span class="sr-only">Back to agents</span>
          </a>
        )}
        <div class="flex items-center gap-2 min-w-0">
          {ctx.isSandbox &&
          ctx.ownerPlatform &&
          PLATFORM_FAVICON_DOMAINS[ctx.ownerPlatform] ? (
            <img
              src={`https://www.google.com/s2/favicons?domain=${PLATFORM_FAVICON_DOMAINS[ctx.ownerPlatform]}&sz=32`}
              width="16"
              height="16"
              alt={ctx.ownerPlatform}
              class="shrink-0"
            />
          ) : (
            <span class="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
          )}
          <div class="min-w-0">
            {editingName.value ? (
              <input
                type="text"
                value={ctx.agentName.value}
                onInput={(e: any) => {
                  ctx.agentName.value = e.target.value;
                }}
                onBlur={() => saveName()}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveName();
                  }
                  if (e.key === "Escape") {
                    ctx.agentName.value = ctx.initialAgentName.value;
                    editingName.value = false;
                  }
                }}
                maxLength={100}
                class="font-medium text-sm text-gray-700 bg-transparent border-b border-gray-300 focus:border-slate-600 outline-none w-full py-0"
                // biome-ignore lint: autofocus on user action
                autoFocus
              />
            ) : (
              <div class="space-y-0.5">
                <button
                  type="button"
                  class="font-medium text-sm text-gray-700 cursor-pointer hover:text-gray-900 transition-colors truncate block bg-transparent border-0 p-0 text-left"
                  title="Click to edit name"
                  onClick={() => {
                    editingName.value = true;
                  }}
                >
                  {ctx.isSandbox && ctx.ownerPlatform
                    ? stripPlatformPrefix(
                        ctx.agentName.value || "Agent Settings",
                        ctx.ownerPlatform
                      )
                    : ctx.agentName.value || "Agent Settings"}
                </button>
                {ctx.isSandbox && (
                  <p class="text-[10px] uppercase tracking-wide text-slate-500">
                    Sandbox Settings
                    {ctx.templateAgentName
                      ? ` · inherits from ${ctx.templateAgentName}`
                      : ""}
                  </p>
                )}
              </div>
            )}
            {editingDesc.value ? (
              <input
                type="text"
                value={ctx.agentDescription.value}
                onInput={(e: any) => {
                  ctx.agentDescription.value = e.target.value;
                }}
                onBlur={() => saveDesc()}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveDesc();
                  }
                  if (e.key === "Escape") {
                    ctx.agentDescription.value =
                      ctx.initialAgentDescription.value;
                    editingDesc.value = false;
                  }
                }}
                maxLength={200}
                placeholder="Add description..."
                class="text-xs text-gray-400 bg-transparent border-b border-gray-200 focus:border-slate-600 outline-none w-full py-0 mt-0.5"
                // biome-ignore lint: autofocus on user action
                autoFocus
              />
            ) : (
              <button
                type="button"
                class="text-xs text-gray-400 cursor-pointer hover:text-gray-600 transition-colors truncate block mt-0.5 bg-transparent border-0 p-0 text-left"
                title="Click to edit description"
                onClick={() => {
                  editingDesc.value = true;
                }}
              >
                {ctx.agentDescription.value || "Add description..."}
              </button>
            )}
          </div>
        </div>
      </div>
      {ctx.isAdmin && (
        <div class="flex items-center gap-3 text-xs text-gray-400 flex-shrink-0">
          {ctx.isSandbox && ctx.templateAgentId && (
            <a
              href={`/agent/${encodeURIComponent(ctx.templateAgentId)}?back=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
              class="hover:text-slate-600 transition-colors"
            >
              Open Agent
            </a>
          )}
          {ctx.isSandbox && (
            <a
              href={`/agent/${ctx.agentId}/history`}
              class="hover:text-slate-600 transition-colors"
            >
              History
            </a>
          )}
          <a href="/agent/logout" class="hover:text-red-500 transition-colors">
            Logout
          </a>
        </div>
      )}
    </div>
  );
}
