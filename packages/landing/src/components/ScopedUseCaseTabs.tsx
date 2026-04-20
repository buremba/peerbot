type UseCaseTab = { id: string; label: string; emoji?: string };

type ScopeGroup = {
  id: string;
  label: string;
  description: string;
  useCases: UseCaseTab[];
};

type Props = {
  groups: ScopeGroup[];
  activeId: string;
  onSelect?: (id: string) => void;
  hrefForId?: (id: string) => string;
  className?: string;
};

export function ScopedUseCaseTabs({
  groups,
  activeId,
  onSelect,
  hrefForId,
  className = "",
}: Props) {
  return (
    <div class={`mx-auto w-full max-w-3xl ${className}`.trim()}>
      <div class="grid gap-2.5">
        {groups.map((group) => (
          <div
            key={group.id}
            class="grid grid-cols-1 sm:grid-cols-[7rem_1fr] gap-x-4 gap-y-2 items-start"
          >
            <div
              class="text-[10px] uppercase tracking-[0.2em] sm:pt-2.5 sm:text-right"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {group.label}
            </div>
            <div class="flex flex-wrap gap-2">
              {group.useCases.map((tab) => {
                const active = tab.id === activeId;
                const commonClass = `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm leading-none whitespace-nowrap transition-all ${
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
                  boxShadow: active
                    ? "0 6px 18px rgba(122,162,247,0.22)"
                    : "none",
                };
                const inner = (
                  <>
                    {tab.emoji ? (
                      <span aria-hidden="true">{tab.emoji}</span>
                    ) : null}
                    <span>{tab.label}</span>
                  </>
                );
                if (hrefForId) {
                  return (
                    <a
                      key={tab.id}
                      href={hrefForId(tab.id)}
                      class={commonClass}
                      style={commonStyle}
                      aria-current={active ? "page" : undefined}
                    >
                      {inner}
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
                    {inner}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
