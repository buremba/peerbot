/**
 * Data-driven "operating loop" artifact, shared by the homepage and every
 * /for/<use-case> page. Renders ONE design, parameterized by a `LoopData`:
 *
 *   SOURCES ───watches───▶ STANDING GOAL
 *      │ builds                 │ fires
 *      ▼                        ▼
 *   LIVE MEMORY              CHAT (the agent acts)
 *
 * A CSS grid forces each row's two cards to equal height (SOURCES = GOAL,
 * MEMORY = CHAT), keeping both columns level. Reuses SampleChat for the chat.
 *
 * The homepage passes SALES_LOOP (the renewal-risk story). /for/<slug> pages
 * pass a config built from that vertical's connectors / entities / watcher.
 */

import {
  siDatadog,
  siGithub,
  siGmail,
  siGoogledrive,
  siHubspot,
  siJira,
  siLinear,
  siNotion,
  siPostgresql,
  siShopify,
  siSnowflake,
  siStripe,
  siZendesk,
} from "simple-icons";
import { GITHUB_EXAMPLES_URL } from "../lib/urls";
import type { UseCase } from "../types";
import { CanvasAurora } from "./CanvasAurora";
import { messagingChannels } from "./platforms";
import { SampleChat, SLACK_THEME } from "./SampleChat";

const ACCENT = "var(--color-tg-accent)";
const RISK = "#f5a524"; // amber: "at risk"
const OK = "#36c5ab"; // teal: "healthy" (matches the Slack agent color)

// --- Types -------------------------------------------------------------------

/** Minimal shape of a simple-icons icon (title + svg path). */
export type LoopIcon = { title: string; path: string };
/** A connector chip: shows a brand logo when known, a text chip otherwise. */
export type LoopConnector = { label: string; icon?: LoopIcon };
export type LoopStatus = { label: string; tone: "risk" | "ok" };
export type LoopField = readonly [label: string, value: string];
export type LoopEvent = { age: string; summary: string; source: string };
export type LoopProfile = { name: string; status: LoopStatus };

export interface LoopData {
  /** Section heading. Omitted when embedded under an existing page heading. */
  heading?: { eyebrow: string; title: string; subtitle: string };
  connectors: {
    items: LoopConnector[];
    moreLabel?: string;
    caption: string;
    /** Optional differentiator line (rendered after a `</>` glyph). */
    codeLine: string;
    /** e.g. "Watching changes across every source" */
    countLabel: string;
  };
  buildsLabel: string;
  memory: {
    /** Eyebrow, e.g. "Live company memory · 19 accounts". */
    label: string;
    /** Entity-type chip, e.g. "account". */
    typeChip: string;
    primary: {
      name: string;
      contact?: string;
      status: LoopStatus;
      fields: LoopField[];
      eventsLabel: string;
      events: LoopEvent[];
    };
    others: LoopProfile[];
    moreLabel?: string;
  };
  goal: {
    label: string;
    schedule: string;
    prompt: string;
    footer: string;
  };
  firesLabel: string;
  chat: UseCase;
  sourceHref?: string;
  docs: { connectors: string; memory: string; watchers: string };
}

function statusColor(tone: LoopStatus["tone"]): string {
  return tone === "risk" ? RISK : OK;
}

// --- Connector logo registry -------------------------------------------------

// Known connector labels → brand mark. Anything not here renders as a text
// chip, so arbitrary per-use-case connectors (Crunchbase, News feeds…) degrade
// gracefully. Keys are matched case-insensitively against the connector label.
const CONNECTOR_ICONS: Record<string, LoopIcon> = {
  hubspot: siHubspot,
  stripe: siStripe,
  zendesk: siZendesk,
  notion: siNotion,
  snowflake: siSnowflake,
  postgres: siPostgresql,
  postgresql: siPostgresql,
  github: siGithub,
  shopify: siShopify,
  linear: siLinear,
  datadog: siDatadog,
  jira: siJira,
  gmail: siGmail,
  drive: siGoogledrive,
  "google drive": siGoogledrive,
};

/** Resolve a connector label to {label, icon?} for the Sources card. */
export function toConnector(label: string): LoopConnector {
  const icon = CONNECTOR_ICONS[label.trim().toLowerCase()];
  return icon ? { label, icon } : { label };
}

// --- Primitives --------------------------------------------------------------

function Eyebrow({ children }: { children: preact.ComponentChildren }) {
  return (
    <span
      class="text-[11px] font-bold uppercase tracking-[0.08em]"
      style={{ color: "var(--color-page-text)" }}
    >
      {children}
    </span>
  );
}

function Card({
  children,
  class: cls = "",
  style = {},
}: {
  children: preact.ComponentChildren;
  class?: string;
  style?: preact.JSX.CSSProperties;
}) {
  return (
    <div
      class={`flex w-full flex-col gap-2.5 rounded-2xl p-5 ${cls}`}
      style={{
        backgroundImage:
          "linear-gradient(to bottom, var(--color-page-bg-elevated), var(--color-page-bg))",
        boxShadow:
          "0 1px 2px rgb(0 0 0 / 0.04), 0 14px 34px -18px rgb(0 0 0 / 0.14)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: LoopStatus }) {
  const color = statusColor(status.tone);
  return (
    <span
      class="rounded-md px-1.5 py-0.5 font-mono text-[10.5px]"
      style={{ color, backgroundColor: `${color}1f` }}
    >
      {status.label}
    </span>
  );
}

function DocLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      class="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10.5px] text-[color:var(--color-page-text-muted)] transition-colors hover:text-[color:var(--color-tg-accent)]"
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function SourceLink({ href }: { href: string }) {
  return (
    <a
      class="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold transition-colors hover:text-[color:var(--color-tg-accent)]"
      href={href}
      rel="noopener noreferrer"
      style={{ color: "var(--color-page-text-muted)" }}
      target="_blank"
    >
      See source <span aria-hidden="true">↗</span>
    </a>
  );
}

function StepText({
  title,
  children,
}: {
  title: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div class="max-w-[360px] px-1 md:px-0">
      <h3
        class="text-[1.45rem] font-bold leading-tight tracking-tight"
        style={{ color: "var(--color-page-text)" }}
      >
        {title}
      </h3>
      <p
        class="mt-2 text-[13.5px] leading-relaxed"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {children}
      </p>
    </div>
  );
}

function TimelineStep({
  number,
  title,
  children,
  visual,
}: {
  number: number;
  title: string;
  children: preact.ComponentChildren;
  visual: preact.ComponentChildren;
  last?: boolean;
}) {
  return (
    <div class="relative z-10 grid w-full grid-cols-[34px_minmax(0,1fr)] items-start gap-x-4 md:grid-cols-[40px_minmax(250px,300px)_minmax(0,460px)] md:items-center md:gap-x-6 md:justify-center">
      <div class="relative col-start-1 row-span-2 self-stretch md:row-span-1 md:row-start-1">
        <span
          class="absolute left-1/2 top-1 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border text-[12px] font-bold md:top-1/2 md:-translate-y-1/2"
          style={{
            borderColor: ACCENT,
            color: ACCENT,
            backgroundColor: "var(--color-page-bg)",
          }}
        >
          {number}
        </span>
      </div>
      <div class="col-start-2 md:row-start-1">
        <StepText title={title}>{children}</StepText>
      </div>
      <div class="col-start-2 mt-3 min-w-0 md:col-start-3 md:row-start-1 md:mt-0">
        {visual}
      </div>
    </div>
  );
}

function BrandLogo({ icon }: { icon: LoopIcon }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      class="shrink-0"
      style={{ fill: "var(--color-page-text-muted)" }}
    >
      <title>{icon.title}</title>
      <path d={icon.path} />
    </svg>
  );
}

function TextChip({ label }: { label: string }) {
  return (
    <span
      class="rounded-md border px-1.5 py-0.5 font-mono text-[10px]"
      style={{
        borderColor: "var(--color-page-border)",
        color: "var(--color-page-text-muted)",
        backgroundColor: "var(--color-page-surface)",
      }}
    >
      {label}
    </span>
  );
}

// Where the agent's reply lands: the team's chat platform, or your own app over
// the API. Same everywhere — Lobu speaks every channel.
function ChatChannels({ class: cls = "" }: { class?: string }) {
  return (
    <div class={`flex flex-col gap-2 px-1 ${cls}`}>
      <span
        class="text-[11px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Replies in your team's chat, or your own app over the API:
      </span>
      <div class="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        {messagingChannels.map((ch) => (
          <a
            key={ch.id}
            href={ch.href}
            title={ch.label}
            aria-label={ch.label}
            class="text-[color:var(--color-page-text-muted)] transition-colors hover:text-[color:var(--color-page-text)]"
          >
            {ch.renderIcon(18)}
          </a>
        ))}
        <a
          href="/sdks/rest-api/"
          class="font-mono text-[11px] text-[color:var(--color-page-text-muted)] transition-colors hover:text-[color:var(--color-tg-accent)]"
        >
          API ↗
        </a>
      </div>
    </div>
  );
}

// --- Blocks ------------------------------------------------------------------

function SourcesCardImpl({
  connectors,
  docsHref,
  class: cls = "",
}: {
  connectors: LoopData["connectors"];
  docsHref: string;
  class?: string;
}) {
  return (
    <Card
      class={`${cls} relative overflow-hidden group`}
      style={{
        backgroundImage: "none",
        backgroundColor: "var(--color-page-bg)",
        boxShadow: "none",
      }}
    >
      <CanvasAurora
        color1={[0.2, 0.35, 0.95]} // Deep Blue
        color2={[0.85, 0.15, 0.4]} // Magenta/Pink
        color3={[0.95, 0.6, 0.15]} // Vibrant Orange
        speed={0.35}
        scale={1.2}
        opacity={0.75}
        blur="2.5px"
        pixelSize={16}
        alignment={[0.85, 0.5]} // Right-aligned glow
        className="absolute inset-0 z-0 h-full w-full pointer-events-none transition-opacity duration-500 opacity-75 group-hover:opacity-90"
      />
      <div class="relative z-10 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {connectors.items.map((c) =>
          c.icon ? (
            <BrandLogo key={c.label} icon={c.icon} />
          ) : (
            <TextChip key={c.label} label={c.label} />
          )
        )}
        {connectors.moreLabel ? (
          <TextChip label={connectors.moreLabel} />
        ) : null}
      </div>

      <div
        class="relative z-10 text-[11.5px] leading-snug"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {connectors.caption}
      </div>

      {connectors.codeLine ? (
        <div class="relative z-10 flex items-center gap-2">
          <span
            class="font-mono text-[12px]"
            style={{ color: ACCENT }}
            aria-hidden="true"
          >
            &lt;/&gt;
          </span>
          <span
            class="text-[12px] leading-snug"
            style={{ color: "var(--color-page-text)" }}
          >
            {connectors.codeLine}
          </span>
        </div>
      ) : null}

      <div class="relative z-10 mt-auto flex items-center justify-between gap-3 pt-2">
        <span
          class="text-[11.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <span style={{ color: "var(--color-page-text)" }}>
            {connectors.countLabel}
          </span>
        </span>
        <DocLink href={docsHref}>Connector SDK</DocLink>
      </div>
    </Card>
  );
}

function MemoryCard({
  memory,
  docsHref,
  class: cls = "",
  scanning = false,
}: {
  memory: LoopData["memory"];
  docsHref: string;
  class?: string;
  scanning?: boolean;
}) {
  const { primary } = memory;
  return (
    <Card class={cls}>
      {memory.label || memory.typeChip ? (
        <div class="flex items-center justify-between">
          {memory.label ? <Eyebrow>{memory.label}</Eyebrow> : <span />}
          {memory.typeChip ? (
            <span
              class="rounded-md px-2 py-0.5 font-mono text-[10.5px]"
              style={{
                backgroundColor: "var(--color-page-surface-dim)",
                color: ACCENT,
              }}
            >
              {memory.typeChip}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Expanded: the record that drifted */}
      <div
        class={`rounded-[10px] ${scanning ? "memory-scan-shell" : ""}`}
        style={{
          backgroundColor: "var(--color-page-surface-dim)",
        }}
      >
        <div class="flex items-start justify-between gap-3 px-3 py-2">
          <div class="min-w-0">
            <div
              class="font-mono text-[13px]"
              style={{ color: "var(--color-page-text)" }}
            >
              {primary.name}
            </div>
            {primary.contact ? (
              <div
                class="truncate font-mono text-[11px]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {primary.contact}
              </div>
            ) : null}
          </div>
          <StatusBadge status={primary.status} />
        </div>

        <div class="flex flex-wrap gap-x-6 gap-y-1 px-3 py-2 font-mono text-[12px]">
          {primary.fields.map((row) => (
            <span key={row[0]}>
              <span style={{ color: "var(--color-page-text-muted)" }}>
                {row[0]}{" "}
              </span>
              <span style={{ color: "var(--color-page-text)" }}>{row[1]}</span>
            </span>
          ))}
        </div>

        {/* Event timeline the values above are derived from */}
        <div class="px-3 py-2.5">
          <div
            class="mb-2 text-[11px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {primary.eventsLabel}
          </div>
          <div class="flex flex-col">
            {primary.events.map((ev, idx) => (
              <div
                key={ev.summary}
                class="grid grid-cols-[14px_1fr] items-start gap-x-2"
              >
                {/* timeline rail: dot + connecting line */}
                <div class="flex flex-col items-center self-stretch">
                  <span
                    class="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        idx === 0 ? statusColor(primary.status.tone) : ACCENT,
                    }}
                  />
                  {idx < primary.events.length - 1 ? (
                    <span
                      class="w-px flex-1"
                      style={{ backgroundColor: "var(--color-page-border)" }}
                    />
                  ) : null}
                </div>
                <div class="pb-2.5">
                  <div
                    class="text-[12px] leading-snug"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    {ev.summary}
                  </div>
                  <div
                    class="font-mono text-[10px]"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    {ev.age} ago · {ev.source}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Collapsed: the rest of the book */}
      {memory.others.map((row) => (
        <div
          key={row.name}
          class="flex items-center justify-between rounded-[10px] px-3 py-2"
          style={{ backgroundColor: "var(--color-page-surface-dim)" }}
        >
          <span
            class="font-mono text-[13px]"
            style={{ color: "var(--color-page-text)" }}
          >
            {row.name}
          </span>
          <StatusBadge status={row.status} />
        </div>
      ))}
      <div class="mt-auto flex items-center justify-between gap-3 pt-0.5">
        <span
          class="text-[11.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {memory.moreLabel}
        </span>
        <DocLink href={docsHref}>Memory &amp; entities</DocLink>
      </div>
    </Card>
  );
}

function GoalCard({
  goal,
  docsHref,
  class: cls = "",
}: {
  goal: LoopData["goal"];
  docsHref: string;
  class?: string;
}) {
  return (
    <Card class={cls}>
      <p
        class="text-[12.5px] leading-relaxed"
        style={{ color: "var(--color-page-text)" }}
      >
        “{goal.prompt}”
      </p>
      <div class="mt-auto flex items-center justify-between gap-3 pt-2">
        <span
          class="text-[11.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {goal.footer || `Runs ${goal.schedule}`}
        </span>
        <DocLink href={docsHref}>Watchers</DocLink>
      </div>
    </Card>
  );
}

// --- Composed component ------------------------------------------------------

export function MemoryLoop({ data }: { data: LoopData }) {
  return (
    <div class="flex flex-col items-center gap-8">
      {data.heading ? (
        <div class="flex flex-col items-center text-center">
          <div
            class="mb-3 font-mono text-[11.5px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: ACCENT }}
          >
            {data.heading.eyebrow}
          </div>
          <h2
            class="font-display text-[1.85rem] font-bold leading-[1.1] tracking-[-0.005em] sm:text-[2.25rem]"
            style={{ color: "var(--color-page-text)" }}
          >
            {data.heading.title}
          </h2>
          <p
            class="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {data.heading.subtitle}
          </p>
          {data.sourceHref ? <SourceLink href={data.sourceHref} /> : null}
        </div>
      ) : null}

      <div class="relative flex w-full max-w-[1040px] flex-col gap-10 md:gap-14">
        <TimelineStep
          number={1}
          title="Connect your data"
          visual={
            <SourcesCardImpl
              connectors={data.connectors}
              docsHref={data.docs.connectors}
            />
          }
        >
          Pick the systems it can read. Lobu turns those updates into live
          customer memory.
        </TimelineStep>

        <TimelineStep
          number={2}
          title="Define the goal"
          visual={<GoalCard goal={data.goal} docsHref={data.docs.watchers} />}
        >
          Tell it what to watch for and when to ask before acting.
        </TimelineStep>

        <TimelineStep
          number={3}
          title="Lobu works autonomously"
          visual={
            <MemoryCard
              memory={data.memory}
              docsHref={data.docs.memory}
              scanning
            />
          }
        >
          It scans memory on schedule, spots the account at risk, and keeps the
          evidence attached.
        </TimelineStep>

        <TimelineStep
          number={4}
          title="You review and approve"
          last
          visual={
            <div
              class="flex w-full flex-col gap-3"
              style={{ minWidth: "280px" }}
            >
              <SampleChat useCase={data.chat} theme={SLACK_THEME} noBorder />
              <ChatChannels />
            </div>
          }
        >
          You can edit the draft, send it, or leave it.
        </TimelineStep>
      </div>
      {!data.heading && data.sourceHref ? (
        <SourceLink href={data.sourceHref} />
      ) : null}
      <style>{`
        @keyframes lobu-memory-scan {
          0%, 12% { transform: translateY(-120%); opacity: 0; }
          22% { opacity: 1; }
          72% { opacity: 1; }
          88%, 100% { transform: translateY(245%); opacity: 0; }
        }
        .memory-scan-shell {
          position: relative;
          overflow: hidden;
        }
        .memory-scan-shell::after {
          content: "";
          position: absolute;
          inset: 0;
          height: 44%;
          pointer-events: none;
          background: linear-gradient(
            to bottom,
            rgba(54, 197, 171, 0),
            rgba(54, 197, 171, 0.08),
            rgba(249, 115, 22, 0.16),
            rgba(54, 197, 171, 0)
          );
          border-top: 1px solid rgba(249, 115, 22, 0.45);
          animation: lobu-memory-scan 4.8s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .memory-scan-shell::after {
            animation: none;
            opacity: 0.35;
            transform: translateY(95%);
          }
        }
      `}</style>
    </div>
  );
}

// --- Homepage config (the renewal-risk story) --------------------------------

export const SALES_LOOP: LoopData = {
  heading: {
    eyebrow: "Why Lobu",
    title: "Catch what you'd miss.",
    subtitle:
      "Most stacks make agents call MCP every turn to reconstruct state. Lobu ingests connectors and webhooks into one append-only log first — so agents resume where the org left off.",
  },
  connectors: {
    items: [
      { label: "HubSpot", icon: siHubspot },
      { label: "Stripe", icon: siStripe },
      { label: "Zendesk", icon: siZendesk },
      { label: "Gmail", icon: siGmail },
      { label: "Drive", icon: siGoogledrive },
      { label: "GitHub", icon: siGithub },
      { label: "Notion", icon: siNotion },
      { label: "Snowflake", icon: siSnowflake },
      { label: "Postgres", icon: siPostgresql },
    ],
    moreLabel: "50+ more",
    caption:
      "Use existing connectors, or let your agent write code to connect any data.",
    codeLine: "",
    countLabel: "Watching changes across every source",
  },
  buildsLabel: "builds customer memory",
  memory: {
    label: "",
    typeChip: "",
    primary: {
      name: "Acme Corp",
      contact: "Jordan Lee, VP Eng",
      status: { label: "at risk", tone: "risk" },
      fields: [
        ["plan", "Enterprise · 120 seats"],
        ["renewal", "Jun 30 · 21 days"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "2d",
          summary: '"API latency on /sync" ticket opened',
          source: "Zendesk",
        },
        {
          age: "5d",
          summary: "Logins fell 38% over 14 days",
          source: "Product",
        },
        { age: "9d", summary: "Renewal date set to Jun 30", source: "CRM" },
      ],
    },
    others: [{ name: "Globex Inc", status: { label: "healthy", tone: "ok" } }],
    moreLabel: "+ 17 more customers",
  },
  goal: {
    label: "Define goal",
    schedule: "every weekday · 9:00",
    prompt:
      "Watch every account for churn risk. If renewal is within 30 days and health drops, draft a CSM check-in for approval.",
    footer: "",
  },
  firesLabel: "posts in Slack",
  sourceHref: `${GITHUB_EXAMPLES_URL}/sales`,
  chat: {
    id: "proactive-renewal",
    tabLabel: "Renewal risk",
    title: "Proactive renewal risk",
    description: "The agent flags churn risk before anyone asks.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Revenue agent",
    botInitial: "R",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Heads up: Acme Corp is trending toward churn. Logins are down 38% over 14 days and their renewal is in 21 days.\n\nWant me to draft a check-in for their CSM?",
        buttons: [{ label: "Draft the email", action: "link" }],
      },
      { role: "user", text: "Yes, and include the usage drop." },
      {
        role: "bot",
        text: "Drafted. Saved it to the Acme account and pinged @dana.",
        buttons: [{ label: "See drafted email", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// --- Per-vertical configs ----------------------------------------------------

// Venture-capital deal sourcing. Grounded in the `market` showcase watcher
// (daily Crunchbase/news/web sweep over portfolio + watchlist).
export const MARKET_LOOP: LoopData = {
  connectors: {
    items: [
      toConnector("Crunchbase"),
      toConnector("PitchBook"),
      toConnector("News feeds"),
      toConnector("Company sites"),
    ],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to scrape sites and feeds.",
    countLabel: "2,400 signals",
  },
  buildsLabel: "builds companies",
  memory: {
    label: "Live deal memory · 312 companies",
    typeChip: "company",
    primary: {
      name: "Lovable",
      contact: "In portfolio · Q4 thesis",
      status: { label: "new round", tone: "ok" },
      fields: [
        ["raised", "$15M Series A"],
        ["lead", "Accel"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "2h",
          summary: "Closed a $15M Series A led by Accel",
          source: "Crunchbase",
        },
        {
          age: "3h",
          summary: "v0, Bolt, Replit Agent posted product signals",
          source: "Market feed",
        },
        {
          age: "5h",
          summary: "Adam K. flagged a warm ex-Replit intro",
          source: "Network",
        },
      ],
    },
    others: [
      { name: "Cursor", status: { label: "watchlist", tone: "ok" } },
      { name: "Vercel", status: { label: "portfolio", tone: "ok" } },
    ],
    moreLabel: "+ 309 more companies",
  },
  goal: {
    label: "Standing goal · portfolio + watchlist",
    schedule: "daily · 8:00",
    prompt:
      "Pull new funding, launches, and market signals on portfolio and watchlist companies, and surface what to track next.",
    footer: "Runs unattended · posts to #deal-flow.",
  },
  firesLabel: "new signal · Lovable",
  chat: {
    id: "market-deal-flow",
    tabLabel: "Deal flow",
    title: "Deal sourcing",
    description: "The agent surfaces new funding and signals each morning.",
    settingsLabel: "",
    chatLabel: "",
    botName: "VC agent",
    botInitial: "V",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Lovable just closed a $15M Series A led by Accel, already in your portfolio. Also worth tracking: v0, Bolt, and Replit Agent in the same prompt-to-app space.\n\nWant an IC memo?",
        buttons: [{ label: "Draft IC memo", action: "link" }],
      },
      { role: "user", text: "Yes, and add the warm intro." },
      {
        role: "bot",
        text: "Drafted. Adam K. (ex-Replit) is a warm path in. Posted it to #deal-flow.",
        buttons: [{ label: "See the memo", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// Legal contract review. Grounded in the `legal` showcase watcher.
export const LEGAL_LOOP: LoopData = {
  connectors: {
    items: [
      toConnector("DocuSign"),
      toConnector("Drive"),
      toConnector("Gmail"),
      toConnector("Jira"),
    ],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to parse contracts and clauses.",
    countLabel: "1,860 events",
  },
  buildsLabel: "builds contracts",
  memory: {
    label: "Live contract memory · 26 contracts",
    typeChip: "contract",
    primary: {
      name: "Redwood NDA v2",
      contact: "Counterparty · Redwood",
      status: { label: "counsel review", tone: "risk" },
      fields: [
        ["clauses", "9 · §7 flagged"],
        ["stage", "pre-signature"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "2h",
          summary: "Uploaded NDA v2 for signature review",
          source: "Redwood",
        },
        {
          age: "2h",
          summary: "Updated indemnity language in §7",
          source: "DocuSign",
        },
        {
          age: "1h",
          summary: "Lena needs a readout before the call",
          source: "Slack",
        },
      ],
    },
    others: [
      { name: "Acme MSA", status: { label: "clear", tone: "ok" } },
      { name: "Globex DPA", status: { label: "clear", tone: "ok" } },
    ],
    moreLabel: "+ 24 more contracts",
  },
  goal: {
    label: "Standing goal · every new contract",
    schedule: "on new contract",
    prompt:
      "Review new contracts for risk, flag clauses that need counsel approval, and file a review ticket.",
    footer: "Runs unattended · files to #legal-reviews.",
  },
  firesLabel: "flagged · Redwood NDA",
  chat: {
    id: "legal-review",
    tabLabel: "Contract review",
    title: "Contract review",
    description: "The agent flags risky clauses before you countersign.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Legal agent",
    botInitial: "L",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Heads up: Redwood NDA §7 has uncapped indemnity, the same pattern that blocked the Acme NDA in September. It needs counsel sign-off before you countersign.\n\nWant me to file a review ticket?",
        buttons: [{ label: "File review ticket", action: "link" }],
      },
      { role: "user", text: "Yes, assign it to Priya." },
      {
        role: "bot",
        text: "Filed REV-88 with Priya and linked §7 to the Redwood record. Posted to #legal-reviews.",
        buttons: [{ label: "See the review", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// Finance reconciliation. Grounded in the `finance` showcase watcher.
export const FINANCE_LOOP: LoopData = {
  connectors: {
    items: [
      toConnector("Stripe"),
      toConnector("NetSuite"),
      toConnector("Snowflake"),
      toConnector("Postgres"),
    ],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to reconcile any ledger.",
    countLabel: "9,300 events",
  },
  buildsLabel: "builds accounts",
  memory: {
    label: "Live finance memory · 40 accounts",
    typeChip: "account",
    primary: {
      name: "Account 4100",
      contact: "Merchant · STR-44",
      status: { label: "variance", tone: "risk" },
      fields: [
        ["balance", "$187,420"],
        ["variance", "$12,480"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "9m",
          summary: "Opened with a $12,480 variance",
          source: "NetSuite",
        },
        {
          age: "7m",
          summary: "3 refunds settled after the cutoff",
          source: "Stripe",
        },
        {
          age: "4m",
          summary: "Month-end reconciliation note due",
          source: "Close checklist",
        },
      ],
    },
    others: [
      { name: "Account 4000", status: { label: "reconciled", tone: "ok" } },
      { name: "Account 5200", status: { label: "reconciled", tone: "ok" } },
    ],
    moreLabel: "+ 38 more accounts",
  },
  goal: {
    label: "Standing goal · every ledger account",
    schedule: "daily · 7:00",
    prompt:
      "Reconcile payment sources against the ledger, explain any variances, and prep the reconciliation note.",
    footer: "Runs unattended · posts to #finance-digest.",
  },
  firesLabel: "variance · Account 4100",
  chat: {
    id: "finance-recon",
    tabLabel: "Reconciliation",
    title: "Reconciliation",
    description: "The agent explains variances and preps the month-end note.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Finance agent",
    botInitial: "F",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "The 4100 variance traces to merchant STR-44, the same 3-day settlement lag we saw in September, $12,480 net.\n\nWant me to draft the month-end note?",
        buttons: [{ label: "Draft the note", action: "link" }],
      },
      { role: "user", text: "Yes, ready it for sign-off." },
      {
        role: "bot",
        text: "Drafted and ready for your sign-off. Posted to #finance-digest.",
        buttons: [{ label: "See the note", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// Exec / board summaries. Grounded in the `leadership` showcase watcher.
export const LEADERSHIP_LOOP: LoopData = {
  connectors: {
    items: [toConnector("Notion"), toConnector("Drive"), toConnector("Gmail")],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to read memos and minutes.",
    countLabel: "live feed",
  },
  buildsLabel: "builds decisions",
  memory: {
    label: "Live decision memory · 11 memos",
    typeChip: "decision",
    primary: {
      name: "Board memo Q4",
      contact: "Owner · Priya",
      status: { label: "action needed", tone: "risk" },
      fields: [
        ["approved", "Series A bridge"],
        ["blocked", "Frankfurt lease"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "1h",
          summary: "Board memo Q4 posted to the exec workspace",
          source: "Notion",
        },
        {
          age: "1h",
          summary: "Bridge approved, hiring freeze reaffirmed",
          source: "Board notes",
        },
        {
          age: "55m",
          summary: "Frankfurt lease counter due Apr 25",
          source: "Slack",
        },
      ],
    },
    others: [
      { name: "Board memo Q3", status: { label: "closed", tone: "ok" } },
      { name: "Offsite plan", status: { label: "approved", tone: "ok" } },
    ],
    moreLabel: "+ 9 more memos",
  },
  goal: {
    label: "Standing goal · every board memo",
    schedule: "on new memo",
    prompt:
      "Summarize new board memos: what was approved, what is blocked, and who owns each next action.",
    footer: "Runs unattended · posts to #exec-digest.",
  },
  firesLabel: "new memo · Board Q4",
  chat: {
    id: "leadership-digest",
    tabLabel: "Board digest",
    title: "Board digest",
    description: "The agent turns board memos into owners and next actions.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Chief of staff",
    botInitial: "C",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Board approved the $4M Series A bridge and the Q1 hiring freeze. Blocked: the Frankfurt lease, pending legal diligence.\n\nWant the exec digest with owners?",
        buttons: [{ label: "Draft the digest", action: "link" }],
      },
      { role: "user", text: "Yes, and flag Priya's deadline." },
      {
        role: "bot",
        text: "Drafted. Priya owns the Frankfurt counter, due Fri Apr 25. Posted to #exec-digest.",
        buttons: [{ label: "See the digest", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// Community member matchmaking. Grounded in the `agent-community` watcher.
export const COMMUNITY_LOOP: LoopData = {
  connectors: {
    items: [
      toConnector("GitHub"),
      toConnector("LinkedIn"),
      toConnector("Notion"),
    ],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to pull profiles and launches.",
    countLabel: "live feed",
  },
  buildsLabel: "builds members",
  memory: {
    label: "Live member memory · 315 members",
    typeChip: "member",
    primary: {
      name: "Sarah",
      contact: "Needs · embeddings, MCP",
      status: { label: "wants intros", tone: "ok" },
      fields: [
        ["topics", "embeddings · MCP"],
        ["matches", "Devon · Mira"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "15m",
          summary: "Asked for two intros in embeddings infra",
          source: "Sarah",
        },
        {
          age: "9m",
          summary: "Devon shipped an embeddings eval harness",
          source: "GitHub",
        },
        {
          age: "3m",
          summary: "Mira posted an MCP auth breakdown",
          source: "Community feed",
        },
      ],
    },
    others: [
      { name: "Devon Lin", status: { label: "open to intros", tone: "ok" } },
      { name: "Mira Sato", status: { label: "active", tone: "ok" } },
    ],
    moreLabel: "+ 312 more members",
  },
  goal: {
    label: "Standing goal · every member + launch",
    schedule: "every 15 min",
    prompt:
      "Match community members to new launches and posts in their space, and draft intro messages for the best two matches.",
    footer: "Runs unattended · posts to #community-matches.",
  },
  firesLabel: "matched · Sarah",
  chat: {
    id: "community-matches",
    tabLabel: "Matchmaking",
    title: "Member matchmaking",
    description: "The agent matches members and drafts the intros.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Community agent",
    botInitial: "C",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Top matches for Sarah this week: Devon Lin (shipped a similar embeddings eval harness) and Mira Sato (deep MCP work).\n\nWant me to draft intros to both?",
        buttons: [{ label: "Draft intros", action: "link" }],
      },
      { role: "user", text: "Yes, reference Devon's repo." },
      {
        role: "bot",
        text: "Drafted both, referencing Devon's repo and Mira's post. Queued in your outbox.",
        buttons: [{ label: "See the intros", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// Delivery / rollout tracking. Authored from the `delivery` watcher data.
// Not a featured /for page yet — kept ready for when it ships.
export const DELIVERY_LOOP: LoopData = {
  connectors: {
    items: [
      toConnector("Linear"),
      toConnector("Datadog"),
      toConnector("GitHub"),
      toConnector("Slack"),
    ],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to pull rollout and error data.",
    countLabel: "5,100 events",
  },
  buildsLabel: "builds projects",
  memory: {
    label: "Live delivery memory · 14 projects",
    typeChip: "project",
    primary: {
      name: "Phoenix rollout",
      contact: "Owner · Lena (backend)",
      status: { label: "blocked", tone: "risk" },
      fields: [
        ["progress", "72% · 28 shards"],
        ["blocker", "shard-14"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "30m",
          summary: "Marked 72% complete, 28 shards pending",
          source: "Linear",
        },
        {
          age: "25m",
          summary: "shard-14 DB timeouts since 03:14",
          source: "Datadog",
        },
        {
          age: "20m",
          summary: "Rahul wants an escalation draft ready",
          source: "Slack",
        },
      ],
    },
    others: [
      { name: "Apollo", status: { label: "shipped", tone: "ok" } },
      { name: "Orion", status: { label: "on track", tone: "ok" } },
    ],
    moreLabel: "+ 11 more projects",
  },
  goal: {
    label: "Standing goal · active rollouts",
    schedule: "weekdays · 8:00",
    prompt:
      "Give me the Monday Phoenix rollout update with blockers, owners, and the next escalation.",
    footer: "Runs unattended · posts to #delivery-standup.",
  },
  firesLabel: "blocked · Phoenix",
  chat: {
    id: "delivery-standup",
    tabLabel: "Rollout",
    title: "Rollout status",
    description:
      "The agent flags blockers with owners and the next escalation.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Delivery agent",
    botInitial: "D",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Phoenix is blocked on shard-14, the same pattern as the Apollo rollout. Lena owns the backend fix.\n\nWant an escalation draft for Rahul?",
        buttons: [{ label: "Draft escalation", action: "link" }],
      },
      { role: "user", text: "Yes, send if it's not cleared by Tuesday." },
      {
        role: "bot",
        text: "Drafted. Queued to Rahul if shard-14 isn't cleared by end of day Tuesday. Posted to #delivery-standup.",
        buttons: [{ label: "See the draft", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// E-commerce subscription ops. Authored from the `ecommerce` watcher data.
// Not a featured /for page yet — kept ready for when it ships.
export const ECOMMERCE_LOOP: LoopData = {
  connectors: {
    items: [
      toConnector("Shopify"),
      toConnector("Stripe"),
      toConnector("Zendesk"),
      toConnector("Gmail"),
    ],
    moreLabel: "50+ more",
    caption:
      "Reuse a prebuilt connector, or point Lobu at any database you use.",
    codeLine: "Your agent writes code to drive any storefront.",
    countLabel: "12,400 events",
  },
  buildsLabel: "builds customers",
  memory: {
    label: "Live customer memory · 1,243 customers",
    typeChip: "customer",
    primary: {
      name: "Emma K",
      contact: "Plan · monthly $20/mo",
      status: { label: "change request", tone: "ok" },
      fields: [
        ["next ship", "Apr 3"],
        ["cancel risk", "low"],
      ],
      eventsLabel: "Derived from recent events:",
      events: [
        {
          age: "5m",
          summary: "Asked to switch to annual, skip next box",
          source: "Customer DM",
        },
        {
          age: "4m",
          summary: "Next shipment scheduled for Apr 3",
          source: "Shopify",
        },
        {
          age: "2m",
          summary: "Last cancel attempt was in the Aug window",
          source: "Retention log",
        },
      ],
    },
    others: [
      { name: "Liam T", status: { label: "active", tone: "ok" } },
      { name: "Noah P", status: { label: "active", tone: "ok" } },
    ],
    moreLabel: "+ 1,240 more customers",
  },
  goal: {
    label: "Standing goal · every subscription request",
    schedule: "on new request",
    prompt:
      "Switch Emma's subscription from monthly to annual and skip next month's delivery.",
    footer: "Runs unattended · replies in the customer DM.",
  },
  firesLabel: "request · Emma K",
  chat: {
    id: "ecommerce-subs",
    tabLabel: "Subscriptions",
    title: "Subscription change",
    description: "The agent handles subscription changes with your approval.",
    settingsLabel: "",
    chatLabel: "",
    botName: "Store agent",
    botInitial: "S",
    botColor: "#36c5ab",
    messages: [
      {
        role: "bot",
        text: "Emma wants to move monthly to annual and skip April's box. Annual is $199/yr (saves $48), and she's low cancel-risk.\n\nMake the change?",
        buttons: [{ label: "Make the change", action: "link" }],
      },
      { role: "user", text: "Yes, and confirm by email." },
      {
        role: "bot",
        text: "Switched to annual and skipped April; next delivery May 3. Confirmation email queued.",
        buttons: [{ label: "See the order", action: "link" }],
      },
    ],
  },
  docs: {
    connectors: "/sdks/connectors/",
    memory: "/getting-started/memory/",
    watchers: "/getting-started/memory/#watchers",
  },
};

// Hand-authored loops, keyed by the showcase id each /for/<slug> page resolves
// to. The six featured verticals render today; delivery + ecommerce are
// authored and ready but have no /for page yet. loopForUseCase falls back to
// SALES_LOOP for any unknown slug.
const USE_CASE_LOOPS: Record<string, LoopData> = {
  sales: SALES_LOOP,
  market: MARKET_LOOP,
  legal: LEGAL_LOOP,
  finance: FINANCE_LOOP,
  leadership: LEADERSHIP_LOOP,
  "agent-community": COMMUNITY_LOOP,
  delivery: DELIVERY_LOOP,
  ecommerce: ECOMMERCE_LOOP,
};

/** The authored loop for a /for/<slug> page, or null to use the fallback. */
export function loopForUseCase(slug?: string): LoopData | null {
  if (!slug) return null;
  return USE_CASE_LOOPS[slug] ?? null;
}

/** Homepage wrapper: the canonical renewal-risk loop. */
export function ProactiveLoop() {
  return <MemoryLoop data={SALES_LOOP} />;
}
