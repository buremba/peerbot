import type { LandingUseCaseId } from "../use-case-definitions";
import {
  getLandingPrompt,
  getLandingUseCaseShowcase,
  getOwlettoUrl,
  landingUseCaseGroupedOptions,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { CopyPromptButton } from "./CopyPromptButton";
import { HighlightedText } from "./HighlightedText";
import { ScopedUseCaseTabs } from "./ScopedUseCaseTabs";

const SecondaryCtaIcon = ({ external }: { external: boolean }) =>
  external ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  ) : (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

export function HeroSection(props: {
  activeUseCaseId?: LandingUseCaseId;
  onActiveUseCaseChange?: (id: LandingUseCaseId) => void;
  linkTabsToCampaigns?: boolean;
  heroCopy?: SurfaceHeroCopy;
  useScopedOwlettoUrl?: boolean;
}) {
  const activeUseCase = getLandingUseCaseShowcase(props.activeUseCaseId);
  const memoryHref = `/memory/for/${activeUseCase.id}`;
  const skillsHref = `/skills/for/${activeUseCase.id}`;
  const owlettoUrl = getOwlettoUrl(
    props.useScopedOwlettoUrl ? activeUseCase.id : undefined
  );
  const primaryCtaLabel = props.heroCopy
    ? `Try the ${activeUseCase.label} demo`
    : "Try it live";

  return (
    <section class="pt-24 pb-4 px-8 relative">
      <div class="max-w-5xl mx-auto text-center relative">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-2 text-xs font-semibold tracking-wider uppercase px-3 py-1 mb-5 rounded-full transition-all hover:opacity-80"
          style={{
            color: "var(--color-page-text-muted)",
            border: "1px solid var(--color-page-border)",
          }}
        >
          Open source · Self-hosted
        </a>
        <h1
          class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5"
          style={{ color: "var(--color-page-text)" }}
        >
          <HighlightedText
            text="AI agents that remember everything"
            highlight="remember everything"
          />
        </h1>
        {props.heroCopy ? (
          <p
            class="text-lg mx-auto mb-4 leading-relaxed max-w-3xl"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {props.heroCopy.description}
          </p>
        ) : (
          <p
            class="text-lg mx-auto mb-4 leading-relaxed max-w-3xl"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Pre-built agents for team ops, personal memory, and community
            workflows — fork one, wire it to your tools, let it run.
          </p>
        )}
        {/* CTA buttons */}
        <div class="flex flex-wrap gap-3 mb-6 justify-center items-center">
          <a
            href={owlettoUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
            style={{
              backgroundColor: "var(--color-page-text)",
              color: "var(--color-page-bg)",
            }}
          >
            {primaryCtaLabel}
          </a>
          {props.heroCopy ? (
            <a
              href={`${GITHUB_URL}/tree/main/examples/${activeUseCase.examplePath}`}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 text-sm font-medium px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
              style={{
                color: "var(--color-page-text-muted)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <SecondaryCtaIcon external />
              View source on GitHub
            </a>
          ) : (
            <CopyPromptButton
              prompt={getLandingPrompt(activeUseCase)}
              label="Copy prompt to your agent"
              variant="outline-muted"
              supportedClients={["chatgpt", "openclaw", "claude", "mcp-client"]}
            />
          )}
        </div>

        <div class="mt-8 mb-6">
          <ScopedUseCaseTabs
            groups={landingUseCaseGroupedOptions}
            activeId={activeUseCase.id}
            onSelect={
              props.linkTabsToCampaigns
                ? undefined
                : (id) => props.onActiveUseCaseChange?.(id as LandingUseCaseId)
            }
            hrefForId={
              props.linkTabsToCampaigns ? (id) => `/for/${id}` : undefined
            }
          />
        </div>
      </div>
    </section>
  );
}
