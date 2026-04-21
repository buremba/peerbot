import type { LandingUseCaseId } from "../use-case-definitions";
import { getOwlettoUrl } from "../use-case-showcases";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";

export function CTA(props: {
  activeUseCaseId?: LandingUseCaseId;
  useScopedOwlettoUrl?: boolean;
}) {
  const owlettoUrl = getOwlettoUrl(
    props.useScopedOwlettoUrl ? props.activeUseCaseId : undefined
  );
  const skillsHref = props.activeUseCaseId
    ? `/skills/for/${props.activeUseCaseId}`
    : "/skills";

  return (
    <section class="py-14 px-8 text-center">
      <div class="max-w-2xl mx-auto">
        <h2
          class="text-2xl sm:text-3xl font-bold mb-3 tracking-tight"
          style={{ color: "var(--color-page-text)" }}
        >
          Two ways to see it run.
        </h2>
        <p
          class="text-sm mb-8"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Click through a live workspace, or book 20 minutes with the founder.
        </p>
        <div class="flex flex-wrap justify-center gap-3 mb-8">
          <a
            href={owlettoUrl}
            class="inline-flex items-center gap-2 text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:opacity-90"
            style={{
              backgroundColor: "var(--color-page-text)",
              color: "var(--color-page-bg)",
            }}
          >
            Open live workspace
          </a>
          <ScheduleCallButton
            class="inline-flex items-center gap-2 text-sm font-medium px-6 py-3 rounded-lg transition-all hover:opacity-90"
            style={{
              backgroundColor: "var(--color-page-surface)",
              color: "var(--color-page-text)",
              border: "1px solid var(--color-page-border-active)",
            }}
          >
            <ScheduleCallIcon />
            Talk to Founder
          </ScheduleCallButton>
        </div>

        {/* Quick links */}
        <div
          class="flex flex-wrap items-center gap-4 text-xs justify-center"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <a
            href={skillsHref}
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Browse Skills
          </a>
          <span style={{ opacity: 0.3 }}>|</span>
          <a
            href="/deployment/docker/"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Self-host Docs
          </a>
          <span style={{ opacity: 0.3 }}>|</span>
          <a
            href="/platforms/rest-api/"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Embed
          </a>
          <span style={{ opacity: 0.3 }}>|</span>
          <a
            href="/getting-started/"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Docs
          </a>
        </div>
      </div>
    </section>
  );
}
