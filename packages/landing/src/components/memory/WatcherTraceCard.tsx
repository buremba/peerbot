import type { HowItWorksPanelTrace } from "../../use-case-definitions";
import { accentCyan } from "./styles";

export function WatcherTraceCard({
  schedule,
  prompt,
  events,
  entityLabel,
  entityEmoji,
  consolidated,
}: HowItWorksPanelTrace) {
  return (
    <div class="my-8 rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(18,18,24,0.96),rgba(11,11,16,0.96))] p-4 sm:p-5">
      <div class="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-page-text-muted)]">
        Trace
      </div>

      <div class="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-3 sm:px-4 sm:py-3.5">
        <div class="mb-3 rounded-md border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3 py-2">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]">
            Watcher prompt
          </div>
          <div class="mt-1 text-[0.88rem] leading-6 text-[var(--color-page-text)]">
            “{prompt}”
          </div>
        </div>

        <div class="flex items-center gap-2">
          <span
            aria-hidden="true"
            class="inline-flex h-5 w-5 items-center justify-center rounded-full border text-[12px]"
            style={{
              color: accentCyan,
              backgroundColor: "rgba(103, 232, 249, 0.12)",
              borderColor: "rgba(103, 232, 249, 0.4)",
            }}
          >
            ◉
          </span>
          <code
            class="font-mono text-[0.85rem]"
            style={{ color: "var(--color-page-text)" }}
          >
            watcher.poll(every: {schedule})
          </code>
        </div>
        <div
          class="ml-7 mt-1 font-mono text-[0.8rem]"
          style={{ color: accentCyan }}
        >
          → {events.length} event{events.length === 1 ? "" : "s"} collected
        </div>

        <div class="ml-7 mt-2 flex flex-col gap-1">
          {events.map((event, i) => (
            <div
              key={`${event.source}-${i}`}
              class="flex items-start gap-2 text-[0.82rem] leading-snug"
            >
              <span
                class="shrink-0 pt-0.5 font-mono text-[0.72rem]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {event.time}
              </span>
              <span
                class="shrink-0 font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                {event.source}
              </span>
              <span style={{ color: "var(--color-page-text-muted)" }}>
                {event.text}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        aria-hidden="true"
        class="flex items-center justify-center gap-2 py-2 text-[0.78rem] font-mono uppercase tracking-[0.18em] text-[var(--color-page-text-muted)]"
      >
        <span class="text-base text-[var(--color-tg-accent)]">↓</span>
        consolidate
        <span class="text-base text-[var(--color-tg-accent)]">↓</span>
      </div>

      <div class="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-3 sm:px-4 sm:py-3.5">
        <div class="flex items-center gap-2 text-[0.92rem] font-semibold text-[var(--color-page-text)]">
          <span aria-hidden="true">🧠</span>
          <span>New memory written to</span>
          {entityEmoji && (
            <span aria-hidden="true" class="ml-1">
              {entityEmoji}
            </span>
          )}
          <span style={{ color: "var(--color-tg-accent)" }}>{entityLabel}</span>
        </div>
        <ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[0.9rem] leading-6 text-[var(--color-page-text-muted)]">
          {consolidated.map((item) => (
            <li key={item.text} class="flex items-start gap-2">
              <span aria-hidden="true" class="mt-[2px]">
                {item.emoji ?? "•"}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
