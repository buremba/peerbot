import { useSignal } from "@preact/signals";
import type { AdminAgentEntry } from "../api";
import * as api from "../api";
import { useSettings } from "../app";
import type { Connection } from "../types";

// ─── Platform Field Definitions ─────────────────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: { label: string; value: string }[];
}

const PLATFORM_FIELDS: Record<string, FieldDef[]> = {
  telegram: [
    {
      key: "botToken",
      label: "Bot Token",
      type: "password",
      required: true,
      placeholder: "123456:ABC-DEF...",
      helpText: "From @BotFather",
    },
    {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Webhook", value: "webhook" },
        { label: "Polling", value: "polling" },
      ],
    },
    {
      key: "secretToken",
      label: "Secret Token",
      type: "password",
      placeholder: "Webhook secret",
    },
    {
      key: "apiBaseUrl",
      label: "API Base URL",
      type: "text",
      placeholder: "https://api.telegram.org",
    },
  ],
  slack: [
    {
      key: "signingSecret",
      label: "Signing Secret",
      type: "password",
      required: true,
      helpText: "From Slack App settings",
    },
    {
      key: "botToken",
      label: "Bot Token",
      type: "password",
      placeholder: "xoxb-...",
    },
    { key: "clientId", label: "Client ID", type: "text" },
    {
      key: "clientSecret",
      label: "Client Secret",
      type: "password",
    },
    {
      key: "encryptionKey",
      label: "Encryption Key",
      type: "password",
      helpText: "Base64-encoded 32-byte AES-256-GCM key",
    },
    { key: "userName", label: "Username", type: "text" },
  ],
  whatsapp: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "password",
      required: true,
      helpText: "System User access token",
    },
    {
      key: "phoneNumberId",
      label: "Phone Number ID",
      type: "text",
      required: true,
    },
    { key: "appSecret", label: "App Secret", type: "password" },
    {
      key: "verifyToken",
      label: "Verify Token",
      type: "password",
      placeholder: "Webhook verify token",
    },
    {
      key: "apiVersion",
      label: "API Version",
      type: "text",
      placeholder: "v21.0",
    },
  ],
  discord: [
    {
      key: "botToken",
      label: "Bot Token",
      type: "password",
      required: true,
    },
    {
      key: "applicationId",
      label: "Application ID",
      type: "text",
      required: true,
    },
    { key: "publicKey", label: "Public Key", type: "password" },
    { key: "userName", label: "Username", type: "text" },
  ],
  teams: [
    {
      key: "appId",
      label: "App ID",
      type: "text",
      required: true,
    },
    {
      key: "appPassword",
      label: "App Password",
      type: "password",
      required: true,
    },
    { key: "appTenantId", label: "Tenant ID", type: "text" },
    {
      key: "appType",
      label: "App Type",
      type: "select",
      options: [
        { label: "Multi-Tenant", value: "MultiTenant" },
        { label: "Single-Tenant", value: "SingleTenant" },
      ],
    },
    { key: "userName", label: "Username", type: "text" },
  ],
};

const PLATFORM_LABELS: Record<string, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
  teams: "Teams",
};

const PLATFORM_DOMAINS: Record<string, string> = {
  telegram: "telegram.org",
  slack: "slack.com",
  discord: "discord.com",
  whatsapp: "whatsapp.com",
  teams: "teams.microsoft.com",
};

const STATUS_DOT_COLORS: Record<string, string> = {
  active: "bg-green-500",
  stopped: "bg-gray-400",
  error: "bg-red-500",
};

const SECRET_PATTERNS = ["token", "secret", "password", "key", "credential"];

function isSecretField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SECRET_PATTERNS.some((p) => lower.includes(p));
}

// ─── Connection Card ────────────────────────────────────────────────────────

function ConnectionCard({
  connection,
  isEditing,
  onToggleEdit,
  onSaved,
  onRestart,
  onStop,
  onDelete,
}: {
  connection: Connection;
  isEditing: boolean;
  onToggleEdit: () => void;
  onSaved: (conn: Connection) => void;
  onRestart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const confirmingDelete = useSignal(false);
  const confirmingRestart = useSignal(false);
  const actionLoading = useSignal(false);
  const toggleLoading = useSignal(false);
  const formError = useSignal("");
  const formLoading = useSignal(false);

  const userConfigScopes = useSignal<string[]>(
    connection.settings?.userConfigScopes || []
  );
  const formValues = useSignal<Record<string, string>>(() => {
    const vals: Record<string, string> = {};
    const fields = PLATFORM_FIELDS[connection.platform] || [];
    for (const field of fields) {
      const val = connection.config?.[field.key];
      if (val !== undefined && val !== null) {
        if (
          isSecretField(field.key) &&
          typeof val === "string" &&
          val.startsWith("***")
        ) {
          continue;
        }
        vals[field.key] = String(val);
      }
    }
    return vals;
  });
  const allowGroups = useSignal(connection.settings?.allowGroups !== false);
  const allowFrom = useSignal(
    (connection.settings?.allowFrom || []).join(", ")
  );

  const botName =
    connection.metadata?.botUsername ||
    connection.metadata?.botDisplayName ||
    connection.config?.userName ||
    "";
  const fields = PLATFORM_FIELDS[connection.platform] || [];
  const faviconDomain = PLATFORM_DOMAINS[connection.platform];
  const statusDotColor =
    STATUS_DOT_COLORS[connection.status] || STATUS_DOT_COLORS.stopped;
  const isActive = connection.status === "active";
  const isStopped = connection.status === "stopped";
  const isError = connection.status === "error";

  function getBotLink(): string | null {
    if (connection.platform === "telegram" && botName) {
      return `https://t.me/${botName}`;
    }
    return null;
  }

  function setField(key: string, value: string) {
    formValues.value = { ...formValues.value, [key]: value };
  }

  async function handleToggle() {
    toggleLoading.value = true;
    try {
      if (isActive) {
        await onStop();
      } else if (isStopped) {
        await onRestart();
      }
    } finally {
      toggleLoading.value = false;
    }
  }

  async function handleSubmit() {
    formError.value = "";
    formLoading.value = true;
    try {
      const config: Record<string, any> = { platform: connection.platform };
      for (const field of fields) {
        const val = (formValues.value[field.key] || "").trim();
        if (val) {
          config[field.key] = val;
        }
      }
      const allowFromList = allowFrom.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const settings: Record<string, any> = {
        allowGroups: allowGroups.value,
        ...(allowFromList.length > 0 ? { allowFrom: allowFromList } : {}),
        userConfigScopes: userConfigScopes.value,
      };
      const result = await api.updateConnection(connection.id, {
        config,
        settings,
      });
      onSaved(result);
    } catch (e: unknown) {
      formError.value = e instanceof Error ? e.message : "Failed to save";
    } finally {
      formLoading.value = false;
    }
  }

  const botLink = getBotLink();

  return (
    <div
      class={`bg-white rounded-lg border ${isEditing ? "border-slate-400" : "border-gray-200"}`}
    >
      <button
        type="button"
        class="w-full p-3 cursor-pointer hover:bg-gray-50/50 transition-colors bg-transparent border-0 text-left"
        onClick={onToggleEdit}
      >
        <div class="flex items-center gap-2 flex-wrap">
          {faviconDomain && (
            <img
              src={`https://www.google.com/s2/favicons?domain=${faviconDomain}&sz=32`}
              width="16"
              height="16"
              alt={connection.platform}
              class="shrink-0"
            />
          )}

          {botName && (
            <>
              {botLink && (
                <a
                  href={botLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-gray-400 hover:text-gray-600 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                  title={`Open ${botLink}`}
                >
                  <svg
                    class="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <title>Open bot link</title>
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              )}
              <span class="text-xs text-gray-600 font-mono">@{botName}</span>
            </>
          )}

          <span
            class={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotColor}`}
            title={connection.status}
          />

          <span class="ml-auto flex items-center gap-2">
            {!isError && (
              <span
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  disabled={toggleLoading.value}
                  onClick={handleToggle}
                  class={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    toggleLoading.value
                      ? "opacity-50 cursor-wait"
                      : "cursor-pointer"
                  } ${isActive ? "bg-green-500" : "bg-gray-300"}`}
                  title={isActive ? "Stop connection" : "Start connection"}
                >
                  <span
                    class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 ease-in-out ${
                      isActive ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                  {toggleLoading.value && (
                    <span class="absolute inset-0 flex items-center justify-center">
                      <span class="animate-spin text-[8px] text-white">
                        &#8635;
                      </span>
                    </span>
                  )}
                </button>
              </span>
            )}

            {isError &&
              (confirmingRestart.value ? (
                <span
                  role="group"
                  class="flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    disabled={actionLoading.value}
                    onClick={async () => {
                      actionLoading.value = true;
                      try {
                        await onRestart();
                      } finally {
                        actionLoading.value = false;
                        confirmingRestart.value = false;
                      }
                    }}
                    class="px-1.5 py-0.5 text-[10px] rounded bg-slate-600 text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      confirmingRestart.value = false;
                    }}
                    class="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  title="Restart connection"
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmingRestart.value = true;
                  }}
                  class="p-1 rounded text-gray-400 hover:text-slate-600 hover:bg-gray-100 transition-colors"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <title>Restart</title>
                    <path d="M21 2v6h-6" />
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                    <path d="M3 22v-6h6" />
                    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                  </svg>
                </button>
              ))}

            {confirmingDelete.value ? (
              <span
                role="presentation"
                class="flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  disabled={actionLoading.value}
                  onClick={async () => {
                    actionLoading.value = true;
                    try {
                      await onDelete();
                    } finally {
                      actionLoading.value = false;
                      confirmingDelete.value = false;
                    }
                  }}
                  class="px-1.5 py-0.5 text-[10px] rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Delete?
                </button>
                <button
                  type="button"
                  onClick={() => {
                    confirmingDelete.value = false;
                  }}
                  class="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                >
                  No
                </button>
              </span>
            ) : (
              <button
                type="button"
                title="Delete connection"
                onClick={(e) => {
                  e.stopPropagation();
                  confirmingDelete.value = true;
                }}
                class="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <title>Delete</title>
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            )}
          </span>
        </div>

        {connection.status === "error" && connection.errorMessage && (
          <div class="mt-2 px-2 py-1.5 bg-red-50 rounded text-xs text-red-700 break-all">
            {connection.errorMessage}
          </div>
        )}
      </button>

      {isEditing && (
        <div class="px-3 pb-3 space-y-3 border-t border-gray-100 pt-3">
          {fields.map((field) => {
            const redactedValue = isSecretField(field.key)
              ? connection.config?.[field.key]
              : undefined;
            const redactedHint =
              redactedValue &&
              typeof redactedValue === "string" &&
              redactedValue.startsWith("***")
                ? `${redactedValue} (leave blank to keep)`
                : undefined;

            if (field.type === "select" && field.options) {
              return (
                <div key={field.key}>
                  <label class="block text-xs font-medium text-gray-700 mb-1">
                    {field.label}
                    {field.required && (
                      <span class="text-red-500 ml-0.5">*</span>
                    )}
                    <select
                      value={formValues.value[field.key] || ""}
                      onChange={(e) =>
                        setField(
                          field.key,
                          (e.target as HTMLSelectElement).value
                        )
                      }
                      class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                    >
                      <option value="">Default</option>
                      {field.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {field.helpText && (
                    <p class="text-[10px] text-gray-400 mt-0.5">
                      {field.helpText}
                    </p>
                  )}
                </div>
              );
            }

            return (
              <div key={field.key}>
                <label class="block text-xs font-medium text-gray-700 mb-1">
                  {field.label}
                  <input
                    type={field.type === "password" ? "password" : "text"}
                    value={formValues.value[field.key] || ""}
                    placeholder={redactedHint || field.placeholder || ""}
                    onInput={(e) =>
                      setField(field.key, (e.target as HTMLInputElement).value)
                    }
                    class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                  />
                </label>
                {field.helpText && (
                  <p class="text-[10px] text-gray-400 mt-0.5">
                    {field.helpText}
                  </p>
                )}
              </div>
            );
          })}

          {/* Settings */}
          <div class="border-t border-gray-200 pt-2 space-y-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowGroups.value}
                onChange={(e) => {
                  allowGroups.value = (e.target as HTMLInputElement).checked;
                }}
                class="w-3.5 h-3.5 text-slate-600 rounded focus:ring-slate-500"
              />
              <span class="text-xs text-gray-700">Allow group messages</span>
            </label>
            <div>
              <label class="block text-xs font-medium text-gray-700 mb-1">
                Allowed users (comma-separated IDs)
                <input
                  type="text"
                  value={allowFrom.value}
                  placeholder="Leave empty for all users"
                  onInput={(e) => {
                    allowFrom.value = (e.target as HTMLInputElement).value;
                  }}
                  class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                />
              </label>
            </div>
          </div>

          {/* User config scopes */}
          <div class="border-t border-gray-200 pt-2 space-y-1">
            <span class="block text-xs font-medium text-gray-700 mb-1">
              User-configurable settings
            </span>
            <p class="text-[10px] text-gray-400 mb-1.5">
              Select which sections end users can access via self-service
              settings.
            </p>
            {(
              [
                { value: "view-model", label: "Providers (Read-only)" },
                { value: "model", label: "Providers (Edit)" },
                { value: "system-prompt", label: "Instructions" },
                { value: "skills", label: "Skills" },
                { value: "schedules", label: "Schedules" },
                { value: "permissions", label: "Permissions" },
                { value: "packages", label: "System Packages" },
              ] as const
            ).map((scope) => (
              <label
                key={scope.value}
                class="flex items-center gap-2 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={userConfigScopes.value.includes(scope.value)}
                  onChange={(e) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    if (checked) {
                      userConfigScopes.value = [
                        ...userConfigScopes.value,
                        scope.value,
                      ];
                    } else {
                      userConfigScopes.value = userConfigScopes.value.filter(
                        (s) => s !== scope.value
                      );
                    }
                  }}
                  class="w-3.5 h-3.5 text-slate-600 rounded focus:ring-slate-500"
                />
                <span class="text-xs text-gray-700">{scope.label}</span>
              </label>
            ))}
          </div>

          {formError.value && (
            <div class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs">
              {formError.value}
            </div>
          )}

          <div class="flex items-center gap-2">
            <button
              type="button"
              disabled={formLoading.value}
              onClick={handleSubmit}
              class="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all disabled:opacity-60"
            >
              {formLoading.value ? "Saving..." : "Update"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Connection Form ────────────────────────────────────────────────────

function NewConnectionForm({
  agentId,
  onSaved,
  onCancel,
}: {
  agentId: string;
  onSaved: (conn: Connection) => void;
  onCancel: () => void;
}) {
  const platform = useSignal("telegram");
  const userConfigScopes = useSignal<string[]>([]);
  const formValues = useSignal<Record<string, string>>({});
  const allowGroups = useSignal(true);
  const allowFrom = useSignal("");
  const formError = useSignal("");
  const formLoading = useSignal(false);

  const fields = PLATFORM_FIELDS[platform.value] || [];

  function setField(key: string, value: string) {
    formValues.value = { ...formValues.value, [key]: value };
  }

  async function handleSubmit() {
    formError.value = "";
    formLoading.value = true;
    try {
      const config: Record<string, any> = { platform: platform.value };
      for (const field of fields) {
        const val = (formValues.value[field.key] || "").trim();
        if (val) {
          config[field.key] = val;
        }
      }
      const allowFromList = allowFrom.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const settings: Record<string, any> = {
        allowGroups: allowGroups.value,
        ...(allowFromList.length > 0 ? { allowFrom: allowFromList } : {}),
        userConfigScopes: userConfigScopes.value,
      };
      const result = await api.createConnection({
        platform: platform.value,
        templateAgentId: agentId,
        config,
        settings,
      });
      onSaved(result);
    } catch (e: unknown) {
      formError.value = e instanceof Error ? e.message : "Failed to save";
    } finally {
      formLoading.value = false;
    }
  }

  return (
    <div class="bg-white rounded-lg border border-gray-200 p-3 space-y-3">
      <div>
        <label class="block text-xs font-medium text-gray-700 mb-1">
          Platform
          <select
            value={platform.value}
            onChange={(e) => {
              platform.value = (e.target as HTMLSelectElement).value;
              formValues.value = {};
            }}
            class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
          >
            {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {fields.map((field) => {
        if (field.type === "select" && field.options) {
          return (
            <div key={field.key}>
              <label class="block text-xs font-medium text-gray-700 mb-1">
                {field.label}
                {field.required && <span class="text-red-500 ml-0.5">*</span>}
                <select
                  value={formValues.value[field.key] || ""}
                  onChange={(e) =>
                    setField(field.key, (e.target as HTMLSelectElement).value)
                  }
                  class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
                >
                  <option value="">Default</option>
                  {field.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              {field.helpText && (
                <p class="text-[10px] text-gray-400 mt-0.5">{field.helpText}</p>
              )}
            </div>
          );
        }
        return (
          <div key={field.key}>
            <label class="block text-xs font-medium text-gray-700 mb-1">
              {field.label}
              {field.required && <span class="text-red-500 ml-0.5">*</span>}
              <input
                type={field.type === "password" ? "password" : "text"}
                value={formValues.value[field.key] || ""}
                placeholder={field.placeholder || ""}
                onInput={(e) =>
                  setField(field.key, (e.target as HTMLInputElement).value)
                }
                class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
              />
            </label>
            {field.helpText && (
              <p class="text-[10px] text-gray-400 mt-0.5">{field.helpText}</p>
            )}
          </div>
        );
      })}

      {/* Settings */}
      <div class="border-t border-gray-200 pt-2 space-y-2">
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allowGroups.value}
            onChange={(e) => {
              allowGroups.value = (e.target as HTMLInputElement).checked;
            }}
            class="w-3.5 h-3.5 text-slate-600 rounded focus:ring-slate-500"
          />
          <span class="text-xs text-gray-700">Allow group messages</span>
        </label>
        <div>
          <label class="block text-xs font-medium text-gray-700 mb-1">
            Allowed users (comma-separated IDs)
            <input
              type="text"
              value={allowFrom.value}
              placeholder="Leave empty for all users"
              onInput={(e) => {
                allowFrom.value = (e.target as HTMLInputElement).value;
              }}
              class="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
            />
          </label>
        </div>
      </div>

      {formError.value && (
        <div class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs">
          {formError.value}
        </div>
      )}

      <div class="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={formLoading.value}
          onClick={handleSubmit}
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-all disabled:opacity-60"
        >
          {formLoading.value ? "Saving..." : "Create"}
        </button>
      </div>
    </div>
  );
}

// ─── Sandbox List ───────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function buildOwnerUrl(platform: string, userId: string): string | null {
  switch (platform) {
    case "telegram":
      return `https://t.me/${userId}`;
    default:
      return null;
  }
}

function stripPlatformPrefix(name: string, platform: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith(`${platform} `)) return name.slice(platform.length + 1);
  const label = (PLATFORM_LABELS[platform] || "").toLowerCase();
  if (label && lower.startsWith(`${label} `))
    return name.slice(label.length + 1);
  return name;
}

function SandboxList({
  sandboxes,
  connection,
  parentAgentId,
}: {
  sandboxes: AdminAgentEntry[];
  connection: Connection;
  parentAgentId: string;
}) {
  return (
    <div class="ml-4 mt-1 space-y-0.5">
      {sandboxes.map((sb) => {
        const displayName = stripPlatformPrefix(sb.name, connection.platform);
        const ownerUrl = buildOwnerUrl(sb.owner.platform, sb.owner.userId);
        return (
          <a
            key={sb.agentId}
            href={`/agent/${encodeURIComponent(sb.agentId)}?back=${encodeURIComponent(`/agent/${parentAgentId}?open=connections`)}`}
            class="flex items-center gap-2 py-1 px-2 rounded hover:bg-gray-100 transition-colors group text-[11px]"
          >
            <span class="text-gray-300 font-mono text-xs select-none">
              {"\u23BF"}
            </span>
            <span class="text-gray-700 group-hover:text-gray-900 truncate">
              {displayName}
            </span>
            <code class="text-gray-400 text-[10px] font-mono">
              {sb.owner.userId}
            </code>
            {sb.lastUsedAt && (
              <span class="text-gray-400 text-[10px] whitespace-nowrap">
                {formatRelativeTime(sb.lastUsedAt)}
              </span>
            )}
            <span class="ml-auto flex items-center gap-1.5">
              <a
                href={`/agent/${encodeURIComponent(sb.agentId)}/history`}
                onClick={(e) => {
                  e.stopPropagation();
                }}
                title="View history"
                class="text-gray-400 hover:text-slate-600 cursor-pointer"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <title>History</title>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </a>
              {ownerUrl && (
                <a
                  href={ownerUrl}
                  target="_blank"
                  rel="noopener"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  title={`Open ${displayName}'s profile`}
                  class="text-gray-400 hover:text-blue-600 cursor-pointer"
                >
                  &#8599;
                </a>
              )}
            </span>
          </a>
        );
      })}
    </div>
  );
}

// ─── Main Section ───────────────────────────────────────────────────────────

export function ConnectionsSection() {
  const ctx = useSettings();

  // Only show for admins
  if (!ctx.isAdmin) return null;

  const connections = useSignal<Connection[]>([]);
  const sandboxAgents = useSignal<AdminAgentEntry[]>([]);
  const loading = useSignal(true);
  const error = useSignal("");
  const successMsg = useSignal("");
  const showNewForm = useSignal(false);
  const editingConnectionId = useSignal<string | null>(null);

  const initialized = useSignal(false);
  if (!initialized.value) {
    initialized.value = true;
    Promise.all([api.listConnections(ctx.agentId), api.listAdminAgents()])
      .then(([conns, agents]) => {
        connections.value = conns;
        // Filter to sandbox agents that belong to connections of this agent
        const connIds = new Set(conns.map((c) => c.id));
        sandboxAgents.value = agents.filter(
          (a) => a.parentConnectionId && connIds.has(a.parentConnectionId)
        );
      })
      .catch(() => {
        error.value = "Failed to load connections.";
      })
      .finally(() => {
        loading.value = false;
      });
  }

  // Group sandboxes by parent connection ID
  const sandboxesByConnection = new Map<string, AdminAgentEntry[]>();
  for (const sb of sandboxAgents.value) {
    if (!sb.parentConnectionId) continue;
    const list = sandboxesByConnection.get(sb.parentConnectionId) || [];
    list.push(sb);
    sandboxesByConnection.set(sb.parentConnectionId, list);
  }

  function flashSuccess(msg: string) {
    successMsg.value = msg;
    setTimeout(() => {
      successMsg.value = "";
    }, 3000);
  }

  function flashError(msg: string) {
    error.value = msg;
    setTimeout(() => {
      error.value = "";
    }, 5000);
  }

  async function handleRestart(id: string) {
    try {
      const updated = await api.restartConnection(id);
      connections.value = connections.value.map((c) =>
        c.id === id ? updated : c
      );
      flashSuccess("Connection restarted!");
    } catch (e: unknown) {
      flashError(e instanceof Error ? e.message : "Failed to restart");
    }
  }

  async function handleStop(id: string) {
    try {
      const updated = await api.stopConnection(id);
      connections.value = connections.value.map((c) =>
        c.id === id ? updated : c
      );
      flashSuccess("Connection stopped!");
    } catch (e: unknown) {
      flashError(e instanceof Error ? e.message : "Failed to stop");
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteConnection(id);
      connections.value = connections.value.filter((c) => c.id !== id);
      editingConnectionId.value = null;
      flashSuccess("Connection deleted!");
    } catch (e: unknown) {
      flashError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  function handleConnectionSaved(conn: Connection) {
    const existing = connections.value.find((c) => c.id === conn.id);
    if (existing) {
      connections.value = connections.value.map((c) =>
        c.id === conn.id ? conn : c
      );
    } else {
      connections.value = [...connections.value, conn];
    }
    showNewForm.value = false;
    editingConnectionId.value = null;
    flashSuccess(existing ? "Connection updated!" : "Connection created!");
  }

  function toggleEdit(id: string) {
    if (editingConnectionId.value === id) {
      editingConnectionId.value = null;
    } else {
      editingConnectionId.value = id;
      showNewForm.value = false;
    }
  }

  const isOpen = ctx.openSections.value.connections;

  return (
    <div class="bg-gray-50 rounded-lg p-3">
      <h3
        class="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none"
        onClick={() => ctx.toggleSection("connections")}
      >
        Connections
        <span class="inline-flex items-center justify-center bg-slate-200 text-slate-600 text-[10px] font-semibold rounded-full min-w-[1.25rem] h-5 px-1.5">
          {connections.value.length}
        </span>
        <span
          class={`ml-auto text-xs text-gray-400 transition-transform ${isOpen ? "" : "rotate-[-90deg]"}`}
        >
          &#9660;
        </span>
      </h3>

      {isOpen && (
        <div class="pt-3 space-y-2">
          {successMsg.value && (
            <div class="bg-green-100 text-green-800 px-3 py-2 rounded-lg text-xs">
              {successMsg.value}
            </div>
          )}
          {error.value && (
            <div class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs">
              {error.value}
            </div>
          )}

          {loading.value && (
            <div class="flex items-center gap-2 text-xs text-slate-500">
              <span class="animate-spin">&#8635;</span> Loading...
            </div>
          )}

          {!loading.value &&
            connections.value.length === 0 &&
            !showNewForm.value && (
              <p class="text-xs text-gray-500">No connections yet.</p>
            )}

          {connections.value.map((conn) => {
            const connSandboxes = sandboxesByConnection.get(conn.id) || [];
            return (
              <div key={conn.id}>
                <ConnectionCard
                  connection={conn}
                  isEditing={editingConnectionId.value === conn.id}
                  onToggleEdit={() => toggleEdit(conn.id)}
                  onSaved={handleConnectionSaved}
                  onRestart={() => handleRestart(conn.id)}
                  onStop={() => handleStop(conn.id)}
                  onDelete={() => handleDelete(conn.id)}
                />
                {connSandboxes.length > 0 && (
                  <SandboxList
                    sandboxes={connSandboxes}
                    connection={conn}
                    parentAgentId={ctx.agentId}
                  />
                )}
              </div>
            );
          })}

          {showNewForm.value ? (
            <NewConnectionForm
              agentId={ctx.agentId}
              onSaved={handleConnectionSaved}
              onCancel={() => {
                showNewForm.value = false;
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                editingConnectionId.value = null;
                showNewForm.value = true;
              }}
              class="w-full py-1.5 text-xs font-medium rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-slate-400 hover:text-slate-600 transition-colors"
            >
              + Add Connection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
