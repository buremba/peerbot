import { useState } from "preact/hooks";
import { siClaude, siCursor } from "simple-icons";
import connectorsManifest from "../generated/connectors.json";
import snippetsManifest from "../generated/landing-snippets.json";
import { GITHUB_CONNECTORS_BLOB_URL, GITHUB_EXAMPLES_URL } from "../lib/urls";
import { getLobuBaseUrl } from "../use-case-showcases";
import { CanvasAurora } from "./CanvasAurora";
import { CodeBlock, type CodeSnippet } from "./CodeBlock";
import { CTA } from "./CTA";
import { type LatestBlogPost, LatestBlogPosts } from "./LatestBlogPosts";
import {
  loopForUseCase,
  MemoryLoop,
  ProactiveLoop,
  SALES_LOOP,
} from "./ProactiveLoop";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";

type ExampleEntry = {
  slug: string;
  label: string;
  description: string | null;
  githubUrl: string;
};

type UseCaseSnippets = {
  connector: CodeSnippet;
  memorySchema: CodeSnippet;
  watcher: CodeSnippet;
  agentConfig: CodeSnippet;
  reaction: CodeSnippet | null;
  skill: CodeSnippet | null;
};

type LandingSnippets = {
  connector: CodeSnippet;
  memorySchema: CodeSnippet;
  watcher: CodeSnippet;
  reaction: CodeSnippet;
  agentConfig: CodeSnippet;
  skill: CodeSnippet;
  examples: ExampleEntry[];
  useCases: Record<string, UseCaseSnippets>;
};

const snippets = snippetsManifest as LandingSnippets;

const SETUP_PROMPT = `I want to build a Lobu agent with you. Lobu helps create internal AI teammates: give them a goal, connect company tools, build living memory, and let them collaborate with humans and take approved actions anywhere the team works. Set it up with me end to end.

1. Interview me, one question at a time. Wait for my answer before the next. Don't batch them, don't guess, and don't fake any credentials:
   - What is the agent for? (one sentence)
   - What should we call it? (a short name — used for both the project and the agent)
   - How should it behave, and what may it do on its own? (tone/persona, plus which actions it can take unattended vs. which need my approval)
   - Who uses it: just me, my team, or each of my customers (multi-tenant)?
   - What should it remember? (we'll model this as 1-3 entity types)
   - Where does its data come from? Lobu has built-in connectors for Gmail, GitHub, Google Calendar, Outlook, websites, RSS, Reddit, X, LinkedIn, YouTube, Hacker News, Product Hunt, WhatsApp, Spotify, and more, or you can write a custom connector for any other source (an API, a webhook, a CSV). Tell me the source and I'll map it to a built-in connector or plan a custom one. Pick one to start.
   - Where do people talk to it? (Slack, Web App, Discord, WhatsApp, or MCP)
   - Anything on a schedule? (optional: one watcher, e.g. a daily summary)
   - Which LLM provider key do I have: Anthropic (ANTHROPIC_API_KEY), OpenAI, Gemini, Groq, DeepSeek, Mistral, Z.ai, or another (16 providers supported)?

   When you have my answers, play them back as a short numbered recap and wait for me to confirm or fix them before you scaffold anything.

2. Scaffold it: check my Node is 22-24 or 26+ (only Node 25 is unsupported; help me switch if not), then run npx @lobu/cli@latest init with the name and the provider from above. Postgres is built in, so lobu run starts an embedded one. Don't ask me for a database unless I want an external Postgres (then I set DATABASE_URL). Read the AGENTS.md it writes (your guide to the config API: the define* helpers, connectors, auth, watchers, memory), and read examples/lobu-crm/lobu.config.ts before writing any connection, watcher, or reaction so you match the real field names instead of guessing. Then, before writing config, explain to me in plain terms how Lobu will work for my case: how the connector collects my data incrementally (feeds run on a schedule and only pull what's new since the last run, no re-ingesting), how each item becomes an event that memory turns into the entities above, and how both the watcher and the chat read that memory. Keep it short.

3. Build it from my answers: edit lobu.config.ts plus any connector, reaction, and skill files it needs. For Slack, prefer the hosted Lobu bot: declare the platform with no config (e.g. { type: "slack" }) so I need no bot token; lobu run then prints a /lobu link <code> I redeem by DMing the hosted bot. Only set up a bot token if I explicitly want my own app. Then tell me in one go every secret you'll need (API keys, OAuth client id/secret, bot tokens) and we'll add them to .env together as secret(...) placeholders. Never invent one, and for OAuth sources authorize the account in the admin UI rather than hand-crafting a token.

4. Run and verify: run npx @lobu/cli@latest validate and fix any errors, then boot with npx @lobu/cli@latest run. Send a test message on the channel I chose, trigger the data source manually (don't wait on a poll or cron), and show me the memory event that was written plus the admin UI at http://localhost:8787. If I set up a watcher or an action, exercise that too: run the watcher once, and confirm any action triggers in approval mode rather than firing for real.

Repo: https://github.com/lobu-ai/lobu. Docs: https://lobu.ai/getting-started/`;

// The canonical "test it" command, kept in sync with InstallSection.
const QUICKSTART_CMD = "npx @lobu/cli@latest init my-agent";

export function LandingPage(props: {
  latestPosts?: LatestBlogPost[];
  defaultUseCaseId?: string;
}) {
  // The homepage tells one coherent story (the `sales` example), shown
  // config-first. The /for/<useCase> SEO pages pass defaultUseCaseId to swap
  // the connector / memory / watcher snippets to that use case; the rest stays
  // pinned to sales.
  const activeUseCase = props.defaultUseCaseId ?? "sales";
  const uc = snippets.useCases[activeUseCase];
  const connectorSnippet = uc?.connector ?? snippets.connector;
  const memorySchemaSnippet = uc?.memorySchema ?? snippets.memorySchema;
  const watcherSnippet = uc?.watcher ?? snippets.watcher;
  const agentConfigSnippet = uc?.agentConfig ?? snippets.agentConfig;
  // null means the example for this use case has no reaction / skill. Hide
  // that panel rather than substituting a foreign example's code.
  const reactionSnippet = uc ? uc.reaction : snippets.reaction;
  const skillSnippet = uc ? uc.skill : snippets.skill;

  // The canonical homepage stays benefit-led: hero, one concrete operating
  // loop, then use cases. The /for/<useCase> and /connect-from SEO pages keep
  // the per-primitive code sections, which is their whole purpose.
  const isHome = !props.defaultUseCaseId;

  return (
    <div class="relative w-full">
      <CanvasAurora
        color1={[0.2, 0.35, 0.95]}
        color2={[0.85, 0.15, 0.4]}
        color3={[0.95, 0.6, 0.15]}
        speed={0.35}
        scale={1.2}
        opacity={0.3}
        blur="2px"
        pixelSize={24}
        alignment={[0.15, 0.45]}
        className="absolute inset-x-0 top-0 h-[50rem] w-full pointer-events-none z-0 opacity-50"
      />
      <CanvasAurora
        color1={[0.95, 0.6, 0.15]}
        color2={[0.85, 0.15, 0.4]}
        color3={[0.2, 0.35, 0.95]}
        speed={0.35}
        scale={1.2}
        opacity={0.3}
        blur="2px"
        pixelSize={24}
        alignment={[0.85, 0.45]}
        className="absolute inset-x-0 top-0 h-[50rem] w-full pointer-events-none z-0 opacity-50"
      />
      <Hero />
      {isHome ? (
        <Container className="pt-10 pb-4 sm:pt-14">
          <ProactiveLoop />
        </Container>
      ) : (
        <>
          <Container className="py-14 sm:py-20">
            <MemoryLoop
              data={{
                ...(loopForUseCase(activeUseCase) ?? SALES_LOOP),
                heading: undefined,
              }}
            />
          </Container>
          <UseCaseShowcaseSection
            slug={activeUseCase}
            agentConfig={agentConfigSnippet}
            connector={connectorSnippet}
            memorySchema={memorySchemaSnippet}
            watcher={watcherSnippet}
            reaction={reactionSnippet}
            skill={skillSnippet}
          />
        </>
      )}
      <BrowseExamplesSection />
      <RunAnywhereSection />
      <CTA startUrl={getLobuBaseUrl()} />
      {props.latestPosts?.length ? (
        <LatestBlogPosts posts={props.latestPosts} />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Layout helpers                                                            */
/* -------------------------------------------------------------------------- */

function Container(props: {
  children: preact.ComponentChildren;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={props.id}
      class={`relative mx-auto w-full max-w-[72rem] px-4 sm:px-6 ${props.className ?? ""}`}
    >
      {props.children}
    </section>
  );
}

function Eyebrow(props: { children: preact.ComponentChildren }) {
  return (
    <div
      class="mb-3 font-mono text-[11.5px] font-semibold uppercase tracking-[0.12em]"
      style={{ color: "var(--color-tg-accent)" }}
    >
      {props.children}
    </div>
  );
}

function SectionHeading(props: {
  children: preact.ComponentChildren;
  className?: string;
}) {
  return (
    <h2
      class={`font-display text-[1.85rem] font-bold leading-[1.1] tracking-[-0.005em] sm:text-[2.25rem] ${props.className ?? ""}`}
      style={{ color: "var(--color-page-text)" }}
    >
      {props.children}
    </h2>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                      */
/* -------------------------------------------------------------------------- */

function Hero() {
  // Tracks which of the two copy actions fired last, so each shows its own
  // confirmation: the quickstart command (primary) or the setup prompt (sub).
  const [copied, setCopied] = useState<"cmd" | "prompt" | null>(null);

  const copy = async (which: "cmd" | "prompt") => {
    try {
      await navigator.clipboard.writeText(
        which === "cmd" ? QUICKSTART_CMD : SETUP_PROMPT
      );
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2200);
    } catch {
      setCopied(null);
    }
  };

  return (
    <section class="relative overflow-hidden px-4 pb-12 pt-36 text-center sm:pb-16 sm:pt-44">
      <Container className="relative z-10">
        <h1
          class="hero-rise hero-rise-1 mx-auto max-w-[78rem] font-display text-[clamp(2.25rem,4.15vw,3.25rem)] font-bold leading-[1.06] tracking-[-0.008em]"
          style={{ color: "var(--color-page-text)" }}
        >
          Build AI teammates that{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            watch
          </em>{" "}
          and{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            act
          </em>
        </h1>
        <p
          class="hero-rise hero-rise-2 mx-auto mt-5 max-w-[44rem] text-[17px] leading-[1.55]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Open-source infrastructure for AI teammates that watch, remember, and
          act. Connectors and webhooks build a live org knowledge graph; agents
          look it up and branch into a sandbox to do work.
        </p>
        <div class="hero-rise hero-rise-3 mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            class="inline-flex items-center gap-3 rounded-xl px-5 py-3 text-[14.5px] font-semibold shadow-sm transition-all duration-300 ease-out hover:-translate-y-[2px] hover:scale-[1.02] hover:shadow-[0_8px_24px_rgba(255,255,255,0.15)]"
            onClick={() => copy("prompt")}
            style={{
              backgroundColor: "var(--color-page-text)",
              color: "var(--color-page-bg)",
            }}
            type="button"
          >
            <span class="flex items-center gap-2.5" aria-hidden="true">
              <ClaudeMark />
              <ChatGptMark />
              <CursorMark />
              <OpenCodeMark />
            </span>
            <span>
              {copied === "prompt"
                ? "Copied, paste into your agent"
                : "Copy setup prompt"}
            </span>
          </button>
          <ScheduleCallButton
            class="inline-flex items-center gap-2 rounded-xl border px-5 py-3 text-[14.5px] font-semibold transition-all duration-300 ease-out hover:-translate-y-[2px] hover:scale-[1.02] hover:bg-[var(--color-page-border)] hover:shadow-[0_8px_20px_rgba(0,0,0,0.3)]"
            style={{
              borderColor: "var(--color-page-border)",
              color: "var(--color-page-text)",
              backgroundColor: "var(--color-page-surface)",
            }}
          >
            <ScheduleCallIcon />
            Talk to the founder
          </ScheduleCallButton>
        </div>
        <p
          class="hero-rise hero-rise-4 mt-3.5 text-[13px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Paste into your coding agent to scaffold a project.
        </p>
        <p
          class="hero-rise hero-rise-4 mt-2.5 flex flex-wrap items-center justify-center gap-2 text-[13px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Or start it yourself:
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[12.5px] transition-colors hover:border-[color:var(--color-tg-accent)]"
            onClick={() => copy("cmd")}
            style={{
              borderColor: "var(--color-page-border)",
              color: "var(--color-page-text)",
            }}
          >
            <span style={{ opacity: 0.5 }}>$</span>
            {QUICKSTART_CMD}
            <CopyIcon copied={copied === "cmd"} />
          </button>
          {copied === "cmd" ? <span>copied</span> : null}
        </p>
      </Container>
    </section>
  );
}

function ClaudeMark() {
  return (
    <svg
      aria-hidden="true"
      class="h-[18px] w-[18px] shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Claude</title>
      <path d={siClaude.path} />
    </svg>
  );
}

/* Official OpenAI mark (ChatGPT / Codex) — not in simple-icons, so the
   canonical single-path SVG is inlined. Rendered with currentColor. */
function ChatGptMark() {
  return (
    <svg
      aria-hidden="true"
      class="h-[18px] w-[18px] shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>ChatGPT</title>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7800 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7852 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.869l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0804L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function CursorMark() {
  return (
    <svg
      aria-hidden="true"
      class="h-[18px] w-[18px] shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Cursor</title>
      <path d={siCursor.path} />
    </svg>
  );
}

/* OpenCode has no brand mark in simple-icons; a clean </> glyph stands in. */
function OpenCodeMark() {
  return (
    <svg
      aria-hidden="true"
      class="h-[17px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2.4"
      viewBox="0 0 24 24"
    >
      <title>OpenCode</title>
      <polyline points="9 8 4 12 9 16" />
      <polyline points="15 8 20 12 15 16" />
    </svg>
  );
}

function CopyIcon(props: { copied: boolean }) {
  return props.copied ? (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Static sections                                                           */
/* -------------------------------------------------------------------------- */

// The 6 examples that have a richer /for/<slug> landing page. Other examples
// (lobu-crm, office-bot, atlas, etc.) still ship in the repo and are reachable
// via the "Browse all examples" link below.
const FEATURED_EXAMPLE_SLUGS = [
  "sales",
  "legal",
  "finance",
  "leadership",
  "market",
  "agent-community",
] as const;

const SHADER_PALETTES: Array<{
  color1: [number, number, number];
  color2: [number, number, number];
  color3: [number, number, number];
}> = [
  {
    color1: [0.1, 0.6, 0.8], // Cyan/Teal
    color2: [0.2, 0.3, 0.95], // Deep Blue
    color3: [0.5, 0.1, 0.85], // Violet
  },
  {
    color1: [0.1, 0.8, 0.4], // Emerald
    color2: [0.1, 0.5, 0.8], // Teal/Blue
    color3: [0.9, 0.6, 0.1], // Orange/Gold
  },
  {
    color1: [0.85, 0.15, 0.4], // Magenta
    color2: [0.5, 0.1, 0.85], // Violet
    color3: [0.2, 0.3, 0.95], // Deep Blue
  },
  {
    color1: [0.95, 0.3, 0.15], // Red-Orange
    color2: [0.95, 0.6, 0.15], // Orange-Gold
    color3: [0.85, 0.15, 0.7], // Pink/Rose
  },
];

function BrowseExamplesSection() {
  const bySlug = new Map(snippets.examples.map((ex) => [ex.slug, ex]));
  const featured = FEATURED_EXAMPLE_SLUGS.map((slug) =>
    bySlug.get(slug)
  ).filter((ex): ex is ExampleEntry => Boolean(ex));
  return (
    <section class="py-16">
      <Container>
        <div class="mb-10 text-center">
          <Eyebrow>Examples</Eyebrow>
          <SectionHeading className="mx-auto">
            Explore agent workflows.
          </SectionHeading>
          <p
            class="mx-auto mt-3 max-w-[42rem] text-[14.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Each example shows the sources, memory, and actions for one AI
            teammate.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {featured.map((ex) => (
            <a
              class="relative overflow-hidden group flex flex-col rounded-lg p-4 transition-colors"
              href={`/for/${ex.slug}`}
              key={ex.slug}
              style={{
                backgroundColor: "var(--color-page-surface)",
              }}
            >
              <span
                class="relative z-10 mb-2 text-[14px] font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                {ex.label}
              </span>
              {ex.description ? (
                <span
                  class="relative z-10 text-[13px] leading-[1.5]"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {ex.description}
                </span>
              ) : null}
            </a>
          ))}
        </div>
        <div class="mt-8 text-center">
          <a
            class="inline-flex items-center gap-1 text-[13.5px] transition-colors hover:text-[color:var(--color-tg-accent)]"
            href={GITHUB_EXAMPLES_URL}
            rel="noopener noreferrer"
            style={{ color: "var(--color-page-text-muted)" }}
            target="_blank"
          >
            Browse all {snippets.examples.length} examples on GitHub →
          </a>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Product sections (Connectors / Memory / Watchers / Agents)               */
/* -------------------------------------------------------------------------- */

/** Small footer link rendered under each section's code panel, linking to the
 *  full example on GitHub. Matches the ProductLink monospace-path treatment. */
function ExampleFooterLink({ slug }: { slug: string }) {
  return (
    <a
      class="mt-3 inline-flex items-center gap-1 text-[13px] transition-colors hover:text-[color:var(--color-tg-accent)]"
      href={`${GITHUB_EXAMPLES_URL}/${slug}`}
      rel="noopener noreferrer"
      style={{ color: "var(--color-page-text-muted)" }}
      target="_blank"
    >
      Full example:{" "}
      <code
        class="font-mono text-[13px]"
        style={{ color: "var(--color-page-text)" }}
      >
        examples/{slug}
      </code>
      <span aria-hidden="true">→</span>
    </a>
  );
}

function ProductLink(props: {
  href: string;
  children: preact.ComponentChildren;
}) {
  return (
    <a
      class="border-b pb-0.5 text-[14px] font-semibold transition-colors hover:text-[color:var(--color-tg-accent)] hover:border-[color:var(--color-tg-accent)]"
      href={props.href}
      style={{
        color: "var(--color-page-text)",
        borderColor: "var(--color-page-border)",
      }}
    >
      {props.children} →
    </a>
  );
}

// Renders every built-in connector as a chip linking to its source file.
// The list is generated from packages/connectors by scripts/gen-connectors.ts,
// so adding a connector surfaces it here automatically.
function ConnectorChips() {
  return (
    <div class="mt-6">
      <div
        class="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Built-in connectors
      </div>
      <div class="flex flex-wrap gap-2">
        {connectorsManifest.map((c) => (
          <a
            key={c.key}
            href={`${GITHUB_CONNECTORS_BLOB_URL}/${c.file}`}
            target="_blank"
            rel="noreferrer"
            class="flex h-11 w-11 items-center justify-center rounded-lg border transition-colors hover:border-[color:var(--color-tg-accent)] hover:text-[color:var(--color-tg-accent)]"
            style={{
              borderColor: "var(--color-page-border)",
              backgroundColor: "var(--color-page-bg)",
              color: "var(--color-page-text)",
            }}
            title={`${c.name} connector`}
            aria-label={`${c.name} connector source`}
          >
            {c.iconPath ? (
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d={c.iconPath} fill="currentColor" />
              </svg>
            ) : (
              <span class="font-mono text-[13px] font-semibold">
                {c.name.charAt(0)}
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Use-case showcase: the four/five product primitives as collapsed tabs.    */
/*  Each tab card shows a compact pitch; clicking one reveals its code panel  */
/*  below at full width. Skills tab is omitted when the active use case's     */
/*  example has no SKILL.md.                                                  */
/* -------------------------------------------------------------------------- */

type ShowcaseTab = {
  id: string;
  eyebrow: string;
  blurb: string;
  primary: { snippet: CodeSnippet; badge: string };
  secondary?: {
    snippet: CodeSnippet;
    badge: string;
    intro: string;
  };
  docHref: string;
  docLabel: string;
  showConnectorChips?: boolean;
};

function UseCaseShowcaseSection({
  slug,
  agentConfig,
  connector,
  memorySchema,
  watcher,
  reaction,
  skill,
}: {
  slug: string;
  agentConfig: CodeSnippet;
  connector: CodeSnippet;
  memorySchema: CodeSnippet;
  watcher: CodeSnippet;
  reaction: CodeSnippet | null;
  skill: CodeSnippet | null;
}) {
  const tabs: ShowcaseTab[] = [
    {
      id: "config",
      eyebrow: "lobu.config.ts",
      blurb: "Declare the agent, sources, memory, and skills in one file.",
      primary: {
        snippet: agentConfig,
        badge: "lobu.config.ts",
      },
      docHref: "/getting-started/",
      docLabel: "Agents guide",
    },
    {
      id: "connectors",
      eyebrow: "Connectors",
      blurb: "Use built-ins, MCP, webhooks, or custom connector code.",
      primary: {
        snippet: connector,
        badge: "typescript",
      },
      docHref: "/getting-started/connector-sdk/",
      docLabel: "Connector SDK docs",
      showConnectorChips: true,
    },
    {
      id: "memory",
      eyebrow: "Memory",
      blurb: "Shared records your team can inspect, edit, and reuse.",
      primary: {
        snippet: memorySchema,
        badge: "entities",
      },
      docHref: "/getting-started/memory/",
      docLabel: "Memory guide",
    },
    {
      id: "watchers",
      eyebrow: "Watchers",
      blurb: "Tell Lobu what to watch. Agents keep memory current.",
      primary: {
        snippet: watcher,
        badge: "reactive + dreaming",
      },
      secondary: reaction
        ? {
            snippet: reaction,
            badge: "optional · typescript",
            intro: "Reactions run code when memory changes:",
          }
        : undefined,
      docHref: "/getting-started/memory/",
      docLabel: "Watchers guide",
    },
  ];
  if (skill) {
    tabs.push({
      id: "skills",
      eyebrow: "Skills",
      blurb: "Instructions, tools, packages, and network policy in one folder.",
      primary: { snippet: skill, badge: "skill" },
      docHref: "/getting-started/",
      docLabel: "Skills guide",
    });
  }

  const [activeId, setActiveId] = useState<string | null>(tabs[0].id);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <Container className="py-16 sm:py-20">
      <div class="mb-8 text-center">
        <Eyebrow>For engineers</Eyebrow>
        <SectionHeading className="mx-auto">
          The whole agent, in code.
        </SectionHeading>
        <p
          class="mx-auto mt-3 max-w-[44rem] text-[15px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          One project defines it end to end: the agent, its connectors, the
          memory schema, watchers, and skills. Write it yourself, or let your
          coding agent generate it. Pick a piece to read the code.
        </p>
      </div>

      <div
        class={`grid gap-3 sm:grid-cols-2 ${tabs.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}
      >
        {tabs.map((tab) => {
          const isOpen = active?.id === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveId(isOpen ? null : tab.id)}
              aria-expanded={isOpen}
              class="flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:border-[color:var(--color-tg-accent)]"
              style={{
                borderColor: isOpen
                  ? "var(--color-tg-accent)"
                  : "var(--color-page-border)",
                backgroundColor: "var(--color-page-surface)",
                cursor: "pointer",
              }}
            >
              <span
                class="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: "var(--color-tg-accent)" }}
              >
                {tab.eyebrow}
              </span>
              <span
                class="text-[13.5px] leading-[1.45]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {tab.blurb}
              </span>
              <span
                class="mt-1 text-[12px] font-semibold"
                style={{ color: "var(--color-tg-accent)" }}
              >
                {isOpen ? "hide code ▾" : "show code ▸"}
              </span>
            </button>
          );
        })}
      </div>

      {active ? (
        <div class="mt-6 space-y-4">
          <CodeBlock
            badge={active.primary.badge}
            snippet={active.primary.snippet}
          />
          {active.secondary ? (
            <>
              <p
                class="text-[13px]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {active.secondary.intro}
              </p>
              <CodeBlock
                badge={active.secondary.badge}
                snippet={active.secondary.snippet}
              />
            </>
          ) : null}
          <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            <ProductLink href={active.docHref}>{active.docLabel}</ProductLink>
            <ExampleFooterLink slug={slug} />
          </div>
          {active.showConnectorChips ? <ConnectorChips /> : null}
        </div>
      ) : null}
    </Container>
  );
}

/* -------------------------------------------------------------------------- */
/*  Run anywhere                                                              */
/* -------------------------------------------------------------------------- */

function RunAnywhereSection() {
  const cards: Array<{
    eyebrow: string;
    title: string;
    body: preact.ComponentChildren;
    links: Array<{ label: string; href: string }>;
  }> = [
    {
      eyebrow: "Local",
      title: "Run on your laptop.",
      body: "Boot the gateway, workers, memory, and embeddings with one command.",
      links: [{ label: "Quickstart", href: "/getting-started/" }],
    },
    {
      eyebrow: "Self-host",
      title: "Run in your cloud.",
      body: "Docker, cloud VM, or Kubernetes when data and controls need to stay with you.",
      links: [
        { label: "Deployment docs", href: "/deployment/docker/" },
        { label: "Cloud", href: "/deployment/cloud/" },
        { label: "Kubernetes", href: "/deployment/kubernetes/" },
      ],
    },
    {
      eyebrow: "Lobu Cloud",
      title: "Let Lobu run it.",
      body: "Use the same project with managed isolation, secrets, and upgrades.",
      links: [{ label: "Lobu Cloud", href: "/deployment/cloud/" }],
    },
  ];
  return (
    <Container className="py-16 sm:py-20">
      <div class="mb-10 text-center">
        <Eyebrow>Run anywhere</Eyebrow>
        <SectionHeading className="mx-auto">
          Local, self-hosted, or managed.
        </SectionHeading>
      </div>
      <div class="grid gap-6 md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.title}
            class="relative overflow-hidden group flex min-w-0 flex-col rounded-lg p-6"
            style={{
              backgroundColor: "var(--color-page-surface)",
            }}
          >
            <div class="relative z-10 flex flex-col h-full">
              <Eyebrow>{card.eyebrow}</Eyebrow>
              <h3
                class="mb-2 text-[1.05rem] font-bold tracking-normal"
                style={{ color: "var(--color-page-text)" }}
              >
                {card.title}
              </h3>
              <p
                class="text-[14.5px] leading-[1.55]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {card.body}
              </p>
              <div class="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-4">
                {card.links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    class="inline-flex items-center gap-1 font-mono text-[12px] text-[color:var(--color-page-text-muted)] transition-colors hover:text-[color:var(--color-tg-accent)]"
                  >
                    {link.label}
                    <span aria-hidden="true">↗</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Container>
  );
}
