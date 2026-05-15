import { useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLobuBaseUrl,
  getLobuUrl,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { ArchitectureSection } from "./ArchitectureSection";
import { CTA } from "./CTA";
import { FeatureBlock } from "./FeatureBlock";
import { SharedMemoryGraphic, SkillsGraphic } from "./FeatureGraphics";
import { HeroProductCard } from "./HeroProductCard";
import { HeroSection, type HeroStageId } from "./HeroSection";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";

export function LandingPage(props: {
  defaultUseCaseId?: LandingUseCaseId;
  heroCopy?: SurfaceHeroCopy;
  latestPosts?: LatestBlogPost[];
}) {
  const [activeUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const [activeStage, setActiveStage] = useState<HeroStageId>("integrate");
  const [autoAdvance, setAutoAdvance] = useState(true);
  const startUrl = props.defaultUseCaseId
    ? getLobuUrl(activeUseCaseId)
    : getLobuBaseUrl();

  const handleStageChange = (id: HeroStageId) => {
    setAutoAdvance(false);
    setActiveStage(id);
  };

  return (
    <>
      <HeroSection
        activeUseCaseId={activeUseCaseId}
        activeStage={activeStage}
        onActiveStageChange={setActiveStage}
        autoAdvance={autoAdvance}
        onStopAutoAdvance={() => setAutoAdvance(false)}
        heroCopy={props.heroCopy}
        startUrl={startUrl}
      />

      <section class="px-4 sm:px-6 pt-2 pb-12">
        <HeroProductCard
          stage={activeStage}
          onStageChange={handleStageChange}
          useCaseId={activeUseCaseId}
        />
      </section>

      <section
        id="memory"
        class="relative px-4 sm:px-6 max-w-[72rem] mx-auto pt-10"
      >
        <FeatureBlock
          eyebrow="Memory"
          title="Source-backed context, kept fresh."
          description="Connect a source once. Lobu types it into memory agents can search and cite. Watchers refresh it on schedule."
          ctaLabel="Read the memory guide"
          ctaHref="/getting-started/memory/"
          graphic={<SharedMemoryGraphic />}
        />
      </section>

      <section
        id="skills"
        class="relative px-4 sm:px-6 max-w-[72rem] mx-auto pt-10"
      >
        <FeatureBlock
          eyebrow="Skills"
          title="One agent, every surface."
          description="Bundle tools, packages, and network access into a skill. The same agent runs in Slack, Telegram, REST, MCP, and ChatGPT — no per-platform plumbing."
          ctaLabel="Explore skills"
          ctaHref="/getting-started/skills/"
          graphic={<SkillsGraphic />}
          reverse
        />
      </section>

      <ArchitectureSection activeUseCaseId={activeUseCaseId} />

      <CTA startUrl={startUrl} />

      {props.latestPosts?.length ? (
        <LatestBlogPosts posts={props.latestPosts} />
      ) : null}
    </>
  );
}
