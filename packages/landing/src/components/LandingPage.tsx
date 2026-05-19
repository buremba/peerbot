import { useState } from "preact/hooks";
import snippetsManifest from "../generated/use-case-snippets.json";
import { TERMINAL_OUTPUTS } from "../terminal-outputs";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLobuBaseUrl,
} from "../use-case-showcases";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { CodeBlock, type CodeSnippet } from "./CodeBlock";
import { CTA } from "./CTA";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";
import { TerminalPanel } from "./TerminalPanel";

type UseCaseSnippets = {
  agentToml: CodeSnippet;
  memorySchemaYaml: CodeSnippet;
  watcherYaml: CodeSnippet;
  connectorTs?: CodeSnippet;
  reactionTs?: CodeSnippet;
};

const snippets = snippetsManifest as Record<string, UseCaseSnippets>;

const PIVOT_USE_CASES: Array<{ id: LandingUseCaseId; label: string }> = [
  { id: "sales", label: "Sales" },
  { id: "finance", label: "Finance" },
  { id: "legal", label: "Legal" },
  { id: "delivery", label: "Delivery" },
  { id: "leadership", label: "Leadership" },
  { id: "ecommerce", label: "Ecommerce" },
  { id: "agent-community", label: "Community" },
  { id: "market", label: "Market" },
];

const SETUP_PROMPT = `I want to build a Lobu agent.

1. Install the Lobu skill so you have the project conventions and tooling:
   /plugin install lobu

2. Walk me through the skill's onboarding interview (it asks what the agent should do, who uses it, where data comes from, where I'll talk to it, what should run on a schedule). Pause at every real decision and ask me — don't fake credentials, don't guess.

3. Scaffold the project per my answers (lobu.toml, models/schema.yaml, connectors/, models/reactions/), boot it locally, send a test message via the chosen channel, and show me the memory event that was written.

Lobu is an open-source event-sourced backend for AI agents — connectors emit events, memory keeps the structured record, agents react in real time and dream on cron. Repo: https://github.com/lobu-ai/lobu — Docs: https://lobu.ai/docs/`;

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

export function LandingPage(props: {
  defaultUseCaseId?: LandingUseCaseId;
  latestPosts?: LatestBlogPost[];
}) {
  const [activeUseCaseId, setActiveUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const active = snippets[activeUseCaseId] ?? snippets.sales;

  return (
    <>
      <Hero />
      <Container className="py-14 sm:py-20">
        <ArchitectureDiagram />
      </Container>
      <PullQuote />
      <UseCaseGrid />
      <UseCasePivot
        activeUseCaseId={activeUseCaseId}
        onChange={setActiveUseCaseId}
      />
      <ConnectorsSection useCase={active} useCaseId={activeUseCaseId} />
      <MemorySection useCase={active} useCaseId={activeUseCaseId} />
      <WatchersSection useCase={active} useCaseId={activeUseCaseId} />
      <AgentsSection useCase={active} useCaseId={activeUseCaseId} />
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
}) {
  return (
    <section
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
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section class="px-4 pb-12 pt-20 text-center sm:pb-16 sm:pt-28">
      <Container>
        <span
          class="hero-rise hero-rise-1 mb-6 inline-block rounded-full border px-3.5 py-1.5 text-[11.5px] font-medium"
          style={{
            borderColor: "var(--color-page-border)",
            color: "var(--color-page-text-muted)",
          }}
        >
          Open source · TypeScript · Postgres · Multi-tenant · BYO model
        </span>
        <h1
          class="hero-rise hero-rise-2 mx-auto max-w-[58rem] font-display text-[clamp(2.25rem,4.8vw,3.5rem)] font-bold leading-[1.06] tracking-[-0.028em]"
          style={{ color: "var(--color-page-text)" }}
        >
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            Proactive
          </em>{" "}
          AI agents on
          <br />
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            self-building
          </em>{" "}
          knowledge graph.
        </h1>
        <p
          class="hero-rise hero-rise-3 mx-auto mt-5 max-w-[42rem] text-[17px] leading-[1.55]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Connectors emit events. Watchers structure them into memory. Agents
          act on prompts, events, or cron. Open source, multi-tenant, BYO model.
        </p>
        <div class="hero-rise hero-rise-4 mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            class="inline-flex items-center gap-2 rounded-lg px-5 py-3 text-[14.5px] font-semibold transition-transform hover:-translate-y-px"
            onClick={onCopy}
            style={{
              backgroundColor: "var(--color-page-text)",
              color: "var(--color-page-bg)",
            }}
            type="button"
          >
            <CopyIcon copied={copied} />
            <span>
              {copied ? "Copied — paste into your agent" : "Copy setup prompt"}
            </span>
          </button>
          <a
            class="inline-flex items-center gap-2 rounded-lg border px-5 py-3 text-[14.5px] font-semibold transition-colors hover:bg-[var(--color-page-surface-dim)]"
            href={GITHUB_URL}
            rel="noopener noreferrer"
            style={{
              borderColor: "var(--color-page-border)",
              color: "var(--color-page-text)",
              backgroundColor: "var(--color-page-surface)",
            }}
            target="_blank"
          >
            <GithubIcon />
            View on GitHub
          </a>
        </div>
        <p
          class="hero-rise hero-rise-4 mt-3.5 text-[13px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          or paste the prompt into <span class="font-mono">claude code</span>,{" "}
          <span class="font-mono">cursor</span>, or{" "}
          <span class="font-mono">opencode</span> — it'll scaffold the project
          for you
        </p>
        <HeroAsciinema />
        <p
          class="mx-auto mt-4 max-w-[36rem] text-[14px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <b style={{ color: "var(--color-page-text)" }}>
            Paste the prompt. Claude Code scaffolds everything:
          </b>{" "}
          connectors, schema, watcher, reaction.
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

function GithubIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.3-3.2-.1-.3-.6-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.4 5.9.4.3.8 1 .8 2v3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
    </svg>
  );
}

/**
 * Slot for the vendored asciinema-player. The script tag in
 * BaseLayout.astro defines window.AsciinemaPlayer; we mount it into the
 * container on first paint. If the cast 404s the container stays empty —
 * the page never errors.
 */
function HeroAsciinema() {
  return (
    <div
      class="hero-rise hero-rise-5 mx-auto mt-12 max-w-[44rem] overflow-hidden rounded-lg border"
      style={{
        backgroundColor: "var(--color-landing-code-bg)",
        borderColor: "var(--color-page-border)",
      }}
      ref={(node) => {
        if (!node) return;
        if (node.dataset.asciinemaMounted === "1") return;
        const player =
          typeof window !== "undefined"
            ? (
                window as unknown as {
                  AsciinemaPlayer?: {
                    create: (
                      src: string,
                      el: Element,
                      opts?: Record<string, unknown>
                    ) => unknown;
                  };
                }
              ).AsciinemaPlayer
            : null;
        if (!player) return;
        player.create("/casts/setup.cast", node, {
          autoPlay: true,
          loop: true,
          idleTimeLimit: 2,
          fit: "width",
          terminalFontSize: "13px",
          theme: "asciinema",
        });
        node.dataset.asciinemaMounted = "1";
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Static sections                                                           */
/* -------------------------------------------------------------------------- */

function PullQuote() {
  return (
    <section class="py-14 sm:py-16">
      <Container>
        <p
          class="mx-auto max-w-[51rem] text-center font-display text-[clamp(1.35rem,2.4vw,1.85rem)] font-semibold leading-[1.25] tracking-[-0.015em]"
          style={{ color: "var(--color-page-text)" }}
        >
          If you know{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            TypeScript
          </em>{" "}
          and{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            Postgres
          </em>
          , you know Lobu.
        </p>
        <p
          class="mx-auto mt-3.5 max-w-[37.5rem] text-center text-[14.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          No new language. No proprietary DSL. No vector DB. No Kafka, no Redis,
          no Kubernetes operator. Watchers and connectors are YAML; reactions
          and custom connectors are TypeScript; everything lives in Postgres.
        </p>
      </Container>
    </section>
  );
}

function UseCaseGrid() {
  const cards: Array<{
    eyebrow: string;
    title: string;
    body: preact.ComponentChildren;
    snippetLines: Array<preact.ComponentChildren>;
    link: { href: string; label: string };
  }> = [
    {
      eyebrow: "For your team",
      title: "An internal Slack bot.",
      body: (
        <>
          Lunch ordering, Linear triage, standup digests. One-click{" "}
          <b>"Add to Slack"</b> wires the bot live. Same agent ships to
          Telegram, Discord, or MS Teams.
        </>
      ),
      snippetLines: [
        <>
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          lobu apply
        </>,
        <>
          <span style={{ color: "var(--color-landing-code-string)" }}>→</span>{" "}
          agent: lunch ready
        </>,
        <>
          <span style={{ color: "var(--color-landing-code-string)" }}>→</span>{" "}
          click{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            "Add to Slack"
          </span>
        </>,
      ],
      link: {
        href: "https://github.com/lobu-ai/lobu/tree/main/examples/office-bot",
        label: "See office-bot example",
      },
    },
    {
      eyebrow: "For your org",
      title: "A knowledge graph from your team's data.",
      body: (
        <>
          Pull from Slack, Notion, Gmail, GitHub, Linear. Declare entity types
          once. Dreaming watchers deepen the graph nightly. No manual ETL.
        </>
      ),
      snippetLines: [
        <span style={{ color: "var(--color-landing-code-comment)" }}>
          # models/schema.yaml
        </span>,
        <>
          <span style={{ color: "var(--color-landing-code-key)" }}>
            entities
          </span>
          :
        </>,
        <>
          {"  - "}
          <span style={{ color: "var(--color-landing-code-key)" }}>slug</span>:{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            customer
          </span>
        </>,
        <>
          {"  - "}
          <span style={{ color: "var(--color-landing-code-key)" }}>slug</span>:{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            incident
          </span>
        </>,
        <>
          {"  - "}
          <span style={{ color: "var(--color-landing-code-key)" }}>slug</span>:{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            order
          </span>
        </>,
      ],
      link: {
        href: "https://github.com/lobu-ai/lobu/tree/main/examples/lobu-crm",
        label: "See lobu-crm example",
      },
    },
    {
      eyebrow: "For your users",
      title: "An agent inside your product.",
      body: (
        <>
          Sandbox + memory per customer. Per-user OAuth, workers never see the
          tokens. Integrate via HTTP API or MCP.
        </>
      ),
      snippetLines: [
        <span style={{ color: "var(--color-landing-code-comment)" }}>
          POST /agents/assistant/run
        </span>,
        <>
          <span style={{ color: "var(--color-landing-code-key)" }}>
            x-lobu-user
          </span>
          :{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            "acme_user_42"
          </span>
        </>,
      ],
      link: { href: "/getting-started/", label: "See multi-tenant SDK" },
    },
  ];

  return (
    <section
      class="border-t py-16"
      style={{ borderColor: "var(--color-page-border)" }}
    >
      <Container>
        <div class="mb-10 text-center">
          <Eyebrow>What you'd build</Eyebrow>
          <SectionHeading className="mx-auto">
            Three shapes. One platform.
          </SectionHeading>
        </div>
        <div class="grid gap-5 md:grid-cols-3">
          {cards.map((card) => (
            <div
              key={card.title}
              class="rounded-lg border p-6"
              style={{
                borderColor: "var(--color-page-border)",
                backgroundColor: "var(--color-page-surface)",
              }}
            >
              <div
                class="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em]"
                style={{ color: "var(--color-tg-accent)" }}
              >
                {card.eyebrow}
              </div>
              <h3
                class="mb-3 text-[1.1rem] font-bold tracking-tight"
                style={{ color: "var(--color-page-text)" }}
              >
                {card.title}
              </h3>
              <p
                class="mb-4 text-[14.5px] leading-[1.6]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {card.body}
              </p>
              <pre
                class="mb-4 rounded-lg px-3 py-2.5 font-mono text-[12px] leading-[1.65]"
                style={{
                  backgroundColor: "var(--color-landing-code-bg)",
                  color: "var(--color-landing-code-text)",
                }}
              >
                {card.snippetLines.map((line, i) => (
                  <span class="block whitespace-pre" key={i}>
                    {line}
                  </span>
                ))}
              </pre>
              <a
                class="text-[13px] font-semibold"
                href={card.link.href}
                rel="noopener noreferrer"
                style={{ color: "var(--color-page-text)" }}
                target="_blank"
              >
                {card.link.label} →
              </a>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Use-case pivot                                                            */
/* -------------------------------------------------------------------------- */

function UseCasePivot(props: {
  activeUseCaseId: LandingUseCaseId;
  onChange: (id: LandingUseCaseId) => void;
}) {
  return (
    <Container className="pb-2 pt-12">
      <div class="mb-3 text-center">
        <Eyebrow>Same primitives, every domain</Eyebrow>
        <SectionHeading className="mx-auto">
          Pick a use case. Every code panel changes.
        </SectionHeading>
        <p
          class="mx-auto mt-3 max-w-[40rem] text-[14.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          The connectors, memory schema, watcher, and agent config below are
          read straight from <span class="font-mono">examples/&lt;id&gt;/</span>{" "}
          in the repo.
        </p>
      </div>
      <div
        class="mx-auto mt-8 flex flex-wrap justify-center gap-x-1 gap-y-0 border-b"
        style={{ borderColor: "var(--color-page-border)" }}
      >
        {PIVOT_USE_CASES.map((uc) => {
          const active = uc.id === props.activeUseCaseId;
          return (
            <button
              aria-pressed={active}
              key={uc.id}
              class="-mb-px border-b-2 px-3 py-2 font-mono text-[12.5px] transition-colors"
              onClick={() => props.onChange(uc.id)}
              style={{
                borderColor: active ? "var(--color-page-text)" : "transparent",
                color: active
                  ? "var(--color-page-text)"
                  : "var(--color-page-text-muted)",
                fontWeight: active ? 700 : 500,
              }}
              type="button"
            >
              {uc.label.toLowerCase()}
            </button>
          );
        })}
      </div>
    </Container>
  );
}

/* -------------------------------------------------------------------------- */
/*  Product sections (Connectors / Memory / Watchers / Agents)               */
/* -------------------------------------------------------------------------- */

type ProductSectionProps = {
  useCase: UseCaseSnippets;
  useCaseId: LandingUseCaseId;
};

function ProductGrid(props: {
  reverse?: boolean;
  text: preact.ComponentChildren;
  code: preact.ComponentChildren;
}) {
  return (
    <div
      class={`grid items-start gap-10 md:gap-16 ${
        props.reverse
          ? "md:grid-cols-[1.15fr_1fr]"
          : "md:grid-cols-[1fr_1.15fr]"
      }`}
    >
      {props.reverse ? (
        <>
          <div class="min-w-0">{props.code}</div>
          <div class="min-w-0">{props.text}</div>
        </>
      ) : (
        <>
          <div class="min-w-0">{props.text}</div>
          <div class="min-w-0">{props.code}</div>
        </>
      )}
    </div>
  );
}

function FeatureList(props: { items: Array<preact.ComponentChildren> }) {
  return (
    <ul class="my-5 grid gap-2.5">
      {props.items.map((item, i) => (
        <li
          key={i}
          class="relative pl-6 text-[14.5px] leading-[1.55]"
          style={{ color: "var(--color-page-text)" }}
        >
          <span
            aria-hidden="true"
            class="absolute left-0 top-0 font-bold"
            style={{ color: "var(--color-tg-accent)" }}
          >
            →
          </span>
          {item}
        </li>
      ))}
    </ul>
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

function ConnectorsSection({ useCase, useCaseId }: ProductSectionProps) {
  const terminal = TERMINAL_OUTPUTS[useCaseId]?.connectors;
  return (
    <Container className="py-16 sm:py-20">
      <ProductGrid
        text={
          <div>
            <Eyebrow>Connectors</Eyebrow>
            <SectionHeading>
              One event stream for everything your team produces.
            </SectionHeading>
            <p
              class="mt-4 max-w-[28rem] text-[16px] leading-[1.6]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              YAML to configure. TypeScript to extend, via{" "}
              <code class="font-mono text-[14px]">@lobu/connector-sdk</code>.
              Every connector emits typed events into one stream.
            </p>
            <FeatureList
              items={[
                <>
                  <b>On-device collection</b> — paired Chrome and macOS
                  connectors capture local context no cloud agent can see.
                </>,
                <>
                  <b>Multi-tenant OAuth</b> — each user signs in with their own
                  account; workers never see the token.
                </>,
                <>
                  <b>Durable checkpointing</b> — connectors resume from the last
                  cursor after restart. No missed events.
                </>,
                <>
                  <b>MCP proxy</b> — wrap any MCP server (Stripe, GitHub,
                  internal) as a Lobu connector.
                </>,
                <>
                  <b>Custom in TypeScript</b> — drop a{" "}
                  <code class="font-mono text-[13px]">*.connector.ts</code> in
                  your repo,{" "}
                  <code class="font-mono text-[13px]">lobu apply</code> picks it
                  up.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/">
              Read the connector-sdk docs
            </ProductLink>
          </div>
        }
        code={
          <div class="space-y-3.5">
            {useCase.connectorTs ? (
              <CodeBlock badge="typescript" snippet={useCase.connectorTs} />
            ) : null}
            {terminal ? (
              <TerminalPanel title={terminal.title} lines={terminal.lines} />
            ) : null}
          </div>
        }
      />
    </Container>
  );
}

function MemorySection({ useCase, useCaseId }: ProductSectionProps) {
  const terminal = TERMINAL_OUTPUTS[useCaseId]?.memory;
  return (
    <Container className="py-16 sm:py-20">
      <ProductGrid
        reverse
        text={
          <div>
            <Eyebrow>Memory</Eyebrow>
            <SectionHeading>
              An event-sourced database for AI agents.
            </SectionHeading>
            <p
              class="mt-4 max-w-[28rem] text-[16px] leading-[1.6]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Declare entity types in YAML. Lobu stores them as append-only
              events with full audit. Multi-tenant by default — agents see only
              their scope.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Entity types &amp; relationships</b> — declare what your
                  agent should remember; link entities to build a graph.
                </>,
                <>
                  <b>Event-sourced &amp; append-only</b> — every fact is an
                  event. Tombstones supersede; nothing is destroyed.
                </>,
                <>
                  <b>Agent-assisted modeling</b> — paste the setup prompt into
                  Claude Code or Cursor; it interviews you and drafts{" "}
                  <code class="font-mono text-[13px]">schema.yaml</code>.
                </>,
                <>
                  <b>Per-user / per-org isolation</b> — your agents only see the
                  memory they're scoped to.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/memory/">
              Read the memory guide
            </ProductLink>
          </div>
        }
        code={
          <div class="space-y-3.5">
            <CodeBlock badge="entities" snippet={useCase.memorySchemaYaml} />
            {terminal ? (
              <TerminalPanel title={terminal.title} lines={terminal.lines} />
            ) : null}
          </div>
        }
      />
    </Container>
  );
}

function WatchersSection({ useCase, useCaseId }: ProductSectionProps) {
  const terminal = TERMINAL_OUTPUTS[useCaseId]?.watchers;
  return (
    <Container className="py-16 sm:py-20">
      <ProductGrid
        text={
          <div>
            <Eyebrow>Watchers</Eyebrow>
            <SectionHeading>
              Turn events into memory. With prompts.
            </SectionHeading>
            <p
              class="mt-4 max-w-[28rem] text-[16px] leading-[1.6]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              A watcher is a <code class="font-mono text-[14px]">prompt</code> +{" "}
              <code class="font-mono text-[14px]">extraction_schema</code>. Lobu
              runs the LLM, validates, and persists the output to memory.{" "}
              <b>No application code</b> — fire on events, or run on cron.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Reactive</b> — fires on the event stream (e.g.{" "}
                  <code class="font-mono text-[13px]">
                    linear.issue.created
                  </code>
                  ).
                </>,
                <>
                  <b>Dreaming</b> — runs on cron. Aggregates yesterday's events
                  into higher-level entities while your team sleeps.
                </>,
                <>
                  <b>No-code ETL</b> — the prompt is your transformation; the
                  schema is your output type.
                </>,
                <>
                  <b>Reactions are optional</b> — drop in a{" "}
                  <code class="font-mono text-[13px]">*.reaction.ts</code> only
                  when you need imperative code on top.
                </>,
                <>
                  <b>Auditable</b> — every run lands as events in the durable
                  log.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/">
              Read the watchers guide
            </ProductLink>
          </div>
        }
        code={
          <div class="space-y-3.5">
            <CodeBlock
              badge="reactive + dreaming"
              snippet={useCase.watcherYaml}
            />
            {terminal ? (
              <TerminalPanel title={terminal.title} lines={terminal.lines} />
            ) : null}
          </div>
        }
      />
    </Container>
  );
}

function AgentsSection({ useCase, useCaseId }: ProductSectionProps) {
  const terminal = TERMINAL_OUTPUTS[useCaseId]?.agents;
  return (
    <Container className="py-16 sm:py-20">
      <ProductGrid
        reverse
        text={
          <div>
            <Eyebrow>Agents</Eyebrow>
            <SectionHeading>One agent. Every chat surface.</SectionHeading>
            <p
              class="mt-4 max-w-[28rem] text-[16px] leading-[1.6]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Declare your agent in{" "}
              <code class="font-mono text-[14px]">lobu.toml</code> — provider,
              model, skills, platforms. Same agent across Slack, Telegram,
              Discord, MS Teams, WhatsApp, HTTP API, MCP.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Ship anywhere</b> — one config, every surface.
                </>,
                <>
                  <b>BYO model</b> — Anthropic, OpenAI, Z.ai, OpenRouter, your
                  own.
                </>,
                <>
                  <b>Per-user isolation</b> — workers scoped by user/channel.
                  Secrets stay in the proxy.
                </>,
                <>
                  <b>Durable &amp; audited</b> — every agent action is an event
                  in the log.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/">
              Read the agents guide
            </ProductLink>
          </div>
        }
        code={
          <div class="space-y-3.5">
            <CodeBlock badge="agent" snippet={useCase.agentToml} />
            {terminal ? (
              <TerminalPanel title={terminal.title} lines={terminal.lines} />
            ) : null}
          </div>
        }
      />
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
          Gateway, workers, memory, embeddings — all in one Node process.
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
            pid=72341
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          memory{"    "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            2 entities
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          watchers{"  "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            1 armed
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
          Same code, fully managed. Multi-tenant per-user isolation, secret
          proxy, automatic upgrades. Usage-based pricing.
        </>
      ),
      code: (
        <>
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          lobu apply{"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          org{"      "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            acme
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          region{"   "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            us-east-1
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          agents{"   "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            1 deployed
          </span>
          {"\n"}
          <span style={{ color: "var(--color-landing-code-comment)" }}>→</span>{" "}
          gateway{"  "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            acme.lobu.run
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
          Same <code class="font-mono text-[13px]">lobu.toml</code> +{" "}
          <code class="font-mono text-[13px]">models/</code> +{" "}
          <code class="font-mono text-[13px]">connectors/</code> +{" "}
          <code class="font-mono text-[13px]">agents/</code>. One command to
          boot embedded; Docker images and a Helm chart for self-hosting; a
          managed runtime when you want someone else to keep it up.
        </p>
      </div>
      <div class="grid gap-6 md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.title}
            class="rounded-lg border p-6 shadow-[0_1px_3px_rgba(0,0,0,0.03),0_8px_24px_-12px_rgba(0,0,0,0.08)]"
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
              class="overflow-hidden rounded-lg px-3 py-2.5 font-mono text-[12.5px] leading-[1.65]"
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
