import { useEffect, useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  getLandingUseCaseShowcase,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { HighlightedText } from "./HighlightedText";

const GitHubIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

const ArrowRightIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
    class="ml-1"
  >
    <path
      d="M2.5 6h7m0 0L6 2.5M9.5 6 6 9.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

export type HeroStageId =
  | "model"
  | "integrate"
  | "watch"
  | "connect"
  | "knowledge";

const STAGE_TABS: Array<{ id: HeroStageId; label: string; index: number }> = [
  { id: "model", label: "Model", index: 1 },
  { id: "integrate", label: "Integrate", index: 2 },
  { id: "watch", label: "Watch", index: 3 },
  { id: "connect", label: "Connect", index: 4 },
];

const TAB_CYCLE_MS = 5000;

export function HeroSection(props: {
  activeUseCaseId?: LandingUseCaseId;
  activeStage?: HeroStageId;
  onActiveStageChange?: (id: HeroStageId) => void;
  autoAdvance?: boolean;
  onStopAutoAdvance?: () => void;
  heroCopy?: SurfaceHeroCopy;
  startUrl: string;
}) {
  const activeUseCase = getLandingUseCaseShowcase(props.activeUseCaseId);
  const activeStage = props.activeStage ?? "model";
  const autoAdvance = props.autoAdvance ?? true;
  const [cycleSeed, setCycleSeed] = useState(0);

  useEffect(() => {
    if (!autoAdvance) return;
    const idx = STAGE_TABS.findIndex((s) => s.id === activeStage);
    if (idx === -1) return;
    const t = setTimeout(() => {
      const next = STAGE_TABS[(idx + 1) % STAGE_TABS.length];
      props.onActiveStageChange?.(next.id);
      setCycleSeed((s) => s + 1);
    }, TAB_CYCLE_MS);
    return () => clearTimeout(t);
  }, [activeStage, cycleSeed, autoAdvance]);

  const handleTabClick = (id: HeroStageId) => {
    props.onStopAutoAdvance?.();
    props.onActiveStageChange?.(id);
    setCycleSeed((s) => s + 1);
  };

  const headlineText = "Proactive agents that never forget.";
  const headlineHighlight = "never forget";
  const subhead =
    props.heroCopy?.description ??
    "Build autonomous agents that take action and stay reachable from any chat or AI client.";

  return (
    <section class="pt-16 pb-8 px-6 relative">
      <div class="max-w-5xl mx-auto text-center relative">
        <a
          href="/guides/memory-benchmarks/"
          class="hero-rise hero-rise-1 inline-flex items-center gap-2 text-[12px] font-medium px-3 py-1.5 mb-8 rounded-full transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
          style={{
            color: "var(--color-page-text)",
            border: "1px solid var(--color-page-border)",
          }}
        >
          Lobu Memory scores 87.1% on LongMemEval, highest of any system
          <ArrowRightIcon />
        </a>

        <h1
          class="hero-rise hero-rise-2 font-display font-semibold leading-[1.02] mb-6"
          style={{
            color: "var(--color-page-text)",
            fontSize: "clamp(2.5rem, 6vw, 4.25rem)",
            letterSpacing: "-0.025em",
          }}
        >
          <HighlightedText text={headlineText} highlight={headlineHighlight} />
        </h1>

        <p
          class="hero-rise hero-rise-3 text-[17px] sm:text-[18px] mx-auto mb-8 leading-relaxed max-w-4xl"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {subhead}
        </p>

        <div class="hero-rise hero-rise-4 relative z-20 flex flex-wrap gap-3 justify-center items-center">
          <a
            href={props.startUrl}
            class="inline-flex items-center text-[14px] font-medium px-5 h-10 rounded-lg transition-opacity hover:opacity-90"
            style={{
              background: "#0b0b0d",
              color: "#ffffff",
            }}
          >
            Start for free
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 text-[14px] font-medium px-5 h-10 rounded-lg transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
            style={{
              color: "var(--color-page-text)",
              background: "#ffffff",
              border: "1px solid var(--color-page-border)",
            }}
          >
            <GitHubIcon />
            View on GitHub
          </a>
        </div>
      </div>

      <div
        class="hero-rise hero-rise-5 mt-16 max-w-[72rem] mx-auto"
        style={
          { "--hero-tab-cycle": `${TAB_CYCLE_MS}ms` } as Record<string, string>
        }
      >
        <div
          class="grid"
          style={{
            gridTemplateColumns: `repeat(${STAGE_TABS.length}, minmax(0, 1fr))`,
            borderTop: "1px solid var(--color-page-border)",
          }}
          role="tablist"
        >
          {STAGE_TABS.map((tab) => {
            const isActive = tab.id === activeStage;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabClick(tab.id)}
                class="relative flex items-center justify-center gap-1 sm:gap-1.5 h-14 text-[12px] sm:text-[15px] font-medium transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
                style={{
                  color: isActive
                    ? "var(--color-page-text)"
                    : "var(--color-page-text-muted)",
                  fontWeight: isActive ? 600 : 500,
                }}
                aria-selected={isActive}
                role="tab"
              >
                {isActive ? (
                  autoAdvance ? (
                    <span
                      key={`${tab.id}-${cycleSeed}`}
                      class="hero-tab-progress"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      class="absolute top-[-1px] left-0 right-0 h-[2px]"
                      style={{ background: "var(--color-tg-accent)" }}
                      aria-hidden="true"
                    />
                  )
                ) : null}
                <span
                  style={{
                    color: "var(--color-page-text-muted)",
                    opacity: 0.55,
                  }}
                >{`${tab.index}.`}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <span class="sr-only">Active use case: {activeUseCase.label}</span>
    </section>
  );
}
