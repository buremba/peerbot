import { useSignal } from "@preact/signals";
import { useSettings } from "../app";
import { Section } from "./Section";

export function PermissionsSection({ adminOnly }: { adminOnly?: boolean }) {
  const ctx = useSettings();
  const showAddForm = useSignal(false);
  const newPattern = useSignal("");
  const newAccess = useSignal("1h");

  function badgeText(item: {
    expiresAt: number | null;
    denied?: boolean;
  }): string {
    if (item.denied) return "Denied";
    if (item.expiresAt === null) return "Always";
    const remaining = item.expiresAt - Date.now();
    if (remaining <= 0) return "Expired";
    if (remaining > 86400000) return `${Math.ceil(remaining / 86400000)}d left`;
    if (remaining > 3600000) return `${Math.ceil(remaining / 3600000)}h left`;
    return `${Math.ceil(remaining / 60000)}min left`;
  }

  function badgeClass(item: {
    expiresAt: number | null;
    denied?: boolean;
  }): string {
    if (item.denied) return "bg-red-100 text-red-700";
    if (item.expiresAt === null) return "bg-green-100 text-green-700";
    const remaining = (item.expiresAt || 0) - Date.now();
    if (remaining <= 0) return "bg-gray-100 text-gray-500";
    return "bg-blue-100 text-blue-700";
  }

  function addPermission() {
    if (!ctx.canEditSection("permissions")) return;
    const pattern = newPattern.value.trim();
    if (!pattern) return;
    let expiresAt: number | null = null;
    let denied = false;
    if (newAccess.value === "1h") expiresAt = Date.now() + 3600000;
    else if (newAccess.value === "session") expiresAt = Date.now() + 86400000;
    else if (newAccess.value === "denied") denied = true;

    // Add to local state only — saved on form submit
    ctx.permissionGrants.value = [
      ...ctx.permissionGrants.value,
      { pattern, expiresAt, denied, grantedAt: Date.now() },
    ];
    newPattern.value = "";
    showAddForm.value = false;
  }

  function removePermission(pattern: string) {
    if (!ctx.canEditSection("permissions")) return;
    ctx.permissionGrants.value = ctx.permissionGrants.value.filter(
      (g) => g.pattern !== pattern
    );
  }

  const sorted = ctx.permissionGrants.value.slice().sort((a, b) => {
    const aIsTool = a.pattern.startsWith("/") ? 1 : 0;
    const bIsTool = b.pattern.startsWith("/") ? 1 : 0;
    if (aIsTool !== bIsTool) return aIsTool - bIsTool;
    return a.pattern.localeCompare(b.pattern);
  });

  return (
    <Section
      id="permissions"
      title="Permissions"
      icon="&#128274;"
      sectionKey="permissions"
      adminOnly={adminOnly}
    >
      <div class="space-y-2">
        {sorted.length === 0 && !ctx.permissionsLoading.value && (
          <p class="text-xs text-gray-500">
            No permissions configured yet. The agent will ask for confirmation
            before using browser tools, accessing online data, or running
            destructive MCP actions.
          </p>
        )}
        {ctx.permissionsLoading.value && (
          <p class="text-xs text-gray-400">Loading...</p>
        )}
        {sorted.map((item) => (
          <div
            key={`${item.pattern}-${item.denied ? "d" : "a"}`}
            class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-1.5"
          >
            <span
              class="flex-1 text-xs font-mono text-gray-800 truncate"
              title={item.pattern}
            >
              {item.pattern}
            </span>
            <span
              class={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${badgeClass(item)}`}
            >
              {badgeText(item)}
            </span>
            <button
              type="button"
              disabled={!ctx.canEditSection("permissions")}
              onClick={() => removePermission(item.pattern)}
              class="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
              title="Remove"
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        ))}

        {showAddForm.value && (
          <div class="mt-2 border border-dashed border-gray-300 rounded-lg p-2 space-y-2">
            <input
              type="text"
              value={newPattern.value}
              onInput={(e) => {
                newPattern.value = (e.target as HTMLInputElement).value;
              }}
              placeholder="e.g. api.openai.com, /mcp/gmail/tools/*"
              class="w-full px-2 py-1.5 border border-gray-200 rounded text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
            />
            <div class="flex items-center gap-3 text-xs">
              {(["always", "1h", "session", "denied"] as const).map((val) => (
                <label key={val} class="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    checked={newAccess.value === val}
                    onChange={() => {
                      newAccess.value = val;
                    }}
                    class="accent-slate-700"
                  />
                  {val === "1h"
                    ? "1 hour"
                    : val.charAt(0).toUpperCase() + val.slice(1)}
                </label>
              ))}
            </div>
            <div class="flex gap-2">
              <button
                type="button"
                onClick={addPermission}
                disabled={
                  !newPattern.value.trim() || !ctx.canEditSection("permissions")
                }
                class="px-3 py-1 text-xs font-medium rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40 transition-all"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  showAddForm.value = false;
                }}
                class="px-3 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {!showAddForm.value && ctx.canEditSection("permissions") && (
          <button
            type="button"
            onClick={() => {
              showAddForm.value = true;
              newAccess.value = "1h";
            }}
            class="text-xs text-slate-600 hover:text-slate-800 font-medium"
          >
            + Add permission
          </button>
        )}
      </div>
    </Section>
  );
}
