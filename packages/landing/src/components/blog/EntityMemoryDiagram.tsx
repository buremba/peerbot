import type { ComponentChildren } from "preact";

type EntityMemoryItem = {
  emoji?: string;
  text: string;
};

type EntityMemoryNode = {
  label: string;
  emoji?: string;
  target?: boolean;
  items?: EntityMemoryItem[];
};

type EntityMemoryDiagramProps = {
  prompt: string;
  promptLabel?: string;
  rootLabel: string;
  rootEmoji?: string;
  entities: EntityMemoryNode[];
};

const guideColor = "rgba(255,255,255,0.16)";

function TreeBranch({ children }: { children: ComponentChildren }) {
  return (
    <div
      class="relative ml-3 pl-5"
      style={{ borderLeft: `1px solid ${guideColor}` }}
    >
      {children}
    </div>
  );
}

function TreeRow({
  children,
  last,
}: {
  children: ComponentChildren;
  last?: boolean;
}) {
  return (
    <div class="relative">
      <span
        aria-hidden="true"
        class="absolute left-[-20px] top-[14px] block h-px w-4"
        style={{ background: guideColor }}
      />
      {last && (
        <span
          aria-hidden="true"
          class="absolute left-[-21px] top-[14px] block h-[calc(100%_-_14px)] w-px"
          style={{ background: "var(--color-page-bg, #0b0b10)" }}
        />
      )}
      {children}
    </div>
  );
}

export function EntityMemoryDiagram({
  prompt,
  promptLabel = "Inbound fact",
  rootLabel,
  rootEmoji,
  entities,
}: EntityMemoryDiagramProps) {
  return (
    <div class="my-8 rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(18,18,24,0.96),rgba(11,11,16,0.96))] p-4 sm:p-5">
      <div class="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-2.5 sm:px-4 sm:py-3">
        <div class="grid gap-1.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:gap-3">
          <div>
            <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
              {promptLabel}
            </div>
            <div class="mt-0.5 flex items-start gap-2 text-[0.98rem] font-semibold leading-tight text-[var(--color-page-text)] sm:text-[1rem]">
              <span aria-hidden="true">📥</span>
              <span>Prompt</span>
            </div>
          </div>
          <div class="text-[0.92rem] leading-6 text-[var(--color-page-text-muted)] sm:self-center">
            “{prompt}”
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        class="flex items-center justify-center py-1.5 text-base text-[var(--color-tg-accent)]"
      >
        ↓
      </div>

      <div class="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-3 sm:px-5 sm:py-4">
        <div class="flex items-center gap-2 text-[0.95rem] font-semibold text-[var(--color-page-text)]">
          {rootEmoji && <span aria-hidden="true">{rootEmoji}</span>}
          <span>{rootLabel}</span>
          <span class="ml-1 rounded-full border border-[rgba(255,255,255,0.1)] px-2 py-[1px] text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-page-text-muted)]">
            entity type
          </span>
        </div>

        <div class="mt-3">
          {entities.map((entity, idx) => {
            const isLast = idx === entities.length - 1;
            const items = entity.items ?? [];
            const targetClass = entity.target
              ? "font-semibold text-[var(--color-page-text)]"
              : "text-[var(--color-page-text-muted)]";
            return (
              <TreeBranch key={entity.label}>
                <TreeRow last={isLast}>
                  <div
                    class={`flex items-center gap-2 py-0.5 text-[0.95rem] ${targetClass}`}
                  >
                    {entity.emoji && (
                      <span aria-hidden="true">{entity.emoji}</span>
                    )}
                    <span>{entity.label}</span>
                    {entity.target && (
                      <span
                        class="ml-1 rounded-md border px-1.5 py-[1px] text-[10px] font-medium uppercase tracking-[0.14em]"
                        style={{
                          borderColor: "var(--color-tg-accent)",
                          color: "var(--color-tg-accent)",
                        }}
                      >
                        target
                      </span>
                    )}
                  </div>
                </TreeRow>

                {items.length > 0 && (
                  <div class="pb-1">
                    {items.map((item, itemIdx) => (
                      <TreeBranch key={item.text}>
                        <TreeRow last={itemIdx === items.length - 1}>
                          <div class="flex items-start gap-2 py-0.5 text-[0.9rem] leading-6 text-[var(--color-page-text-muted)]">
                            <span aria-hidden="true">{item.emoji ?? "•"}</span>
                            <span>{item.text}</span>
                          </div>
                        </TreeRow>
                      </TreeBranch>
                    ))}
                  </div>
                )}
              </TreeBranch>
            );
          })}
        </div>
      </div>
    </div>
  );
}
