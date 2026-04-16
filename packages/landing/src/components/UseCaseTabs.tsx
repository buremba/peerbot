type UseCaseTab = {
  id: string;
  label: string;
};

type UseCaseTabsProps = {
  tabs: UseCaseTab[];
  activeId: string;
  onSelect?: (id: string) => void;
  hrefForId?: (id: string) => string;
  label?: string;
  className?: string;
};

export function UseCaseTabs({
  tabs,
  activeId,
  onSelect,
  hrefForId,
  label,
  className = "",
}: UseCaseTabsProps) {
  return (
    <div class={`mx-auto w-full text-center ${className}`.trim()}>
      {label && (
        <div
          class="text-[11px] font-semibold uppercase tracking-[0.22em] mb-3"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {label}
        </div>
      )}
      <div class="mx-auto flex flex-wrap items-center justify-center gap-2.5">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const commonClass = `px-4 py-2.5 rounded-full text-sm leading-none whitespace-nowrap transition-all ${
            active ? "font-semibold" : "font-medium"
          }`;
          const commonStyle = {
            backgroundColor: active
              ? "var(--color-tg-accent)"
              : "var(--color-page-surface)",
            color: active
              ? "var(--color-page-bg)"
              : "var(--color-page-text-muted)",
            border: active
              ? "1px solid var(--color-tg-accent)"
              : "1px solid var(--color-page-border)",
            boxShadow: active ? "0 6px 18px rgba(122,162,247,0.22)" : "none",
          };

          if (hrefForId) {
            return (
              <a
                key={tab.id}
                href={hrefForId(tab.id)}
                class={commonClass}
                style={commonStyle}
                aria-current={active ? "page" : undefined}
              >
                {tab.label}
              </a>
            );
          }

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelect?.(tab.id)}
              class={`${commonClass} cursor-pointer`}
              style={commonStyle}
              aria-pressed={active}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
