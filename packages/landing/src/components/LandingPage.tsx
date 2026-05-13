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
import { DataModelSection } from "./DataModelSection";
import { FeatureBlock } from "./FeatureBlock";
import {
  HostingGraphic,
  PlatformsGraphic,
  SharedMemoryGraphic,
  SkillsGraphic,
  WatcherGraphic,
} from "./FeatureGraphics";
import { HeroProductCard } from "./HeroProductCard";
import { HeroSection, type HeroStageId } from "./HeroSection";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";
import { SectionCornerLabels } from "./SectionCornerLabels";

export function LandingPage(props: {
  defaultUseCaseId?: LandingUseCaseId;
  linkTabsToCampaigns?: boolean;
  heroCopy?: SurfaceHeroCopy;
  latestPosts?: LatestBlogPost[];
}) {
  const [activeUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const [activeStage, setActiveStage] = useState<HeroStageId>("model");
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

      {/* <LogoStrip /> */}

      <SectionCornerLabels
        index={1}
        leftLabel="Memory"
        rightLabel="Agents ↔ Recall"
        id="memory"
      >
        <FeatureBlock
          eyebrow="Shared org memory"
          title="Give agents the same source-backed context."
          description="Connect sources once. Lobu turns them into typed memory that agents can search, cite, and reuse across users."
          ctaLabel="Read the memory guide"
          ctaHref="/getting-started/memory/"
          graphic={<SharedMemoryGraphic />}
        />
      </SectionCornerLabels>

      <SectionCornerLabels
        index={2}
        leftLabel="Skills"
        rightLabel="Capability ↔ Bundle"
        id="skills"
      >
        <FeatureBlock
          eyebrow="Capabilities"
          title="Add tools without glue code."
          description="Skills bundle instructions, tools, packages, and network access so agents can pick up new workflows safely."
          ctaLabel="Explore skills"
          ctaHref="/getting-started/skills/"
          graphic={<SkillsGraphic />}
          reverse
        />
      </SectionCornerLabels>

      <SectionCornerLabels
        index={3}
        leftLabel="Autonomous"
        rightLabel="Watchers ↔ Memory"
        id="autonomous"
      >
        <FeatureBlock
          eyebrow="Watchers"
          title="Turn recurring work into reports and memory."
          description="Watchers read new activity on a schedule, extract the signal, and write source-backed updates your agents can use."
          ctaLabel="How watchers work"
          ctaHref="/getting-started/memory/#watchers"
          graphic={<WatcherGraphic />}
        />
      </SectionCornerLabels>

      <SectionCornerLabels
        index={4}
        leftLabel="Available everywhere"
        rightLabel="Chat ↔ MCP"
        id="platforms"
      >
        <FeatureBlock
          eyebrow="Multi-user delivery"
          title="Reach agents from chat, apps, and MCP clients."
          description="Route Slack, Telegram, REST, OpenClaw, ChatGPT, Claude, and other MCP clients through the same org-scoped backend."
          ctaLabel="Connect via MCP"
          ctaHref="/mcp/"
          graphic={<PlatformsGraphic />}
          reverse
        />
      </SectionCornerLabels>

      <SectionCornerLabels
        index={5}
        leftLabel="Own your data"
        rightLabel="Self-host ↔ Managed"
        id="hosting"
      >
        <FeatureBlock
          eyebrow="Self-host or managed"
          title="Keep data and credentials under control."
          description="Run the open-source engine on your infrastructure or use Lobu Cloud. Workers stay isolated and never receive raw secrets."
          ctaLabel="Self-host guide"
          ctaHref="/getting-started/"
          graphic={<HostingGraphic />}
        />
      </SectionCornerLabels>

      <ArchitectureSection activeUseCaseId={activeUseCaseId} />

      <div class="py-20" id="data-model">
        <DataModelSection useCaseId={activeUseCaseId} />
      </div>

      <CTA startUrl={startUrl} />

      {props.latestPosts?.length ? (
        <LatestBlogPosts posts={props.latestPosts} />
      ) : null}
    </>
  );
}
