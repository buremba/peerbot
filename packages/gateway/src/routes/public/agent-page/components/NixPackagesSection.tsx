import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import * as api from "../api";
import { useSettings } from "../app";
import { Section } from "./Section";

interface NixSuggestion {
  name: string;
  pname: string;
  description: string;
}

export function NixPackagesSection({ adminOnly }: { adminOnly?: boolean }) {
  const ctx = useSettings();
  const nixPackageQuery = useSignal("");
  const nixPackageSuggestions = useSignal<NixSuggestion[]>([]);
  const nixPackageSuggestionsVisible = useSignal(false);
  const nixPackageSearchLoading = useSignal(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function normalizeNixPackageName(name: string): string {
    return (name || "").trim();
  }

  function addNixPackage(name: string) {
    if (!ctx.canEditSection("packages")) return;
    const packageName = normalizeNixPackageName(name);
    if (!packageName) return;
    if (ctx.nixPackages.value.includes(packageName)) {
      nixPackageQuery.value = "";
      nixPackageSuggestions.value = [];
      nixPackageSuggestionsVisible.value = false;
      return;
    }
    ctx.nixPackages.value = [...ctx.nixPackages.value, packageName];
    nixPackageQuery.value = "";
    nixPackageSuggestions.value = [];
    nixPackageSuggestionsVisible.value = false;
  }

  function removeNixPackage(name: string) {
    if (!ctx.canEditSection("packages")) return;
    ctx.nixPackages.value = ctx.nixPackages.value.filter((pkg) => pkg !== name);
  }

  async function handleSearchInput(query: string) {
    nixPackageQuery.value = query;
    if (searchTimer.current) clearTimeout(searchTimer.current);

    const normalized = normalizeNixPackageName(query);
    if (!normalized) {
      nixPackageSuggestionsVisible.value = false;
      nixPackageSuggestions.value = [];
      nixPackageSearchLoading.value = false;
      return;
    }

    nixPackageSuggestionsVisible.value = true;
    nixPackageSearchLoading.value = true;

    searchTimer.current = setTimeout(async () => {
      try {
        const suggestions = await api.searchNixPackages(
          ctx.agentId,
          normalized
        );
        const seen: Record<string, boolean> = {};
        const filtered: NixSuggestion[] = [];
        for (const item of suggestions) {
          const name = normalizeNixPackageName(item.name);
          if (!name || ctx.nixPackages.value.includes(name) || seen[name])
            continue;
          seen[name] = true;
          filtered.push({
            name,
            pname: typeof item.pname === "string" ? item.pname : "",
            description:
              typeof item.description === "string" ? item.description : "",
          });
        }
        nixPackageSuggestions.value = filtered;
      } catch {
        nixPackageSuggestions.value = [];
      } finally {
        nixPackageSearchLoading.value = false;
      }
    }, 300);
  }

  return (
    <Section
      id="packages"
      title="System Packages"
      icon="&#128230;"
      sectionKey="packages"
      adminOnly={adminOnly}
    >
      <div class="space-y-3">
        {ctx.nixPackages.value.length === 0 && (
          <p class="text-xs text-gray-400 italic">No packages added.</p>
        )}
        {ctx.nixPackages.value.map((pkg) => (
          <div
            key={pkg}
            class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-1.5"
          >
            <span class="flex-1 text-xs font-mono text-gray-800 break-all">
              {pkg}
            </span>
            <button
              type="button"
              disabled={!ctx.canEditSection("packages")}
              onClick={() => removeNixPackage(pkg)}
              class="text-xs font-medium text-red-600 hover:text-red-700 transition-colors disabled:opacity-50"
              title="Uninstall package"
            >
              Uninstall
            </button>
          </div>
        ))}

        {ctx.canEditSection("packages") && (
          <>
            <div class="relative">
              <input
                type="text"
                value={nixPackageQuery.value}
                onInput={(e) =>
                  handleSearchInput((e.target as HTMLInputElement).value)
                }
                onFocus={() => {
                  if (nixPackageQuery.value.trim())
                    nixPackageSuggestionsVisible.value = true;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addNixPackage(nixPackageQuery.value);
                  }
                }}
                placeholder="Search Nix packages (e.g. python311)"
                class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:border-slate-600 focus:ring-1 focus:ring-slate-200 outline-none"
              />

              {nixPackageSuggestionsVisible.value && (
                <div class="absolute z-10 left-2 right-2 mt-0.5 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                  {nixPackageSearchLoading.value && (
                    <div class="px-3 py-2 text-xs text-gray-500">
                      Searching packages...
                    </div>
                  )}
                  {nixPackageSuggestions.value.map((suggestion) => (
                    <button
                      key={suggestion.name}
                      type="button"
                      onClick={() => addNixPackage(suggestion.name)}
                      class="w-full text-left px-3 py-2 border-b border-gray-100 last:border-b-0 hover:bg-slate-50 transition-colors"
                    >
                      <div class="text-xs font-mono text-gray-800">
                        {suggestion.name}
                      </div>
                      <div class="text-[11px] text-gray-500 truncate">
                        {suggestion.description || suggestion.pname || ""}
                      </div>
                    </button>
                  ))}
                  {!nixPackageSearchLoading.value &&
                    nixPackageQuery.value.trim() &&
                    nixPackageSuggestions.value.length === 0 && (
                      <div class="px-3 py-2 text-xs text-gray-500">
                        No matching packages.
                      </div>
                    )}
                </div>
              )}
            </div>
            <p class="text-xs text-gray-400 mt-1">
              Install system tools from{" "}
              <a
                href="https://search.nixos.org/packages"
                onClick={(e) => {
                  e.preventDefault();
                  ctx.openExternal("https://search.nixos.org/packages");
                }}
                class="text-blue-600 hover:underline cursor-pointer"
              >
                Nix Packages
              </a>{" "}
              to make them available in your workspace.
            </p>
          </>
        )}
        {!ctx.canEditSection("packages") && (
          <p class="text-xs text-gray-500">
            Package configuration is visible here but cannot be edited in this
            view.
          </p>
        )}
      </div>
    </Section>
  );
}
