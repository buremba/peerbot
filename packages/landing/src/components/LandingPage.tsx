import { useState } from "preact/hooks";
import connectorsManifest from "../generated/connectors.json";
import snippetsManifest from "../generated/landing-snippets.json";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLobuBaseUrl,
  landingUseCaseShowcases,
} from "../use-case-showcases";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { CodeBlock, type CodeSnippet } from "./CodeBlock";
import { CTA } from "./CTA";
import { LatestBlogPosts, type LatestBlogPost } from "./LatestBlogPosts";
import { UseCaseTabs } from "./UseCaseTabs";

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
};

type LandingSnippets = {
  connector: CodeSnippet;
  memorySchema: CodeSnippet;
  watcher: CodeSnippet;
  reaction: CodeSnippet;
  agentToml: CodeSnippet;
  skill: CodeSnippet;
  examples: ExampleEntry[];
  useCases: Record<string, UseCaseSnippets>;
};

const snippets = snippetsManifest as LandingSnippets;

const EXAMPLE_BASE_URL = "https://github.com/lobu-ai/lobu/tree/main/examples";

const SETUP_PROMPT = `I want to build a Lobu agent.

1. Install the Lobu skill so you have the project conventions and tooling:
   /plugin install lobu

2. Walk me through the skill's onboarding interview (it asks what the agent should do, who uses it, where data comes from, where I'll talk to it, what should run on a schedule). Pause at every real decision and ask me, don't fake credentials, don't guess.

3. Scaffold the project per my answers (lobu.toml, models/schema.yaml, connectors/, models/reactions/), boot it locally, send a test message via the chosen channel, and show me the memory event that was written.

Lobu is an open-source event-sourced backend for AI agents: connectors emit events, memory keeps the structured record, agents react in real time and dream on cron. Repo: https://github.com/lobu-ai/lobu. Docs: https://lobu.ai/docs/`;

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

export function LandingPage(props: {
  latestPosts?: LatestBlogPost[];
  defaultUseCaseId?: string;
}) {
  const [activeUseCase, setActiveUseCase] = useState<string>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );

  const uc = snippets.useCases[activeUseCase];
  const connectorSnippet = uc?.connector ?? snippets.connector;
  const memorySchemaSnippet = uc?.memorySchema ?? snippets.memorySchema;
  const watcherSnippet = uc?.watcher ?? snippets.watcher;

  return (
    <>
      <Hero />
      <Container className="py-14 sm:py-20">
        <ArchitectureDiagram />
      </Container>
      <Container className="pt-2 pb-2">
        <UseCaseTabs
          label="See it for your use case"
          tabs={landingUseCaseShowcases.map((s) => ({
            id: s.id,
            label: s.label,
          }))}
          activeId={activeUseCase}
          onSelect={setActiveUseCase}
        />
      </Container>
      <ConnectorsSection connector={connectorSnippet} slug={activeUseCase} />
      <MemorySection memorySchema={memorySchemaSnippet} slug={activeUseCase} />
      <WatchersSection watcher={watcherSnippet} slug={activeUseCase} />
      <SkillsSection />
      <AgentsSection />
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
          Build{" "}
          <em class="not-italic" style={{ color: "var(--color-tg-accent)" }}>
            proactive
          </em>{" "}
          agents on a
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
          An automated pipeline streams every event into the graph. Agents react
          to changes, take action, and reach people as bots, or other agents
          over MCP and HTTP.
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
              {copied ? "Copied, paste into your agent" : "Copy setup prompt"}
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
          <span class="font-mono">opencode</span>, it'll scaffold the project
          for you
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

/* -------------------------------------------------------------------------- */
/*  Static sections                                                           */
/* -------------------------------------------------------------------------- */

function BrowseExamplesSection() {
  const examples = snippets.examples;
  return (
    <section
      class="border-t py-16"
      style={{ borderColor: "var(--color-page-border)" }}
    >
      <Container>
        <div class="mb-10 text-center">
          <Eyebrow>Browse the repo</Eyebrow>
          <SectionHeading className="mx-auto">Examples</SectionHeading>
          <p
            class="mx-auto mt-3 max-w-[42rem] text-[14.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Clone any one, run{" "}
            <code class="font-mono text-[13.5px]">lobu apply</code>, and you
            have a working agent.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {examples.map((ex) => (
            <a
              class="flex flex-col rounded-lg border p-4 transition-colors hover:border-[color:var(--color-tg-accent)]"
              href={ex.githubUrl}
              key={ex.slug}
              rel="noopener noreferrer"
              style={{
                borderColor: "var(--color-page-border)",
                backgroundColor: "var(--color-page-surface)",
              }}
              target="_blank"
            >
              <span
                class="mb-2 font-mono text-[12.5px]"
                style={{ color: "var(--color-page-text)" }}
              >
                examples/{ex.slug}
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
      href={`${EXAMPLE_BASE_URL}/${slug}`}
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

function ConnectorsSection({
  connector,
  slug,
}: {
  connector: CodeSnippet;
  slug: string;
}) {
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
              Bring event data in three ways: a built-in connector, your own in
              TypeScript with{" "}
              <code class="font-mono text-[14px]">@lobu/connector-sdk</code>, or
              any MCP server.
            </p>
            <FeatureList
              items={[
                <>
                  <b>On-device collection</b>: paired Chrome and macOS
                  connectors capture local context no cloud agent can see.
                </>,
                <>
                  <b>Multi-tenant OAuth</b>: each user signs in with their own
                  account; workers never see the token.
                </>,
                <>
                  <b>Durable checkpointing</b>: connectors resume from the last
                  cursor after restart. No missed events.
                </>,
                <>
                  <b>MCP proxy</b>: wrap any MCP server (Stripe, GitHub,
                  internal) as a Lobu connector.
                </>,
                <>
                  <b>Custom in TypeScript</b>: drop a{" "}
                  <code class="font-mono text-[13px]">*.connector.ts</code> in
                  your repo,{" "}
                  <code class="font-mono text-[13px]">lobu apply</code> picks it
                  up.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/connector-sdk/">
              Read the connector-sdk docs
            </ProductLink>
            <ConnectorChips />
          </div>
        }
        code={
          <div>
            <CodeBlock badge="typescript" snippet={connector} />
            <ExampleFooterLink slug={slug} />
          </div>
        }
      />
    </Container>
  );
}

const CONNECTOR_SRC_BASE =
  "https://github.com/lobu-ai/lobu/blob/main/packages/connectors/src";

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
            href={`${CONNECTOR_SRC_BASE}/${c.file}`}
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

function MemorySection({
  memorySchema,
  slug,
}: {
  memorySchema: CodeSnippet;
  slug: string;
}) {
  return (
    <Container id="memory" className="py-16 sm:py-20">
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
              events with full audit. Multi-tenant by default, agents see only
              their scope.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Entity types &amp; relationships</b>: declare what your
                  agent should remember; link entities with typed relations.
                </>,
                <>
                  <b>Append-only</b>: every change is a new event. Tombstones
                  supersede; nothing is destroyed.
                </>,
                <>
                  <b>Agent-assisted modeling</b>: paste the setup prompt into
                  Claude Code or Cursor; it interviews you and drafts{" "}
                  <code class="font-mono text-[13px]">schema.yaml</code>.
                </>,
                <>
                  <b>Per-user / per-org isolation</b>: your agents only see the
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
          <div>
            <CodeBlock badge="entities" snippet={memorySchema} />
            <ExampleFooterLink slug={slug} />
          </div>
        }
      />
    </Container>
  );
}

function WatchersSection({
  watcher,
  slug,
}: {
  watcher: CodeSnippet;
  slug: string;
}) {
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
              <b>No application code</b>: fire on events, or run on cron.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Reactive</b>: fires on the event stream (e.g.{" "}
                  <code class="font-mono text-[13px]">
                    linear.issue.created
                  </code>
                  ).
                </>,
                <>
                  <b>Dreaming</b>: runs on cron. Aggregates the previous day's
                  events into higher-level entities.
                </>,
                <>
                  <b>No-code ETL</b>: the prompt is your transformation; the
                  schema is your output type.
                </>,
                <>
                  <b>Reactions are optional</b>: drop in a{" "}
                  <code class="font-mono text-[13px]">*.reaction.ts</code> only
                  when you need imperative code on top.
                </>,
                <>
                  <b>Auditable</b>: every run lands as events in the durable
                  log.
                </>,
              ]}
            />
            <div class="flex flex-wrap gap-x-4 gap-y-2">
              <ProductLink href="/getting-started/watchers/">
                Watchers guide
              </ProductLink>
              <ProductLink href="/getting-started/reaction-sdk/">
                Reaction SDK docs
              </ProductLink>
            </div>
          </div>
        }
        code={
          <div class="space-y-3.5">
            <CodeBlock badge="reactive + dreaming" snippet={watcher} />
            <p
              class="text-[13px]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Reactions run code when memory changes. For example:
            </p>
            <CodeBlock
              badge="optional · typescript"
              snippet={snippets.reaction}
            />
            <ExampleFooterLink slug={slug} />
          </div>
        }
      />
    </Container>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skills section: snippet is the YAML frontmatter of the deliveroo-order    */
/*  SKILL.md, trimmed at build time by gen-landing-snippets.ts (the example   */
/*  that exercises every field the pitch promises: nixPackages,               */
/*  network.allow, network.judge, judges.default).                            */
/* -------------------------------------------------------------------------- */

function SkillsSection() {
  return (
    <Container id="skills" className="py-16 sm:py-20">
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
              <code class="font-mono text-[13px]">
                agents/&lt;id&gt;/skills/
              </code>
              , <code class="font-mono text-[13px]">lobu apply</code> picks it
              up. The agent gets instructions, tools, packages, and a per-domain
              LLM egress policy in one shot.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Instructions</b>: markdown describing when the agent should
                  use this skill.
                </>,
                <>
                  <b>Tools</b>: TypeScript functions the agent calls.
                  Auto-registered as MCP tools.
                </>,
                <>
                  <b>Network</b>: allowed domains + per-domain LLM egress judge
                  in YAML.
                </>,
                <>
                  <b>Packages</b>: Nix packages (git, jq, etc.) merged into the
                  worker env.
                </>,
              ]}
            />
            <ProductLink href="/getting-started/">
              Read the skills guide
            </ProductLink>
          </div>
        }
        code={
          <div>
            <CodeBlock badge="skill" snippet={snippets.skill} />
            <p
              class="mt-2 text-[13px]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Plus the markdown body, instructions for when and how the agent
              should use this skill.
            </p>
            <ExampleFooterLink slug="office-bot" />
          </div>
        }
      />
    </Container>
  );
}

function AgentsSection() {
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
              <code class="font-mono text-[14px]">lobu.toml</code>: provider,
              model, skills. One config, every surface below.
            </p>
            <FeatureList
              items={[
                <>
                  <b>Every chat surface</b>:{" "}
                  <a
                    class="underline decoration-dotted underline-offset-2 transition-colors hover:text-[color:var(--color-tg-accent)]"
                    href="/platforms/slack/"
                  >
                    Slack
                  </a>
                  ,{" "}
                  <a
                    class="underline decoration-dotted underline-offset-2 transition-colors hover:text-[color:var(--color-tg-accent)]"
                    href="/platforms/telegram/"
                  >
                    Telegram
                  </a>
                  ,{" "}
                  <a
                    class="underline decoration-dotted underline-offset-2 transition-colors hover:text-[color:var(--color-tg-accent)]"
                    href="/platforms/discord/"
                  >
                    Discord
                  </a>
                  ,{" "}
                  <a
                    class="underline decoration-dotted underline-offset-2 transition-colors hover:text-[color:var(--color-tg-accent)]"
                    href="/platforms/teams/"
                  >
                    Teams
                  </a>
                  ,{" "}
                  <a
                    class="underline decoration-dotted underline-offset-2 transition-colors hover:text-[color:var(--color-tg-accent)]"
                    href="/platforms/whatsapp/"
                  >
                    WhatsApp
                  </a>
                  , HTTP, MCP. Same{" "}
                  <code class="font-mono text-[13px]">lobu.toml</code>.
                </>,
                <>
                  <b>BYO model</b>: Anthropic, OpenAI, Z.ai, OpenRouter, your
                  own.
                </>,
                <>
                  <b>Per-user isolation</b>: workers scoped by user/channel.
                  Secrets stay in the proxy.
                </>,
                <>
                  <b>Durable &amp; audited</b>: every agent action is an event
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
          <div>
            <CodeBlock badge="agent" snippet={snippets.agentToml} />
            <ExampleFooterLink slug="lobu-crm" />
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
          Same <code class="font-mono text-[13px]">lobu.toml</code> +{" "}
          <code class="font-mono text-[13px]">models/</code> +{" "}
          <code class="font-mono text-[13px]">connectors/</code> +{" "}
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
