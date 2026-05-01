import { useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getOwlettoBaseUrl,
  getOwlettoUrl,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { ArchitectureSection } from "./ArchitectureSection";
import { CTA } from "./CTA";
import { DataModelSection } from "./DataModelSection";
import { FeatureBlock } from "./FeatureBlock";
import {
  HostingGraphic,
  LogoStrip,
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
    ? getOwlettoUrl(activeUseCaseId)
    : getOwlettoBaseUrl();

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

      <LogoStrip />

      <SectionCornerLabels
        index={1}
        leftLabel="Memory"
        rightLabel="Agents ↔ Recall"
        id="memory"
      >
        <FeatureBlock
          eyebrow="Shared memory for every agent"
          title="Turn data into shared, structured memory."
          description="Tell one agent something and the rest already know. Lobu Memory gives every agent the same typed entities and event history, recalled through MCP when it matters."
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
          eyebrow="Drop in, ready to work"
          title="Give your agent new capabilities."
          description="A skill bundles everything an agent needs to do something: instructions, tools, and access, all in one folder. No glue code, no IT ticket. Drop it in and the agent picks it up."
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
          eyebrow="Working while you're away"
          title="Turn schedules into agents that act on their own."
          description="A watcher wakes on a schedule, reads recent activity, filters with a prompt you wrote, and writes the signal (not the noise) into entity memory. The agent isn't online, but the memory is moving."
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
          eyebrow="Built into your tools"
          title="Talk to your agents from any chat or AI client."
          description="Lobu agents live where your team already works: Slack, Telegram, Discord, Teams, WhatsApp, Google Chat. Or pull them into ChatGPT, Claude, Cursor, and any MCP-capable client over the same protocol."
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
          title="You own your data."
          description="Run open-source Lobu on your own servers for full control over your data and credentials, or use our managed runtime. With per-second billing you only pay for the time your agents are awake."
          ctaLabel="Self-host guide"
          ctaHref="/getting-started/"
          graphic={<HostingGraphic />}
        />
      </SectionCornerLabels>

      <ArchitectureSection activeUseCaseId={activeUseCaseId} />

      <div class="py-20" id="data-model">
        <DataModelSection />
      </div>

      <CTA startUrl={startUrl} />

      {props.latestPosts?.length ? (
        <LatestBlogPosts posts={props.latestPosts} />
      ) : null}
    </>
  );
}
