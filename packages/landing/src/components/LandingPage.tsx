import { useState } from "preact/hooks";
import connectorsManifest from "../generated/connectors.json";
import snippetsManifest from "../generated/landing-snippets.json";
import { GITHUB_CONNECTORS_BLOB_URL, GITHUB_EXAMPLES_URL } from "../lib/urls";
import { getLobuBaseUrl } from "../use-case-showcases";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { CodeBlock, type CodeSnippet } from "./CodeBlock";
import { CTA } from "./CTA";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";
import { ProactiveLoop } from "./ProactiveLoop";
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

const SETUP_PROMPT = `I want to build a Lobu agent with you. Lobu is an open-source, event-sourced backend for AI agents: connectors emit events, memory keeps a structured knowledge graph, and agents react in real time and run on a schedule. Set it up with me end to end.

1. Interview me, one question at a time. Wait for my answer before the next. Don't batch them, don't guess, and don't fake any credentials:
   - What is the agent for? (one sentence)
   - Who uses it: just me, my team, or each of my customers (multi-tenant)?
   - What should it remember? (we'll model this as 1-3 entity types)
   - Where does its data come from? Lobu has built-in connectors for Slack, Gmail, GitHub, Google Calendar, Outlook, websites, RSS, Reddit, X, LinkedIn, YouTube, Hacker News, Product Hunt, and more — or you can write a custom connector for any other source (an API, a webhook, a CSV). Tell me the source and I'll map it to a built-in connector or plan a custom one. Pick one to start.
   - Where do people talk to it? (Slack, Telegram, Discord, WhatsApp, web/HTTP, or MCP)
   - Anything on a schedule? (optional: one watcher, e.g. a daily summary)
   - Which LLM provider key do I have: Anthropic, OpenAI, or Z.ai?

2. Scaffold it: check my Node is 22-24 (Lobu rejects 25+; help me switch if not), then run npx @lobu/cli@latest init with the name and the provider from above. Postgres is built in — lobu run starts an embedded one, so don't ask me for a database unless I want an external Postgres (then I set DATABASE_URL). Read the AGENTS.md it writes (your guide to the config API: the define* helpers, connectors, auth, watchers, memory), and read examples/lobu-crm/lobu.config.ts before writing any connection, watcher, or reaction so you match the real field names instead of guessing. Then, before writing config, explain to me in plain terms how Lobu will work for my case: how the connector collects my data incrementally (feeds run on a schedule and only pull what's new since the last run — no re-ingesting), how each item becomes an event that memory turns into the entities above, and how both the watcher and the chat read that memory. Keep it short.

3. Build it from my answers: edit lobu.config.ts plus any connector, reaction, and skill files it needs. Then tell me in one go every secret you'll need (API keys, OAuth client id/secret, bot tokens) and we'll add them to .env together as secret(...) placeholders. Never invent one, and for OAuth sources authorize the account in the admin UI rather than hand-crafting a token.

4. Run and verify: run npx @lobu/cli@latest validate and fix any errors, then boot with npx @lobu/cli@latest run. Send a test message on the channel I chose, trigger the data source manually (don't wait on a poll or cron), and show me the memory event that was written plus the admin UI at http://localhost:8787.

Repo: https://github.com/lobu-ai/lobu. Docs: https://lobu.ai/docs/`;

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
  // null means the example for this use case has no reaction / skill — hide
  // that panel rather than substituting a foreign example's code.
  const reactionSnippet = uc ? uc.reaction : snippets.reaction;
  const skillSnippet = uc ? uc.skill : snippets.skill;

  // The canonical homepage stays benefit-led: outcome artifact + a plain
  // 3-step explanation, with the deep code living in the docs. The
  // /for/<useCase> and /connect-from SEO pages keep the per-primitive code
  // sections, which is their whole purpose.
  const isHome = !props.defaultUseCaseId;

  return (
    <>
      <Hero />
      {isHome ? (
        <>
          <Container className="pt-10 pb-4 sm:pt-14">
            <ProactiveLoop />
          </Container>
          <HowItWorks />
        </>
      ) : (
        <>
          <Container className="py-14 sm:py-20">
            <ArchitectureDiagram slug={activeUseCase} />
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
    </>
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
      class={`font-display text-[1.85rem] font-bold leading-[1.1] tracking-tight sm:text-[2.25rem] ${props.className ?? ""}`}
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
    <section class="px-4 pb-12 pt-20 text-center sm:pb-16 sm:pt-28">
      <Container>
        <h1
          class="hero-rise hero-rise-1 mx-auto max-w-[58rem] font-display text-[clamp(2.25rem,4.8vw,3.5rem)] font-bold leading-[1.06] tracking-[-0.028em]"
          style={{ color: "var(--color-page-text)" }}
        >
          Build{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            proactive
          </em>{" "}
          AI agents on a graph
          <br />
          that{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            builds itself
          </em>
        </h1>
        <p
          class="hero-rise hero-rise-2 mx-auto mt-5 max-w-[44rem] text-[17px] leading-[1.55]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Connect your company's data in real time, plug in your model, and let
          your agents act the moment something changes, as a bot, an API, or
          another agent.
        </p>
        <div class="hero-rise hero-rise-3 mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            class="inline-flex items-center gap-2 rounded-lg px-5 py-3 text-[14.5px] font-semibold transition-transform hover:-translate-y-px"
            onClick={() => copy("prompt")}
            style={{
              backgroundColor: "var(--color-page-text)",
              color: "var(--color-page-bg)",
            }}
            type="button"
          >
            <CopyIcon copied={copied === "prompt"} />
            <span>
              {copied === "prompt"
                ? "Copied, paste into your agent"
                : "Copy setup prompt"}
            </span>
          </button>
          <ScheduleCallButton
            class="inline-flex items-center gap-2 rounded-lg border px-5 py-3 text-[14.5px] font-semibold transition-colors hover:bg-[var(--color-page-surface-dim)]"
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
          Paste it into <span class="font-mono">claude code</span>,{" "}
          <span class="font-mono">cursor</span>, or{" "}
          <span class="font-mono">opencode</span>, and it scaffolds the project
          for you.
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

function BrowseExamplesSection() {
  const bySlug = new Map(snippets.examples.map((ex) => [ex.slug, ex]));
  const featured = FEATURED_EXAMPLE_SLUGS.map((slug) =>
    bySlug.get(slug)
  ).filter((ex): ex is ExampleEntry => Boolean(ex));
  return (
    <section
      class="border-t py-16"
      style={{ borderColor: "var(--color-page-border)" }}
    >
      <Container>
        <div class="mb-10 text-center">
          <Eyebrow>Solutions</Eyebrow>
          <SectionHeading className="mx-auto">
            Pick a use case to see it end to end.
          </SectionHeading>
          <p
            class="mx-auto mt-3 max-w-[42rem] text-[14.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Each page walks through the connectors, memory shape, and watchers
            for one team — and ships as a working example you can{" "}
            <code class="font-mono text-[13.5px]">lobu apply</code>.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {featured.map((ex) => (
            <a
              class="flex flex-col rounded-lg border p-4 transition-colors hover:border-[color:var(--color-tg-accent)]"
              href={`/for/${ex.slug}`}
              key={ex.slug}
              style={{
                borderColor: "var(--color-page-border)",
                backgroundColor: "var(--color-page-surface)",
              }}
            >
              <span
                class="mb-2 text-[14px] font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                {ex.label}
              </span>
              {ex.description ? (
                <span
                  class="text-[13px] leading-[1.5]"
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
/*  How it works: the benefit-led, mostly-code-free homepage explainer.       */
/*  Three plain steps + a single collapsed lobu.config.ts as the "it's real"  */
/*  anchor. The per-primitive code deep-dives live in the docs (linked).      */
/* -------------------------------------------------------------------------- */

function HowItWorks() {
  const steps: Array<{
    n: string;
    title: string;
    body: preact.ComponentChildren;
    link: { href: string; label: string };
  }> = [
    {
      n: "1",
      title: "Connect your data, in real time",
      body: (
        <>
          Stream company data the moment it happens: 50+ built-in connectors,
          any MCP server, or your own in TypeScript. On-device connectors even
          capture context no cloud agent can see.
        </>
      ),
      link: {
        href: "/getting-started/connector-sdk/",
        label: "Connecting data",
      },
    },
    {
      n: "2",
      title: "It builds itself into memory",
      body: (
        <>
          Watchers turn the raw stream into typed, queryable records, the moment
          events arrive or on a schedule. You describe what to track in plain
          language; there's no ETL to maintain.
        </>
      ),
      link: { href: "/getting-started/memory/", label: "Watchers & memory" },
    },
    {
      n: "3",
      title: "Agents act where your team works",
      body: (
        <>
          On the model you choose, agents respond and flag what matters the
          moment memory changes, right where your team already works, as a Slack
          bot, an API, or another agent.
        </>
      ),
      link: { href: "/getting-started/", label: "Building agents" },
    },
  ];

  return (
    <Container className="py-16 sm:py-20">
      <div class="mb-10 text-center">
        <Eyebrow>How it works</Eyebrow>
        <SectionHeading className="mx-auto">
          From your data to an agent that acts.
        </SectionHeading>
        <p
          class="mx-auto mt-3 max-w-[36rem] text-[15px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Three steps. No data pipeline to wire up, no glue code to maintain.
        </p>
      </div>

      <div class="grid gap-6 md:grid-cols-3">
        {steps.map((step) => (
          <div
            key={step.n}
            class="flex min-w-0 flex-col rounded-lg border p-6"
            style={{
              borderColor: "var(--color-page-border)",
              backgroundColor: "var(--color-page-surface)",
            }}
          >
            <div
              class="mb-4 flex h-8 w-8 items-center justify-center rounded-full font-mono text-[14px] font-bold"
              style={{
                backgroundColor: "var(--color-page-bg)",
                border: "1px solid var(--color-tg-accent)",
                color: "var(--color-tg-accent)",
              }}
            >
              {step.n}
            </div>
            <h3
              class="mb-2 text-[1.05rem] font-bold tracking-tight"
              style={{ color: "var(--color-page-text)" }}
            >
              {step.title}
            </h3>
            <p
              class="mb-4 flex-1 text-[14.5px] leading-[1.55]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {step.body}
            </p>
            <ProductLink href={step.link.href}>{step.link.label}</ProductLink>
          </div>
        ))}
      </div>

      <div class="mx-auto mt-12 max-w-[46rem]">
        <p
          class="mb-3 text-center text-[14.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          It's all one typed file.{" "}
          <code class="font-mono text-[13px]">lobu apply</code> deploys it.
        </p>
        <CodeBlock
          badge="lobu.config.ts"
          snippet={snippets.agentConfig}
          collapsible
        />
        <div class="text-center">
          <ExampleFooterLink slug="sales" />
        </div>
        <p
          class="mt-6 text-center text-[13.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Curious how Lobu stacks up against other agent runtimes?{" "}
          <ProductLink href="/getting-started/comparison/">
            See the comparison
          </ProductLink>
        </p>
      </div>
    </Container>
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
  primary: { snippet: CodeSnippet; badge: string; maxHeight: string };
  secondary?: {
    snippet: CodeSnippet;
    badge: string;
    intro: string;
    maxHeight: string;
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
      blurb:
        "One typed file declares the agent and wires entities, watchers, connectors, and skills.",
      primary: {
        snippet: agentConfig,
        badge: "lobu.config.ts",
        maxHeight: "36rem",
      },
      docHref: "/getting-started/",
      docLabel: "Agents guide",
    },
    {
      id: "connectors",
      eyebrow: "Connectors",
      blurb:
        "Built-in, MCP, or a custom *.connector.ts — one typed event stream from every source.",
      primary: {
        snippet: connector,
        badge: "typescript",
        maxHeight: "36rem",
      },
      docHref: "/getting-started/connector-sdk/",
      docLabel: "Connector SDK docs",
      showConnectorChips: true,
    },
    {
      id: "memory",
      eyebrow: "Memory",
      blurb:
        "Declare entity types in TypeScript. Lobu stores them as append-only events with full audit.",
      primary: {
        snippet: memorySchema,
        badge: "entities",
        maxHeight: "36rem",
      },
      docHref: "/getting-started/memory/",
      docLabel: "Memory guide",
    },
    {
      id: "watchers",
      eyebrow: "Watchers",
      blurb:
        "Prompt + extraction schema. The LLM runs, validates, and writes typed memory — no ETL code.",
      primary: {
        snippet: watcher,
        badge: "reactive + dreaming",
        maxHeight: "26rem",
      },
      secondary: reaction
        ? {
            snippet: reaction,
            badge: "optional · typescript",
            intro: "Reactions run code when memory changes:",
            maxHeight: "26rem",
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
      blurb:
        "A SKILL.md folder: instructions, TS tools, Nix packages, and per-domain egress policy.",
      primary: { snippet: skill, badge: "skill", maxHeight: "32rem" },
      docHref: "/getting-started/",
      docLabel: "Skills guide",
    });
  }

  const [activeId, setActiveId] = useState<string | null>(tabs[0].id);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <Container className="py-16 sm:py-20">
      <div class="mb-8 text-center">
        <Eyebrow>What ships</Eyebrow>
        <SectionHeading className="mx-auto">
          One typed file wires it together.
        </SectionHeading>
        <p
          class="mx-auto mt-3 max-w-[42rem] text-[15px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Pick a piece to see the code for this use case. Click again to hide.
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
            maxHeight={active.primary.maxHeight}
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
                maxHeight={active.secondary.maxHeight}
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
    code: preact.ComponentChildren;
  }> = [
    {
      eyebrow: "Local",
      title: "Embedded, single process.",
      body: (
        <>
          Gateway, workers, memory, embeddings, all in one Node process.
          Postgres is the only external.
        </>
      ),
      code: (
        <>
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          lobu run{"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          gateway{"   "}
          <span style={{ color: "var(--color-landing-code-key)" }}>:8787</span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          worker{"    "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            pid=&lt;n&gt;
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          memory{"    "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            N entities
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          watchers{"  "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            N armed
          </span>
        </>
      ),
    },
    {
      eyebrow: "Self-host",
      title: "Docker. Helm. Your cloud.",
      body: (
        <>
          Helm chart and Dockerfiles in the repo (
          <code class="font-mono text-[13px]">charts/lobu/</code>,{" "}
          <code class="font-mono text-[13px]">docker/app/</code>). Run on GCP,
          AWS, Fly, Render, or bare metal.
        </>
      ),
      code: (
        <>
          <span style={{ color: "var(--color-landing-code-comment)" }}>
            # Kubernetes
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          helm install lobu ./charts/lobu{"\n\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>
            # Docker
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          docker build -f docker/app/Dockerfile .
        </>
      ),
    },
    {
      eyebrow: "Lobu Cloud",
      title: "Managed runtime.",
      body: (
        <>
          Same code, run by Lobu. Per-user isolation, secret proxy, automatic
          upgrades.
        </>
      ),
      code: (
        <>
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          lobu apply{"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          org{"      "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            &lt;your-org&gt;
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          region{"   "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            &lt;your-region&gt;
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          agents{"   "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            N deployed
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          gateway{"  "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            &lt;your-org&gt;.lobu.run
          </span>
        </>
      ),
    },
  ];
  return (
    <Container className="py-16 sm:py-20">
      <div class="mb-10 text-center">
        <Eyebrow>Run anywhere</Eyebrow>
        <SectionHeading className="mx-auto">
          Local, your cloud, or Lobu Cloud.
        </SectionHeading>
        <p
          class="mx-auto mt-3 max-w-[34rem] text-[15px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Same <code class="font-mono text-[13px]">lobu.config.ts</code> +{" "}
          <code class="font-mono text-[13px]">*.connector.ts</code> +{" "}
          <code class="font-mono text-[13px]">agents/</code>. One command to
          boot embedded; Docker + Helm for self-hosting; Lobu Cloud when you
          don't want to run it yourself.
        </p>
      </div>
      <div class="grid gap-6 md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.title}
            class="flex min-w-0 flex-col rounded-lg border p-6"
            style={{
              borderColor: "var(--color-page-border)",
              backgroundColor: "var(--color-page-surface)",
            }}
          >
            <Eyebrow>{card.eyebrow}</Eyebrow>
            <h3
              class="mb-2 text-[1.05rem] font-bold tracking-tight"
              style={{ color: "var(--color-page-text)" }}
            >
              {card.title}
            </h3>
            <p
              class="mb-4 text-[14.5px] leading-[1.55]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {card.body}
            </p>
            <pre
              class="overflow-x-auto rounded-lg px-3 py-2.5 font-mono text-[12.5px] leading-[1.65]"
              style={{
                backgroundColor: "var(--color-landing-code-bg)",
                color: "var(--color-landing-code-text)",
              }}
            >
              {card.code}
            </pre>
          </div>
        ))}
      </div>
    </Container>
  );
}
