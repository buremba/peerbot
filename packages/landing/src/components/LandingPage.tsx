import { useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { ArchitectureSection } from "./ArchitectureSection";
import { CTA } from "./CTA";
import { DemoSection } from "./DemoSection";
import { HeroSection } from "./HeroSection";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";

export function LandingPage(props: {
  defaultUseCaseId?: LandingUseCaseId;
  linkTabsToCampaigns?: boolean;
  heroCopy?: SurfaceHeroCopy;
  latestPosts?: LatestBlogPost[];
}) {
  const [activeUseCaseId, setActiveUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const useScopedOwlettoUrl = Boolean(props.heroCopy);

  return (
    <>
      <HeroSection
        activeUseCaseId={activeUseCaseId}
        onActiveUseCaseChange={setActiveUseCaseId}
        linkTabsToCampaigns={props.linkTabsToCampaigns}
        heroCopy={props.heroCopy}
        useScopedOwlettoUrl={useScopedOwlettoUrl}
      />
      <DemoSection
        activeUseCaseId={activeUseCaseId}
        onActiveUseCaseChange={setActiveUseCaseId}
        showTabs={false}
        linkTabsToCampaigns={props.linkTabsToCampaigns}
      />
      <div class="hidden md:block">
        <div class="section-divider" />
        <ArchitectureSection activeUseCaseId={activeUseCaseId} />
        <div class="section-divider" />
      </div>
      {props.latestPosts?.length ? (
        <>
          <div class="section-divider" />
          <LatestBlogPosts posts={props.latestPosts} />
        </>
      ) : null}
      <CTA
        activeUseCaseId={activeUseCaseId}
        useScopedOwlettoUrl={useScopedOwlettoUrl}
      />
    </>
  );
}
