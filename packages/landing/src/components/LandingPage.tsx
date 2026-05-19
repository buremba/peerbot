import { useState } from "preact/hooks";
import snippetsManifest from "../generated/use-case-snippets.json";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLobuBaseUrl,
} from "../use-case-showcases";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { CodeBlock, type CodeSnippet } from "./CodeBlock";
import { CTA } from "./CTA";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";

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
      <UseCaseGrid />
      <UseCasePivot
        activeUseCaseId={activeUseCaseId}
        onChange={setActiveUseCaseId}
      />
      <ConnectorsSection useCase={active} useCaseId={activeUseCaseId} />
      <MemorySection useCase={active} useCaseId={activeUseCaseId} />
      <WatchersSection useCase={active} useCaseId={activeUseCaseId} />
      <SkillsSection />
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
          knowledge graph
        </h1>
        <p
          class="hero-rise hero-rise-3 mx-auto mt-5 max-w-[42rem] text-[17px] leading-[1.55]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Connectors stream events into an append-only memory. LLM watchers
          shape them into entities your agent can search and cite. Open source,
          multi-tenant, BYO model.
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

function UseCaseGrid() {
  const cards: Array<{
    eyebrow: string;
    title: string;
    body: preact.ComponentChildren;
    snippetLines: Array<preact.ComponentChildren>;
    link: { href: string; label: string };
  }> = [
    {
      eyebrow: "Reactive bot",
      title: "A chat-driven agent.",
      body: (
        <>
          Fires per message in Slack, Telegram, Discord, MS Teams, WhatsApp, or
          HTTP. Recalls memory, calls tools, replies.
        </>
      ),
      snippetLines: [
        <>
          <span style={{ color: "var(--color-landing-code-comment)" }}>$</span>{" "}
          lobu apply
        </>,
        <>
          <span style={{ color: "var(--color-landing-code-string)" }}>→</span>{" "}
          agent: office-bot ready
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
      eyebrow: "Cron digest",
      title: "A dreaming watcher.",
      body: (
        <>
          Runs on a schedule (cron). Aggregates the previous day's events into
          higher-level entities your team can read in the morning.
        </>
      ),
      snippetLines: [
        <span style={{ color: "var(--color-landing-code-comment)" }}>
          # models/schema.yaml
        </span>,
        <>
          <span style={{ color: "var(--color-landing-code-key)" }}>
            watchers
          </span>
          :
        </>,
        <>
          {"  - "}
          <span style={{ color: "var(--color-landing-code-key)" }}>slug</span>:{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            month-end-variance
          </span>
        </>,
        <>
          {"    "}
          <span style={{ color: "var(--color-landing-code-key)" }}>
            schedule
          </span>
          :{" "}
          <span style={{ color: "var(--color-landing-code-string)" }}>
            "0 9 * * 1"
          </span>
        </>,
      ],
      link: {
        href: "https://github.com/lobu-ai/lobu/tree/main/examples/finance",
        label: "See finance example",
      },
    },
    {
      eyebrow: "Event automation",
      title: "A connector → watcher → reaction pipeline.",
      body: (
        <>
          An external event lands in the stream, a watcher extracts structured
          data, an optional reaction calls Slack / Linear / Salesforce / etc.
        </>
      ),
      snippetLines: [
        <span style={{ color: "var(--color-landing-code-comment)" }}>
          # salesforce.opportunity.updated
        </span>,
        <>
          <span style={{ color: "var(--color-landing-code-string)" }}>→</span>{" "}
          watcher:{" "}
          <span style={{ color: "var(--color-landing-code-key)" }}>
            renewal-risk
          </span>
        </>,
        <>
          <span style={{ color: "var(--color-landing-code-string)" }}>→</span>{" "}
          reaction:{" "}
          <span style={{ color: "var(--color-landing-code-key)" }}>
            ping_csm
          </span>
        </>,
      ],
      link: {
        href: "https://github.com/lobu-ai/lobu/tree/main/examples/sales",
        label: "See sales example",
      },
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
            Three shapes. Three working examples.
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

function ConnectorsSection({ useCase }: ProductSectionProps) {
  return (
    <Container className="py-16 sm:py-20">
      <ProductGrid
        text={
          <div>
            <Eyebrow>Connectors</Eyebrow>
            <SectionHeading>
              One typed event stream from every source.
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
          useCase.connectorTs ? (
            <CodeBlock badge="typescript" snippet={useCase.connectorTs} />
          ) : null
        }
      />
    </Container>
  );
}

function MemorySection({ useCase }: ProductSectionProps) {
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
        code={<CodeBlock badge="entities" snippet={useCase.memorySchemaYaml} />}
      />
    </Container>
  );
}

function WatchersSection({ useCase }: ProductSectionProps) {
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
                  <b>Dreaming</b> — runs on cron. Aggregates the previous day's
                  events into higher-level entities.
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
          <CodeBlock
            badge="reactive + dreaming"
            snippet={useCase.watcherYaml}
          />
        }
      />
    </Container>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skills section — not use-case pivoted (only lobu-crm + office-bot ship    */
/*  skills today). Snippet is the YAML frontmatter + first heading +          */
/*  first paragraph of examples/lobu-crm/agents/crm/skills/crm-ops/SKILL.md.  */
/* -------------------------------------------------------------------------- */

const SKILL_SNIPPET: CodeSnippet = {
  path: "agents/crm/skills/crm-ops/SKILL.md",
  githubUrl:
    "https://github.com/lobu-ai/lobu/blob/main/examples/lobu-crm/agents/crm/skills/crm-ops/SKILL.md",
  language: "markdown",
  code: `---
name: crm-ops
description: How to operate the Lobu funnel CRM — create and enrich leads, log interactions, advance funnel stages, open and update pilots.
---

# CRM operations

The CRM lives in Lobu memory. Two entity types — \`lead\` and \`pilot\` — hold current state; events of type \`lead:*\` / \`pilot:*\` are the append-only history.`,
};

function SkillsSection() {
  return (
    <Container className="py-16 sm:py-20">
      <ProductGrid
        reverse
        text={
          <div>
            <Eyebrow>Skills</Eyebrow>
            <SectionHeading>
              Bundle tools, packages, and policy into one drop-in.
            </SectionHeading>
            <p
              class="mt-4 max-w-[28rem] text-[16px] leading-[1.6]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              A skill is a folder with a{" "}
              <code class="font-mono text-[14px]">SKILL.md</code>. Drop it in{" "}
              <code class="font-mono text-[13px]">skills/</code> or{" "}
              <code class="font-mono text-[13px]">agents/&lt;id&gt;/skills/</code>
              ,{" "}
              <code class="font-mono text-[13px]">lobu apply</code> picks it up.
              The agent gets instructions, tools, network, and packages in one
              shot.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Instructions</b> — markdown describing when the agent
                  should use this skill.
                </>,
                <>
                  <b>Tools</b> — TypeScript functions the agent calls.
                  Auto-registered as MCP tools.
                </>,
                <>
                  <b>Network</b> — allowed domains + per-domain LLM egress
                  judge in YAML.
                </>,
                <>
                  <b>Packages</b> — Nix packages (git, jq, etc.) merged into
                  the worker env.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/">
              Read the skills guide
            </ProductLink>
          </div>
        }
        code={
          <CodeBlock
            badge="skill"
            snippet={SKILL_SNIPPET}
            tabLabel={SKILL_SNIPPET.path}
          />
        }
      />
    </Container>
  );
}

function AgentsSection({ useCase }: ProductSectionProps) {
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
                  <b>Every chat surface</b> — Slack, Telegram, Discord, Teams,
                  WhatsApp, HTTP, MCP. Same{" "}
                  <code class="font-mono text-[13px]">lobu.toml</code>.
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
        code={<CodeBlock badge="agent" snippet={useCase.agentToml} />}
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
