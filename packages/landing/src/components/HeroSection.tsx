import { useEffect, useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  getLandingUseCaseShowcase,
  type SurfaceHeroCopy,
} from "../use-case-showcases";

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

const SETUP_PROMPT = `Build me a working Lobu app end-to-end. Lobu is an open-source multi-tenant backend for AI agents (memory, watchers, connectors, chat platforms, MCP).

Repo: https://github.com/lobu-ai/lobu
Docs: https://lobu.ai/getting-started/
Skills guide: https://lobu.ai/getting-started/skills/

Phase 1 — Environment
1. Verify Node 22–24 and Postgres+pgvector are available; install if missing.
2. Clone https://github.com/lobu-ai/lobu, run \`bun install\`, copy \`.env.example\` to \`.env\` and fill in DATABASE_URL + an ANTHROPIC_API_KEY (or OPENAI_API_KEY).
3. Run \`make dev\` to boot the embedded gateway + workers on :8787. Confirm the web UI loads.

Phase 2 — Install the Lobu starter skill
4. Install the starter skill into your own agent runtime (Claude Code / Cursor / OpenClaw / ChatGPT — whichever you are). Follow the install steps in the skills guide. The skill teaches you the lobu.toml + SKILL.md shape so you can scaffold projects correctly.

Phase 3 — Interview me
5. Now interview me. Ask short, concrete questions one at a time:
   - What is the agent for? (the job-to-be-done in one sentence)
   - Who uses it? (single user, my team, or end-customers each with their own data)
   - What does it need to remember? (we'll turn this into 1–3 entity types)
   - Where does the data come from? (Slack, Gmail, GitHub, Linear, Notion, a CSV, a local folder, an API — pick 1 to start)
   - Where do people talk to it? (Slack, Telegram, web chat, MCP-only)
   - What should it do on a schedule, if anything? (1 watcher max for v1)

Phase 4 — Scaffold and run
6. Based on my answers, generate the project: one agent, the entity types, one connector, one watcher on a sensible schedule, and one chat-channel binding. Use the workspace I created in Phase 1.
7. Boot the agent locally, send a test message via the channel, confirm the agent replies and the watcher fires. Show me the memory event that was written.
8. Hand me a short README with the next 3 things I should customise.

Rules: pause at every real decision (connector choice, model provider, OAuth flow, schedule cadence) and ask me. Don't fake credentials — if a real OAuth or API key is needed, walk me through getting it. Cite docs links instead of guessing.`;

function CopyPromptButton() {
  const [copied, setCopied] = useState(false);
  const handleClick = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // noop
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      class="inline-flex items-center gap-2 text-[14px] font-medium px-5 h-10 rounded-lg transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
      style={{
        color: "var(--color-page-text)",
        background: "var(--color-page-surface)",
        border: "1px solid var(--color-page-border)",
      }}
      aria-label="Copy a setup prompt for your AI agent"
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
        {copied ? (
          <polyline points="20 6 9 17 4 12" />
        ) : (
          <>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </>
        )}
      </svg>
      {copied ? "Copied — paste into your agent" : "Copy setup prompt"}
    </button>
  );
}

export type HeroStageId = "model" | "integrate" | "connect" | "knowledge";

const STAGE_TABS: Array<{ id: HeroStageId; label: string }> = [
  { id: "integrate", label: "Connectors" },
  { id: "model", label: "Memory" },
  { id: "connect", label: "Agents" },
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
  // Auto-advance is disruptive on narrow viewports — scrolling into the
  // preview triggers the next tab to flip out from under the reader.
  // Gate the cycle on the md breakpoint, matching the responsive design.
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 768px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!autoAdvance || !isDesktop) return;
    const idx = STAGE_TABS.findIndex((s) => s.id === activeStage);
    if (idx === -1) return;
    const t = setTimeout(() => {
      const next = STAGE_TABS[(idx + 1) % STAGE_TABS.length];
      props.onActiveStageChange?.(next.id);
      setCycleSeed((s) => s + 1);
    }, TAB_CYCLE_MS);
    return () => clearTimeout(t);
  }, [activeStage, cycleSeed, autoAdvance, isDesktop]);

  const handleTabClick = (id: HeroStageId) => {
    props.onStopAutoAdvance?.();
    props.onActiveStageChange?.(id);
    setCycleSeed((s) => s + 1);
  };

  const headlinePrefix = "Open-source backend for";
  const headlineHighlight = "multi-user";
  const headlineSuffix = "AI agents";
  const subhead =
    props.heroCopy?.description ??
    "Give every user an isolated agent workspace with OAuth, connected sources, shared memory, watchers, and secrets agents never see.";

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
          Multi-tenant agents with per-user OAuth isolation
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
          <span class="block">{headlinePrefix}</span>
          <span class="block">
            <span style={{ color: "var(--color-tg-accent)" }}>
              {headlineHighlight}
            </span>{" "}
            {headlineSuffix}
          </span>
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
              background: "var(--color-page-bg-inverted)",
              color: "var(--color-page-text-inverted)",
            }}
          >
            Start building
          </a>
          <CopyPromptButton />
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
