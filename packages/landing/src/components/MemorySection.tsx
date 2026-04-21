import { useMemo, useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLandingUseCaseShowcase,
  getMemoryPrompt,
  getOwlettoLoginUrl,
  landingUseCaseGroupedOptions,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { CommandHero } from "./CommandHero";
import { HighlightedText } from "./HighlightedText";
import { ContentRail } from "./ContentRail";
import { ExampleShowcase } from "./memory/ExampleShowcase";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";
import { ScopedUseCaseTabs } from "./ScopedUseCaseTabs";
import { SectionHeader } from "./SectionHeader";
import { BenchmarkTablesGrid } from "./memory/BenchmarkTables";
import { textColor, textMuted } from "./memory/styles";

function SectionDivider() {
  return <div class="section-divider" />;
}

const GITHUB_URL = "https://github.com/lobu-ai/owletto";

function GitHubIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12A11.5 11.5 0 0 0 8.36 22.1c.58.1.79-.25.79-.56v-1.95c-3.18.69-3.85-1.35-3.85-1.35-.52-1.31-1.27-1.66-1.27-1.66-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.76 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.54-.29-5.2-1.27-5.2-5.64 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.06 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.62 1.59.23 2.77.11 3.06.74.8 1.18 1.83 1.18 3.08 0 4.38-2.67 5.35-5.22 5.63.41.36.77 1.08.77 2.18v3.24c0 .31.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function MemorySection(props: {
  defaultUseCaseId?: LandingUseCaseId;
  linkTabsToPages?: boolean;
  latestPosts: LatestBlogPost[];
  heroCopy?: SurfaceHeroCopy;
}) {
  const [activeUseCaseId, setActiveUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const activeUseCase = useMemo(
    () => getLandingUseCaseShowcase(activeUseCaseId),
    [activeUseCaseId]
  );

  return (
    <section class="pt-32 pb-24 px-4 sm:px-8">
      <div class="max-w-[72rem] mx-auto">
        <CommandHero
          title={
            <HighlightedText
              text="Turn data into shared, structured memory"
              highlight="structured memory"
            />
          }
          description={
            props.heroCopy?.description ??
            "Owletto gives all your agents the same durable graph: connectors, recall, and managed auth without leaking credentials to the runtime."
          }
          prompt={getMemoryPrompt(activeUseCase)}
          actions={
            <a
              href={getOwlettoLoginUrl()}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
              style={{
                backgroundColor: "var(--color-page-text)",
                color: "var(--color-page-bg)",
              }}
            >
              Build Memory
            </a>
          }
        />

        <div class="mb-10 text-center">
          <ScopedUseCaseTabs
            groups={landingUseCaseGroupedOptions}
            activeId={activeUseCaseId}
            onSelect={
              props.linkTabsToPages
                ? undefined
                : (id) => setActiveUseCaseId(id as LandingUseCaseId)
            }
            hrefForId={
              props.linkTabsToPages ? (id) => `/memory/for/${id}` : undefined
            }
          />
        </div>

        <ExampleShowcase
          activeUseCaseId={activeUseCaseId}
          onActiveUseCaseChange={setActiveUseCaseId}
          showTabs={false}
        />

        <SectionDivider />

        <LatestBlogPosts posts={props.latestPosts} />

        <SectionDivider />

        <ContentRail variant="compact">
          <SectionHeader
            title="Beats Mem0 and Supermemory on public benchmarks"
            body="Apples-to-apples comparison on public memory datasets. Same answerer (glm-5.1 via z.ai), same top-K, same questions."
            className="mb-10"
          />

          <BenchmarkTablesGrid />

          <div class="mt-8 text-center">
            <a
              href="/guides/memory-benchmarks/"
              class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
              style={{
                backgroundColor: "var(--color-page-surface)",
                color: textColor,
                border: "1px solid var(--color-page-border-active)",
              }}
            >
              Read the methodology
            </a>
          </div>
        </ContentRail>

        <SectionDivider />

        <ContentRail variant="compact" className="text-center">
          <h2
            class="text-2xl font-bold mb-3 mt-12"
            style={{ color: textColor }}
          >
            Start building shared memory
          </h2>
          <p
            class="text-sm mb-6 max-w-md mx-auto leading-relaxed"
            style={{ color: textMuted }}
          >
            Model the right entities, connect your sources, and keep long-term
            context available across every agent workflow.
          </p>
          <div class="flex flex-wrap gap-3 justify-center">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
              style={{
                backgroundColor: "var(--color-page-surface)",
                color: textColor,
                border: "1px solid var(--color-page-border-active)",
              }}
            >
              <GitHubIcon />
              Owletto on GitHub
            </a>
            <ScheduleCallButton
              class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
              style={{
                backgroundColor: "var(--color-tg-accent)",
                color: "var(--color-page-bg)",
              }}
            >
              <ScheduleCallIcon />
              Talk to Founder
            </ScheduleCallButton>
          </div>
        </ContentRail>
      </div>
    </section>
  );
}
