import type { ComponentChildren } from "preact";
import { useSettings } from "../app";
import type { SettingsSectionKey } from "../types";

interface SectionProps {
  id: string;
  title: string;
  icon: string;
  sectionKey?: SettingsSectionKey;
  badge?: ComponentChildren;
  adminOnly?: boolean;
  children: ComponentChildren;
}

export function Section({
  id,
  title,
  icon,
  sectionKey,
  badge,
  adminOnly,
  children,
}: SectionProps) {
  const ctx = useSettings();
  const { openSections, toggleSection } = ctx;
  const isOpen = openSections.value[id];
  const sectionView = sectionKey ? ctx.sectionViews[sectionKey] : undefined;
  const storeBackedResetAvailable =
    (sectionKey === "permissions" && ctx.permissionGrants.value.length > 0) ||
    (sectionKey === "schedules" && ctx.schedules.value.length > 0);
  const canResetSection =
    !!sectionKey &&
    ctx.canEditSection(sectionKey) &&
    (sectionView?.canReset || (ctx.isSandbox && storeBackedResetAvailable));

  const sourceBadge =
    sectionView && ctx.isSandbox ? (
      <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
        {sectionView.source}
      </span>
    ) : null;
  const readOnlyBadge =
    sectionView && !ctx.canEditSection(sectionKey!) ? (
      <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
        read-only
      </span>
    ) : null;

  return (
    <div class="bg-gray-50 rounded-lg p-3">
      <div class="flex items-center gap-2">
        <h3
          class="flex flex-1 items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer select-none"
          onClick={() => toggleSection(id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") toggleSection(id);
          }}
        >
          <span dangerouslySetInnerHTML={{ __html: icon }} />
          {title}
          {adminOnly && (
            <span class="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              hidden from user
            </span>
          )}
          {sourceBadge}
          {readOnlyBadge}
          {badge}
          <span
            class={`ml-auto text-xs text-gray-400 transition-transform ${isOpen ? "" : "rotate-[-90deg]"}`}
          >
            &#9660;
          </span>
        </h3>
        {sectionKey && canResetSection && (
          <button
            type="button"
            onClick={() => {
              void ctx.resetSection(sectionKey);
            }}
            class="text-xs text-slate-600 hover:text-slate-800 transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      {isOpen && <div class="pt-3">{children}</div>}
    </div>
  );
}
