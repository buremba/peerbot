import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type {
  LandingUseCaseDefinition,
  LandingUseCaseId,
} from "../use-case-definitions";
import { landingUseCases } from "../use-case-definitions";
import type { HeroStageId } from "./HeroSection";

const ENTITY_EMOJI_FALLBACKS: Record<string, string> = {
  // Core
  Member: "👤",
  Person: "👤",
  Asset: "💼",
  Subscription: "💳",
  Topic: "🗂",
  Trip: "✈️",
  Decision: "✅",
  Preference: "⚙️",
  Document: "📄",
  Report: "📊",
  Post: "📝",
  Task: "✅",
  Order: "📦",
  Transaction: "💸",
  Match: "🔗",
  // Legal
  Contract: "📜",
  Clause: "📑",
  Risk: "⚠️",
  Counterparty: "🏛",
  // Engineering
  Incident: "🚨",
  PR: "🔧",
  "Pull Request": "🔧",
  Service: "🧩",
  Deploy: "🚀",
  Blocker: "⛔",
  Milestone: "🚩",
  // Support
  Customer: "👥",
  Issue: "🐞",
  Ticket: "🎫",
  Article: "📚",
  // Sales
  Lead: "🎯",
  Account: "🏢",
  Organization: "🏢",
  Deal: "💰",
  Opportunity: "✨",
  Region: "🌍",
  Team: "👥",
  "Renewal Risk": "⏳",
  Product: "📦",
  // Finance / strategy
  Owner: "🧑‍💼",
  Initiative: "🧭",
  Project: "📐",
  Stakeholder: "🧑‍💻",
  Invoice: "🧾",
  Budget: "📊",
  Vendor: "🛒",
  Forecast: "📈",
  Variance: "📉",
  // Market / VC
  Company: "🏢",
  Founder: "🧑‍🚀",
  "Fund Round": "💰",
  Investor: "🏦",
  "Job Posting": "📋",
  Sector: "🏭",
};

function entityEmoji(label: string): string {
  if (ENTITY_EMOJI_FALLBACKS[label]) return ENTITY_EMOJI_FALLBACKS[label];
  // try plural/singular variants
  if (label.endsWith("s") && ENTITY_EMOJI_FALLBACKS[label.slice(0, -1)]) {
    return ENTITY_EMOJI_FALLBACKS[label.slice(0, -1)];
  }
  return "📄";
}

function pluralize(label: string): string {
  if (label.endsWith("s")) return label;
  if (label.endsWith("y")) {
    const prev = label[label.length - 2]?.toLowerCase() ?? "";
    if (!"aeiou".includes(prev)) return `${label.slice(0, -1)}ies`;
  }
  return `${label}s`;
}

function entityCountSeed(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(h % 900) + 24;
}

function buildSidebarEntities(
  useCase: LandingUseCaseDefinition
): EntityNavItem[] {
  return useCase.model.entities.map((label, i) => ({
    label: pluralize(label),
    emoji: entityEmoji(label),
    count: entityCountSeed(label),
    active: i === 0,
  }));
}

/* ------------------------------ data adapters ------------------------------ */

const TONE_BY_INDEX: Array<"amber" | "violet" | "green" | "muted"> = [
  "amber",
  "violet",
  "green",
  "amber",
  "violet",
];
const RELATIVE_TIMES = ["Just now", "12m ago", "2h ago", "1d ago", "5d ago"];

function stripLabelPrefix(label: string): string {
  const match = label.match(/^[A-Za-z][A-Za-z ]*?:\s*(.*)$/);
  return match ? match[1] : label;
}

export type RecordRow = {
  id: string;
  name: string;
  summary: string;
  type: string;
  typeTone: "amber" | "violet" | "green" | "muted";
  tag: string;
  tagTone: "amber" | "violet" | "green" | "muted";
  updated: string;
};

function buildRecordRows(useCase: LandingUseCaseDefinition): RecordRow[] {
  const children = useCase.memory.recordTree.children ?? [];
  return children.map((child, i) => {
    const tag = child.chips?.[0] ?? "memory";
    return {
      id: child.id,
      name: stripLabelPrefix(child.label),
      summary: child.summary,
      type: child.kind,
      typeTone: TONE_BY_INDEX[i % TONE_BY_INDEX.length],
      tag,
      tagTone: TONE_BY_INDEX[(i + 2) % TONE_BY_INDEX.length],
      updated: RELATIVE_TIMES[i % RELATIVE_TIMES.length],
    };
  });
}

export type ConnectorConnection = {
  member: string;
  email: string;
  account: string;
  lastSync: string;
  status: "Active" | "Idle" | "Error";
};

export type ConnectorRow = {
  id: string;
  name: string;
  description: string;
  status: "Connected" | "Available";
  connections: ConnectorConnection[];
};

const SAMPLE_MEMBERS: Array<{ name: string; email: string }> = [
  { name: "Albert Lund", email: "albert@runway.io" },
  { name: "Jenna Roberts", email: "jenna@flatfile.com" },
  { name: "David Chen", email: "david@modal.dev" },
  { name: "Marc Lopez", email: "marc@listen.ai" },
  { name: "Priya Shah", email: "priya@northstar.io" },
  { name: "Sam Park", email: "sam@greenleaf.app" },
];

function synthAccount(name: string, label: string): string {
  const slug = name.split(" ")[0]?.toLowerCase() ?? "user";
  const lower = label.toLowerCase();
  if (lower.includes("github")) return `@${slug}`;
  if (lower.includes("slack") || lower.includes("teams"))
    return "lobu-prod.workspace";
  if (lower.includes("linear")) return "lobu workspace";
  if (lower.includes("gmail")) return `${slug}@example.com`;
  if (lower.includes("drive")) return `${slug} · Drive`;
  if (lower.includes("upload")) return "Manual upload";
  if (lower.includes("research")) return `${slug} · API key`;
  return `${slug}@lobu`;
}

const SYNC_TIMES = ["Just now", "2m ago", "14m ago", "1h ago", "8m ago"];

function buildSampleConnections(
  label: string,
  count: number
): ConnectorConnection[] {
  return SAMPLE_MEMBERS.slice(0, count).map((m, i) => ({
    member: m.name,
    email: m.email,
    account: synthAccount(m.name, label),
    lastSync: SYNC_TIMES[i % SYNC_TIMES.length],
    status: i === 2 ? "Idle" : "Active",
  }));
}

const BRAND_NAME_OVERRIDES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  pagerduty: "PagerDuty",
  zendesk: "Zendesk",
  notion: "Notion",
  linear: "Linear",
  slack: "Slack",
  gmail: "Gmail",
  postgres: "Postgres",
  datadog: "Datadog",
  sentry: "Sentry",
  stripe: "Stripe",
  intercom: "Intercom",
  jira: "Jira",
};

function brandName(slug: string): string {
  const lower = slug.toLowerCase();
  return (
    BRAND_NAME_OVERRIDES[lower] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
  );
}

function buildConnectors(useCase: LandingUseCaseDefinition): ConnectorRow[] {
  const connectStep = useCase.memory.howItWorks.find((s) => s.id === "connect");
  const chips = connectStep?.chips ?? [];
  const domains = useCase.skills.allowedDomains ?? [];
  const fromChips = chips.map((label, i) => {
    const connections =
      i < 2 ? buildSampleConnections(label, i === 0 ? 3 : 2) : [];
    return {
      id: `chip-${i}`,
      name: label,
      description: `${label} integration`,
      status: (connections.length > 0
        ? "Connected"
        : "Available") as ConnectorRow["status"],
      connections,
    };
  });
  const fromDomains = domains.slice(0, 3).map((domain, i) => {
    const slug = domain.replace(/^\*\.|^api\./, "").split(".")[0];
    return {
      id: `domain-${i}`,
      name: brandName(slug),
      description: domain,
      status: "Connected" as const,
      connections: buildSampleConnections(slug, 1),
    };
  });
  const seen = new Set<string>();
  return [...fromChips, ...fromDomains].filter((c) => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type WatcherRow = {
  name: string;
  entity: string;
  agent: string;
  status: "Active" | "Inactive";
  schedule: string;
  last: string;
};

function buildWatcherRows(useCase: LandingUseCaseDefinition): WatcherRow[] {
  const watcher = useCase.memory.watcher;
  const primary = useCase.model.entities[0] ?? "Record";
  const second = useCase.model.entities[1] ?? primary;
  const agentLabel = `${useCase.label} agent`;
  return [
    {
      name: watcher.name,
      entity: primary,
      agent: agentLabel,
      status: "Active",
      schedule: watcher.schedule,
      last: "Just now",
    },
    {
      name: `${second} change tracker`,
      entity: second,
      agent: agentLabel,
      status: "Active",
      schedule: "every 30m",
      last: "12m ago",
    },
    {
      name: `${primary} digest`,
      entity: primary,
      agent: agentLabel,
      status: "Inactive",
      schedule: "*/15 * * * *",
      last: "—",
    },
  ];
}

export type AgentRow = {
  name: string;
  entryPoint: string;
  skills: string[];
  status: "Active" | "Paused";
  last: string;
};

const ENTRY_POINT_OPTIONS = ["OpenClaw", "Slack", "ChatGPT", "Telegram"];

const FALLBACK_AGENT_SKILLS: Record<string, string[]> = {
  legal: ["contract-review", "clause-risk", "legal-memory"],
  engineering: ["incident-triage", "github-prs", "deploy-watch"],
  support: ["ticket-triage", "crm-lookup", "reply-drafts"],
  finance: ["reconciliation", "stripe", "close-review"],
  sales: ["account-research", "crm-sync", "renewal-risk"],
  leadership: ["decision-brief", "risk-summary", "follow-ups"],
  "agent-community": ["member-intros", "event-digest", "moderation"],
  market: ["deal-research", "founder-signals", "portfolio-news"],
};

function buildAgentRows(useCase: LandingUseCaseDefinition): AgentRow[] {
  const skills = useCase.skills.skills.length
    ? useCase.skills.skills
    : (FALLBACK_AGENT_SKILLS[useCase.id] ?? [
        useCase.skills.skillId,
        "memory-sync",
        "source-monitor",
      ]);
  const baseAgent = useCase.skills.agentId ?? `${useCase.id}-agent`;
  const watcherName = useCase.memory.watcher.name;
  return [
    {
      name: baseAgent,
      entryPoint: ENTRY_POINT_OPTIONS[0],
      skills: skills.slice(0, 2),
      status: "Active",
      last: "Just now",
    },
    {
      name: watcherName,
      entryPoint: ENTRY_POINT_OPTIONS[1],
      skills: skills.slice(2, 4),
      status: "Active",
      last: "14m ago",
    },
    {
      name: `${useCase.label.toLowerCase()} digest`,
      entryPoint: ENTRY_POINT_OPTIONS[2],
      skills: skills.slice(0, 1),
      status: "Paused",
      last: "—",
    },
  ];
}

export type AgentInfo = {
  identity: string;
  mcpEndpoint: string;
  primaryClient: string;
};

function buildAgentInfo(useCase: LandingUseCaseDefinition): AgentInfo {
  return {
    identity: useCase.agent.identity?.[0] ?? `${useCase.label} agent`,
    mcpEndpoint: "https://lobu.ai/mcp",
    primaryClient: "Claude",
  };
}

export type KnowledgeRow = {
  id: string;
  title: string;
  type: string;
  summary: string;
  chips: string[];
  highlights: { label: string; value: string }[];
  occurredAt: string;
};

function buildKnowledgeRows(useCase: LandingUseCaseDefinition): KnowledgeRow[] {
  const children = useCase.memory.recordTree.children ?? [];
  const nodeHighlights = useCase.memory.nodeHighlights ?? {};
  return children.map((child, i) => ({
    id: child.id,
    title: stripLabelPrefix(child.label),
    type: child.kind,
    summary: child.summary,
    chips: child.chips ?? [],
    highlights: nodeHighlights[child.id] ?? [],
    occurredAt: RELATIVE_TIMES[i % RELATIVE_TIMES.length],
  }));
}

/* ------------------------------ icons ------------------------------ */

function SparklesIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  );
}

function BotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="4"
        y="8"
        width="16"
        height="11"
        rx="2"
        stroke="currentColor"
        stroke-width="1.6"
      />
      <path
        d="M12 4v4"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}

function UsersIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.6" />
      <path
        d="M3 19c0-3 2.7-5 6-5s6 2 6 5M16 13a3 3 0 1 0 0-6"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
      <path
        d="M21 19c0-2.4-1.7-4.2-4-4.8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

function ConnectorsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.8 10.2a4 4 0 0 0-5.6 0l-4 4a4 4 0 1 0 5.6 5.7l1.1-1.1m-.7-4.9a4 4 0 0 0 5.6 0l4-4a4 4 0 0 0-5.6-5.7l-1.1 1.1"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function KnowledgeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function WatchersIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9.7 17h4.7M12 3v1M18.4 5.6l-.7.7M21 12h-1M4 12H3M6.3 6.3l-.7-.7M8.4 15.6a5 5 0 1 1 7.1 0l-.5.5A3.4 3.4 0 0 0 14 18.5V19a2 2 0 1 1-4 0v-.5a3.4 3.4 0 0 0-1-2.4l-.6-.5Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ChevronDownSmall() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
      <path
        d="m11 11 3 3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

/* ------------------------------ data ------------------------------ */

type EntityNavItem = {
  label: string;
  emoji: string;
  count: number;
  active?: boolean;
};

const DEFAULT_ENTITIES: EntityNavItem[] = [
  { label: "Members", emoji: "👤", count: 832, active: true },
  { label: "Assets", emoji: "💼", count: 2 },
  { label: "Subscriptions", emoji: "💳", count: 14 },
  { label: "Topics", emoji: "🗂", count: 38 },
  { label: "Trips", emoji: "✈️", count: 6 },
];

/* ------------------------------ shell ------------------------------ */

function Sidebar({
  activeNav,
  editMode,
  onStageChange,
  entities,
}: {
  activeNav: "members" | "connectors" | "watchers" | "agents" | "knowledge";
  editMode?: boolean;
  onStageChange?: (stage: HeroStageId) => void;
  entities: EntityNavItem[];
}) {
  const sidebarBg = "var(--color-page-surface-dim)";
  const fg = "var(--color-page-text)";
  const fgMuted = "var(--color-page-text-muted)";
  const fgFaint = "var(--color-page-text-muted)";
  const accentBg = "var(--color-page-surface-dim)";

  function NavRow({
    icon,
    label,
    count,
    active,
    onClick,
  }: {
    icon: ComponentChildren;
    label: string;
    count?: number;
    active?: boolean;
    onClick?: () => void;
  }) {
    const interactive = Boolean(onClick);
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={!interactive}
        class="flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] w-full text-left transition-colors hover:bg-[rgba(0,0,0,0.04)] disabled:cursor-default disabled:hover:bg-transparent"
        style={{
          color: active ? fg : fgMuted,
          background: active ? accentBg : "transparent",
          fontWeight: active ? 600 : 500,
          cursor: interactive ? "pointer" : "default",
        }}
      >
        <span style={{ color: active ? fg : fgMuted }}>{icon}</span>
        <span class="flex-1 truncate">{label}</span>
        {count != null ? (
          <span class="text-[11px] tabular-nums" style={{ color: fgFaint }}>
            {count}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <aside
      class="hidden md:flex flex-col"
      style={{
        background: sidebarBg,
        borderRight: "1px solid var(--color-page-border)",
        width: "232px",
        minWidth: "232px",
      }}
    >
      {/* Header (h-14) */}
      <div
        class="flex items-center justify-between px-2"
        style={{
          height: "56px",
          borderBottom: "1px solid var(--color-page-border)",
        }}
      >
        <div
          class="flex items-center gap-2 px-1.5 py-1 rounded-md"
          style={{ color: fg }}
        >
          <span
            class="inline-flex items-center justify-center w-5 h-5 rounded text-[11px] font-bold text-white"
            style={{ background: "var(--color-tg-accent)" }}
            aria-hidden="true"
          >
            L
          </span>
          <span class="text-[13px] font-semibold">lobu-prod</span>
          <span style={{ color: fgFaint }}>
            <ChevronDownSmall />
          </span>
        </div>
        <div
          class="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px]"
          style={{
            background: "rgba(0,0,0,0.04)",
            color: fgMuted,
          }}
        >
          <SearchIcon size={11} />
          <span class="font-mono">⌘K</span>
        </div>
      </div>

      {/* Nav */}
      <div class="flex-1 px-2 py-3 flex flex-col gap-3 overflow-hidden">
        <div>
          <NavRow icon={<SparklesIcon />} label="Dashboard" />
        </div>

        {/* Entities section */}
        <div>
          <div class="flex items-center justify-between px-3 py-1 mb-0.5">
            <div
              class="text-[11px] font-medium uppercase tracking-wider"
              style={{ color: fgMuted }}
            >
              Entities
            </div>
            <span
              class="inline-flex items-center justify-center w-3.5 h-3.5"
              style={{ color: editMode ? fg : fgFaint }}
              aria-hidden="true"
            >
              <PencilIcon size={10} />
            </span>
          </div>
          <ul class="flex flex-col gap-0.5">
            {entities.map((item) => (
              <li key={item.label} class="flex items-center group">
                <button
                  type="button"
                  onClick={() => onStageChange?.("model")}
                  class="flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] flex-1 min-w-0 text-left transition-colors hover:bg-[rgba(0,0,0,0.04)]"
                  style={{
                    color: item.active ? fg : fgMuted,
                    background: item.active ? accentBg : "transparent",
                    fontWeight: item.active ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  <span class="w-5 text-center text-[13px]" aria-hidden="true">
                    {item.emoji}
                  </span>
                  <span class="flex-1 truncate">{item.label}</span>
                  {!editMode ? (
                    <span
                      class="text-[11px] tabular-nums"
                      style={{ color: fgFaint }}
                    >
                      {item.count}
                    </span>
                  ) : null}
                </button>
                {editMode ? (
                  <span
                    class="shrink-0 p-1 mr-1 rounded"
                    style={{ color: fgFaint }}
                    aria-hidden="true"
                  >
                    <PencilIcon size={11} />
                  </span>
                ) : null}
              </li>
            ))}
            <li
              class="flex items-center gap-2 px-3 py-1.5 text-[13px]"
              style={{
                color: fgMuted,
                visibility: editMode ? "visible" : "hidden",
              }}
              aria-hidden={!editMode}
            >
              <PlusIcon size={12} />
              <span>Add entity type</span>
            </li>
          </ul>
        </div>

        {/* Divider + section nav */}
        <div
          class="mx-3"
          style={{
            borderTop: "1px solid var(--color-page-border)",
            height: "1px",
          }}
        />
        <ul class="flex flex-col gap-0.5">
          <li>
            <NavRow
              icon={<ConnectorsIcon />}
              label="Connectors"
              count={42}
              active={activeNav === "connectors"}
              onClick={() => onStageChange?.("integrate")}
            />
          </li>
          <li>
            <NavRow
              icon={<KnowledgeIcon />}
              label="Knowledge"
              count={1284}
              active={activeNav === "knowledge"}
              onClick={() => onStageChange?.("knowledge")}
            />
          </li>
          <li>
            <NavRow
              icon={<WatchersIcon />}
              label="Watchers"
              count={9}
              active={activeNav === "watchers"}
              onClick={() => onStageChange?.("watch")}
            />
          </li>
          <li>
            <NavRow
              icon={<BotIcon />}
              label="Agents"
              active={activeNav === "agents"}
              onClick={() => onStageChange?.("connect")}
            />
          </li>
        </ul>
      </div>
      {/* User footer */}
      <div
        class="px-3 py-3 flex items-center gap-2"
        style={{ borderTop: "1px solid var(--color-page-border)" }}
      >
        <div
          class="h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-semibold"
          style={{ background: "rgba(0,0,0,0.08)", color: fg }}
          aria-hidden="true"
        >
          B
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[12px] font-medium truncate" style={{ color: fg }}>
            Emre
          </div>
          <div class="text-[11px] truncate" style={{ color: fgMuted }}>
            emre@lobu.ai
          </div>
        </div>
        <span style={{ color: fgFaint }}>
          <ChevronDownSmall />
        </span>
      </div>
    </aside>
  );
}

function AppShell({
  activeNav,
  editMode,
  pageTitle,
  pageSubtitle,
  toolbar,
  children,
  rightPanel,
  onStageChange,
  entities,
}: {
  activeNav: "members" | "connectors" | "watchers" | "agents" | "knowledge";
  editMode?: boolean;
  entities: EntityNavItem[];
  pageTitle: string;
  pageSubtitle?: string;
  toolbar?: ComponentChildren;
  children: ComponentChildren;
  rightPanel?: ComponentChildren;
  onStageChange?: (stage: HeroStageId) => void;
}) {
  return (
    <div
      class="max-w-[72rem] mx-auto rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-[232px_1fr] relative bg-[var(--color-page-surface)]"
      style={{
        border: "1px solid var(--color-page-border)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.06)",
        height: "640px",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      <Sidebar
        activeNav={activeNav}
        editMode={editMode}
        onStageChange={onStageChange}
        entities={entities}
      />

      <div class="relative flex flex-col min-h-0 overflow-hidden">
        {/* Breadcrumb + page header */}
        <div
          class="px-6 pt-5 pb-4"
          style={{ borderBottom: "1px solid var(--color-page-border)" }}
        >
          <div
            class="flex items-center gap-1 text-[12px] mb-1"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            <span>lobu-prod</span>
            <span aria-hidden="true">/</span>
            <span style={{ color: "var(--color-page-text)" }}>{pageTitle}</span>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <div class="flex flex-col">
              <h3
                class="font-display text-[20px] font-semibold leading-tight"
                style={{
                  color: "var(--color-page-text)",
                  letterSpacing: "-0.01em",
                }}
              >
                {pageTitle}
              </h3>
              {pageSubtitle ? (
                <p
                  class="text-[12px] mt-0.5"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {pageSubtitle}
                </p>
              ) : null}
            </div>
            {toolbar ? (
              <div class="ml-auto hidden max-w-full flex-wrap items-center justify-end gap-2 sm:flex">
                {toolbar}
              </div>
            ) : null}
          </div>
        </div>
        <div class="flex-1 px-6 py-5 overflow-y-auto min-h-0">{children}</div>
        {rightPanel}
      </div>
    </div>
  );
}

/* ------------------------------ shared ui ------------------------------ */

function PrimaryButton({
  label,
  active,
  icon,
}: {
  label: string;
  active?: boolean;
  icon?: ComponentChildren;
}) {
  return (
    <span
      class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium"
      style={{
        background: active
          ? "var(--color-page-bg-inverted)"
          : "var(--color-page-surface)",
        color: active
          ? "var(--color-page-text-inverted)"
          : "var(--color-page-text)",
        border: active
          ? "1px solid var(--color-page-bg-inverted)"
          : "1px solid var(--color-page-border)",
      }}
    >
      {icon}
      {label}
    </span>
  );
}

function GhostButton({
  label,
  icon,
}: {
  label: string;
  icon?: ComponentChildren;
}) {
  return (
    <span
      class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium"
      style={{
        color: "var(--color-page-text)",
        border: "1px solid var(--color-page-border)",
        background: "var(--color-page-surface)",
      }}
    >
      {icon}
      {label}
    </span>
  );
}

function SearchInput() {
  return (
    <span
      class="hidden sm:inline-flex items-center gap-2 h-8 px-3 rounded-md text-[13px]"
      style={{
        background: "var(--color-page-surface)",
        color: "var(--color-page-text-muted)",
        border: "1px solid var(--color-page-border)",
        minWidth: "0",
        width: "min(200px, 42vw)",
      }}
      aria-hidden="true"
    >
      <SearchIcon />
      <span>Search</span>
    </span>
  );
}

function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "amber" | "violet" | "green" | "muted" | "red";
}) {
  const palette: Record<string, { bg: string; color: string; border: string }> =
    {
      neutral: {
        bg: "var(--color-page-surface-dim)",
        color: "var(--color-page-text)",
        border: "transparent",
      },
      amber: {
        bg: "rgba(245,158,11,0.12)",
        color: "#b45309",
        border: "rgba(245,158,11,0.25)",
      },
      violet: {
        bg: "rgba(139,92,246,0.12)",
        color: "#6d28d9",
        border: "rgba(139,92,246,0.25)",
      },
      green: {
        bg: "rgba(16,185,129,0.12)",
        color: "#047857",
        border: "rgba(16,185,129,0.25)",
      },
      red: {
        bg: "rgba(239,68,68,0.12)",
        color: "#b91c1c",
        border: "rgba(239,68,68,0.25)",
      },
      muted: {
        bg: "rgba(0,0,0,0.05)",
        color: "var(--color-page-text-muted)",
        border: "transparent",
      },
    };
  const c = palette[tone] ?? palette.neutral;
  return (
    <span
      class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium"
      style={{
        background: c.bg,
        color: c.color,
        border: `1px solid ${c.border}`,
      }}
    >
      {label}
    </span>
  );
}

/* ------------------------------ tab 1: model ------------------------------ */

const DEFAULT_RECORD_ROWS: RecordRow[] = [
  {
    id: "default-1",
    name: "Albert Lund",
    summary: "Customer working in finance ops, runs Stripe reconciliations.",
    type: "Member",
    typeTone: "amber",
    tag: "active",
    tagTone: "amber",
    updated: "2d ago",
  },
  {
    id: "default-2",
    name: "Jenna Roberts",
    summary: "Admin who configures memory schemas for the team.",
    type: "Admin",
    typeTone: "violet",
    tag: "power user",
    tagTone: "violet",
    updated: "5h ago",
  },
  {
    id: "default-3",
    name: "David Chen",
    summary: "Engineering lead with broad memory write access.",
    type: "Admin",
    typeTone: "violet",
    tag: "power user",
    tagTone: "violet",
    updated: "Just now",
  },
  {
    id: "default-4",
    name: "Marc Lopez",
    summary: "Inactive contributor — kept for audit history.",
    type: "Member",
    typeTone: "amber",
    tag: "inactive",
    tagTone: "muted",
    updated: "12d ago",
  },
];

function MembersTable({ rows }: { rows: RecordRow[] }) {
  return (
    <div
      class="rounded-lg overflow-hidden bg-[var(--color-page-surface)]"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div
        class="grid text-[11px] font-medium tracking-wider uppercase px-3 py-2"
        style={{
          gridTemplateColumns: "1.4fr 1.8fr 0.9fr 0.9fr 0.7fr",
          color: "var(--color-page-text-muted)",
          borderBottom: "1px solid var(--color-page-border)",
        }}
      >
        <span>Record</span>
        <span>Summary</span>
        <span>Type</span>
        <span>Tag</span>
        <span class="text-right">Updated</span>
      </div>
      {rows.map((row, i) => (
        <div
          key={row.id}
          class="grid items-center px-3 py-2.5 text-[13px]"
          style={{
            gridTemplateColumns: "1.4fr 1.8fr 0.9fr 0.9fr 0.7fr",
            color: "var(--color-page-text)",
            borderBottom:
              i === rows.length - 1
                ? undefined
                : "1px solid var(--color-page-border)",
          }}
        >
          <span class="flex items-center gap-2 font-medium min-w-0">
            <span
              class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] shrink-0"
              style={{
                background: "var(--color-page-surface-dim)",
                color: "var(--color-page-text-muted)",
              }}
              aria-hidden="true"
            >
              {row.name.charAt(0).toUpperCase()}
            </span>
            <span class="truncate">{row.name}</span>
          </span>
          <span
            class="truncate text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
            title={row.summary}
          >
            {row.summary}
          </span>
          <span>
            <Badge label={row.type} tone={row.typeTone} />
          </span>
          <span>
            <Badge label={row.tag} tone={row.tagTone} />
          </span>
          <span
            class="text-right tabular-nums text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {row.updated}
          </span>
        </div>
      ))}
    </div>
  );
}

const SUMMARY_SCHEMA_FIELDS = [
  { name: "identity", type: "string", required: true },
  { name: "preferences", type: "json", required: false },
  { name: "decisions", type: "json[]", required: false },
  { name: "valid_from", type: "datetime", required: false },
  { name: "embedding", type: "vector", required: false },
];

const SUMMARY_RELATIONSHIPS = [
  { verb: "owns", target: "Asset", cardinality: "1 → many" },
  { verb: "subscribes to", target: "Subscription", cardinality: "1 → 1" },
  { verb: "follows", target: "Topic", cardinality: "many → many" },
];

function EntitySchemaSummary({
  entityLabel,
  emoji,
}: {
  entityLabel: string;
  emoji: string;
}) {
  return (
    <div
      class="rounded-lg bg-[var(--color-page-surface)] p-3"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div class="flex flex-wrap items-start gap-3">
        <span
          class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[15px]"
          style={{
            background: "var(--color-page-surface-dim)",
            border: "1px solid var(--color-page-border)",
          }}
          aria-hidden="true"
        >
          {emoji}
        </span>
        <div class="min-w-0 flex-1">
          <div
            class="text-[13px] font-semibold"
            style={{ color: "var(--color-page-text)" }}
          >
            {entityLabel} entity type
          </div>
          <p
            class="mt-0.5 text-[12px] leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Structured {entityLabel.toLowerCase()} memory your agents can recall
            and update.
          </p>
        </div>
        <Badge label="Editing schema" tone="amber" />
      </div>

      <div class="mt-3 grid gap-2 lg:grid-cols-[1.2fr_1fr_0.8fr]">
        <SummaryGroup title="Metadata schema">
          {SUMMARY_SCHEMA_FIELDS.map((field) => (
            <SummaryChip key={field.name}>
              <span class="font-mono">{field.name}</span>
              {field.required ? (
                <span
                  class="uppercase tracking-wider"
                  style={{ color: "#b45309" }}
                >
                  req
                </span>
              ) : null}
              <span
                class="font-mono"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {field.type}
              </span>
            </SummaryChip>
          ))}
        </SummaryGroup>

        <SummaryGroup title="Relationships">
          {SUMMARY_RELATIONSHIPS.map((rel) => (
            <SummaryChip key={rel.verb}>
              <span aria-hidden="true">→</span>
              <span class="font-medium">{rel.verb}</span>
              <span>{rel.target}</span>
              <span
                class="font-mono"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {rel.cardinality}
              </span>
            </SummaryChip>
          ))}
        </SummaryGroup>

        <SummaryGroup title="Automation">
          {["new-asset-linked", "first-decision", "inactive-90d"].map(
            (item) => (
              <SummaryChip key={item}>
                <span class="font-mono">{item}</span>
              </SummaryChip>
            )
          )}
        </SummaryGroup>
      </div>
    </div>
  );
}

function SummaryGroup({
  title,
  children,
}: {
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div
      class="rounded-md p-2"
      style={{ background: "var(--color-page-surface-dim)" }}
    >
      <div
        class="mb-1.5 text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {title}
      </div>
      <div class="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function SummaryChip({ children }: { children: ComponentChildren }) {
  return (
    <span
      class="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]"
      style={{
        background: "var(--color-page-surface)",
        border: "1px solid var(--color-page-border)",
        color: "var(--color-page-text)",
      }}
    >
      {children}
    </span>
  );
}

/* ------------------------------ tab 2: integrate ------------------------------ */

type Connection = {
  member: string;
  email: string;
  account: string;
  lastSync: string;
  status: "Active" | "Idle" | "Error";
};

type ConnectorEntry = {
  id: string;
  emoji: string;
  name: string;
  description: string;
  connections: Connection[];
};

const CONNECTORS: ConnectorEntry[] = [
  {
    id: "github",
    emoji: "🐙",
    name: "GitHub",
    description: "Issues, PRs, discussions",
    connections: [
      {
        member: "Albert Lund",
        email: "albert@runway.io",
        account: "@albertlund",
        lastSync: "2m ago",
        status: "Active",
      },
      {
        member: "Jenna Roberts",
        email: "jenna@flatfile.com",
        account: "@jennar",
        lastSync: "14m ago",
        status: "Active",
      },
      {
        member: "David Chen",
        email: "david@modal.dev",
        account: "@dchen",
        lastSync: "1h ago",
        status: "Idle",
      },
    ],
  },
  {
    id: "slack",
    emoji: "💬",
    name: "Slack",
    description: "Channels, mentions, files",
    connections: [
      {
        member: "Albert Lund",
        email: "albert@runway.io",
        account: "lobu-prod.slack.com",
        lastSync: "Just now",
        status: "Active",
      },
      {
        member: "Marc Lopez",
        email: "marc@listen.ai",
        account: "lobu-prod.slack.com",
        lastSync: "8m ago",
        status: "Active",
      },
    ],
  },
  {
    id: "linear",
    emoji: "📋",
    name: "Linear",
    description: "Issues and cycles",
    connections: [
      {
        member: "Jenna Roberts",
        email: "jenna@flatfile.com",
        account: "lobu workspace",
        lastSync: "5m ago",
        status: "Active",
      },
    ],
  },
  {
    id: "gmail",
    emoji: "📨",
    name: "Gmail",
    description: "Threads and labels",
    connections: [
      {
        member: "David Chen",
        email: "david@modal.dev",
        account: "david@modal.dev",
        lastSync: "32m ago",
        status: "Active",
      },
      {
        member: "Marc Lopez",
        email: "marc@listen.ai",
        account: "marc@listen.ai",
        lastSync: "—",
        status: "Error",
      },
    ],
  },
  {
    id: "notion",
    emoji: "📓",
    name: "Notion",
    description: "Pages and databases",
    connections: [],
  },
  {
    id: "postgres",
    emoji: "🐘",
    name: "Postgres",
    description: "Read-only views",
    connections: [],
  },
];

const DEFAULT_CONNECTOR_ROWS: ConnectorRow[] = CONNECTORS.map((c) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  status: c.connections.length > 0 ? "Connected" : "Available",
  connections: c.connections.map((conn) => ({
    member: conn.member,
    email: conn.email,
    account: conn.account,
    lastSync: conn.lastSync,
    status: conn.status,
  })),
}));

function ChevronRightSmall({ open }: { open?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
      }}
    >
      <path
        d="m4.5 3 3 3-3 3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

const SUB_INDENT_PX = 56;
const SUB_COLS = "1.4fr 1.4fr 1.4fr 0.8fr 0.8fr";
const STATUS_TONE: Record<
  ConnectorConnection["status"],
  "green" | "muted" | "red"
> = {
  Active: "green",
  Idle: "muted",
  Error: "red",
};

function ConnectionsRows({ connector }: { connector: ConnectorRow }) {
  if (connector.connections.length === 0) {
    return (
      <div
        class="px-3 py-3 text-[12px] flex items-center gap-2"
        style={{
          background: "var(--color-page-surface-dim)",
          borderTop: "1px solid var(--color-page-border)",
          color: "var(--color-page-text-muted)",
          paddingLeft: SUB_INDENT_PX,
        }}
      >
        <span aria-hidden="true">🔗</span>
        <span>
          No one has connected {connector.name} yet. Share the install link so
          members can bring in their own data.
        </span>
      </div>
    );
  }
  return (
    <>
      <div
        class="grid text-[10px] font-medium tracking-wider uppercase py-1.5 pr-3"
        style={{
          gridTemplateColumns: SUB_COLS,
          color: "var(--color-page-text-muted)",
          background: "var(--color-page-surface-dim)",
          borderTop: "1px solid var(--color-page-border)",
          paddingLeft: SUB_INDENT_PX,
        }}
      >
        <span>Member</span>
        <span>Email</span>
        <span>Connected account</span>
        <span>Last sync</span>
        <span class="text-right">Status</span>
      </div>
      {connector.connections.map((row) => (
        <div
          key={`${row.email}-${row.account}`}
          class="grid items-center py-2 pr-3 text-[12px]"
          style={{
            gridTemplateColumns: SUB_COLS,
            color: "var(--color-page-text)",
            borderTop: "1px solid var(--color-page-border)",
            paddingLeft: SUB_INDENT_PX,
          }}
        >
          <span class="flex items-center gap-2 font-medium">
            <span
              class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px]"
              style={{
                background: "var(--color-page-surface-dim)",
                color: "var(--color-page-text-muted)",
              }}
              aria-hidden="true"
            >
              {row.member.charAt(0)}
            </span>
            {row.member}
          </span>
          <span
            class="truncate"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {row.email}
          </span>
          <span
            class="truncate font-mono text-[11px]"
            style={{ color: "var(--color-page-text)" }}
          >
            {row.account}
          </span>
          <span
            class="tabular-nums text-[11px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {row.lastSync}
          </span>
          <span class="flex justify-end">
            <Badge label={row.status} tone={STATUS_TONE[row.status]} />
          </span>
        </div>
      ))}
    </>
  );
}

function ConnectorsTable({ connectors }: { connectors: ConnectorRow[] }) {
  const firstWithConnections = connectors.find((c) => c.connections.length > 0);
  const [openId, setOpenId] = useState<string | null>(
    firstWithConnections?.id ?? null
  );
  const cols = "1.6fr 1.6fr 0.8fr 0.7fr";

  return (
    <div
      class="rounded-lg overflow-hidden bg-[var(--color-page-surface)]"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div
        class="grid text-[11px] font-medium tracking-wider uppercase px-3 py-2"
        style={{
          gridTemplateColumns: cols,
          color: "var(--color-page-text-muted)",
          borderBottom: "1px solid var(--color-page-border)",
        }}
      >
        <span>Connector</span>
        <span>Description</span>
        <span>Connections</span>
        <span class="text-right">Status</span>
      </div>
      {connectors.map((c, i) => {
        const open = openId === c.id;
        const isLast = i === connectors.length - 1;
        const hasConnections = c.connections.length > 0;
        return (
          <div
            key={c.id}
            style={{
              borderBottom: isLast
                ? undefined
                : "1px solid var(--color-page-border)",
            }}
          >
            <button
              type="button"
              onClick={() => setOpenId(open ? null : c.id)}
              class="grid items-center w-full text-left px-3 py-2.5 text-[13px] transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
              style={{
                gridTemplateColumns: cols,
                color: "var(--color-page-text)",
                cursor: "pointer",
              }}
            >
              <span class="flex items-center gap-2 font-medium min-w-0">
                <span style={{ color: "var(--color-page-text-muted)" }}>
                  <ChevronRightSmall open={open} />
                </span>
                <span class="truncate">{c.name}</span>
              </span>
              <span
                class="truncate"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {c.description}
              </span>
              <span
                class="tabular-nums"
                style={{ color: "var(--color-page-text)" }}
              >
                {hasConnections
                  ? `${c.connections.length} member${c.connections.length === 1 ? "" : "s"}`
                  : "—"}
              </span>
              <span class="flex justify-end">
                {hasConnections ? (
                  <Badge label="Connected" tone="green" />
                ) : (
                  <Badge label="Available" tone="muted" />
                )}
              </span>
            </button>

            {open ? <ConnectionsRows connector={c} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ tab 3: watch ------------------------------ */

const DEFAULT_WATCHER_ROWS: WatcherRow[] = [
  {
    name: "Stripe failed charge",
    entity: "Asset",
    agent: "Stripe reconciler",
    status: "Active",
    schedule: "webhook",
    last: "12m ago",
  },
  {
    name: "New Linear bug",
    entity: "Topic",
    agent: "Triage bot",
    status: "Active",
    schedule: "every 30s",
    last: "4s ago",
  },
  {
    name: "GitHub PR opened",
    entity: "Topic",
    agent: "Triage bot",
    status: "Active",
    schedule: "webhook",
    last: "2h ago",
  },
  {
    name: "Calendar invite",
    entity: "Member",
    agent: "Daily digest",
    status: "Inactive",
    schedule: "*/5 * * * *",
    last: "—",
  },
];

function WatchersTable({ rows }: { rows: WatcherRow[] }) {
  const cols = "1.6fr 0.7fr 1.1fr 0.7fr 1fr 0.7fr";
  return (
    <div
      class="rounded-lg overflow-hidden bg-[var(--color-page-surface)]"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div
        class="grid text-[11px] font-medium tracking-wider uppercase px-3 py-2"
        style={{
          gridTemplateColumns: cols,
          color: "var(--color-page-text-muted)",
          borderBottom: "1px solid var(--color-page-border)",
        }}
      >
        <span>Name</span>
        <span>Entity</span>
        <span>Agent</span>
        <span>Status</span>
        <span>Schedule</span>
        <span class="text-right">Last run</span>
      </div>
      {rows.map((row, i) => (
        <div
          key={row.name}
          class="grid items-center px-3 py-2.5 text-[13px]"
          style={{
            gridTemplateColumns: cols,
            color: "var(--color-page-text)",
            borderBottom:
              i === rows.length - 1
                ? undefined
                : "1px solid var(--color-page-border)",
            background: i === 1 ? "rgba(249,115,22,0.04)" : "transparent",
          }}
        >
          <span class="font-medium flex items-center gap-2">
            <span
              class="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background:
                  row.status === "Active"
                    ? "rgb(16,185,129)"
                    : "rgba(0,0,0,0.2)",
              }}
              aria-hidden="true"
            />
            {row.name}
          </span>
          <span style={{ color: "var(--color-page-text-muted)" }}>
            {row.entity}
          </span>
          <span class="flex items-center gap-1.5">
            <BotIcon size={12} />
            <span class="truncate" style={{ color: "var(--color-page-text)" }}>
              {row.agent}
            </span>
          </span>
          <span>
            <Badge
              label={row.status}
              tone={row.status === "Active" ? "green" : "muted"}
            />
          </span>
          <span
            class="font-mono text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {row.schedule}
          </span>
          <span
            class="text-right tabular-nums text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {row.last}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ knowledge (sidebar-only) ------------------------------ */

type KnowledgeMemoryItem = {
  kind: "memory";
  id: string;
  title: string;
  author: string;
  platform: string;
  platformEmoji: string;
  occurredAt: string;
  excerpt?: string;
  body: string;
  tags: { slug: string; value: string }[];
  score: number;
};

type KnowledgeActionItem = {
  kind: "action";
  id: string;
  title: string;
  author: string;
  platform: string;
  platformEmoji: string;
  occurredAt: string;
  status: "pending" | "completed" | "failed";
  actionKey: string;
  inputs: {
    label: string;
    value: string;
    mono?: boolean;
    multiline?: boolean;
  }[];
  output?: string;
};

type KnowledgeItem = KnowledgeMemoryItem | KnowledgeActionItem;

const KNOWLEDGE_ITEMS: KnowledgeItem[] = [
  {
    kind: "memory",
    id: "k-1",
    title: "Albert wants exports for Stripe reconciler results",
    author: "Albert Lund",
    platform: "Slack",
    platformEmoji: "💬",
    occurredAt: "12m ago",
    excerpt:
      "...could you have the Stripe reconciler drop a CSV in #finance every Friday?",
    body: "Following up on the reconciler agent — Albert asked for a weekly CSV in #finance instead of an in-thread summary. He wants to import it into Looker. Existing watcher already covers detection, just need an output route.",
    tags: [
      { slug: "topic", value: "billing" },
      { slug: "intent", value: "feature-request" },
      { slug: "review", value: "approved" },
    ],
    score: 86,
  },
  {
    kind: "action",
    id: "k-action-1",
    title: "Send weekly Stripe digest to #finance",
    author: "Stripe reconciler",
    platform: "Slack",
    platformEmoji: "💬",
    occurredAt: "Just now",
    status: "pending",
    actionKey: "slack.post_message",
    inputs: [
      { label: "Channel", value: "#finance", mono: true },
      {
        label: "Message",
        value:
          "Stripe weekly digest — 4 failed charges, 12 retries succeeded, 1 dispute pending review.",
        multiline: true,
      },
      { label: "Schedule", value: "Fri 09:00 PT, recurring", mono: true },
    ],
  },
  {
    kind: "memory",
    id: "k-2",
    title: "Inbox cleaner mislabeled VC outreach as spam",
    author: "Daily digest",
    platform: "Gmail",
    platformEmoji: "📨",
    occurredAt: "1h ago",
    excerpt:
      "Marked 4 messages from greylock partners as promotional based on subject heuristics.",
    body: "Inbox cleaner moved 4 emails from greylock.com into Promotions. The classifier triggered on the word 'event' in the subject. False positive — these are investor intros. Need to add a sender allowlist for greylock.com / sequoiacap.com.",
    tags: [
      { slug: "topic", value: "false-positive" },
      { slug: "agent", value: "inbox-cleaner" },
      { slug: "review", value: "needs-review" },
    ],
    score: 72,
  },
  {
    kind: "memory",
    id: "k-3",
    title: "Jenna confirmed the Q2 mobile freeze date",
    author: "Jenna Roberts",
    platform: "Linear",
    platformEmoji: "📋",
    occurredAt: "3h ago",
    excerpt:
      "Mobile team is cutting the release branch on Thursday. No non-critical merges after that.",
    body: "Per Jenna in LIN-2841: mobile release branch cuts 2026-05-07. After that date, only P0 / P1 fixes go in. Triage bot should flag any merge requests targeting main that aren't tagged P0/P1.",
    tags: [
      { slug: "topic", value: "release" },
      { slug: "review", value: "approved" },
    ],
    score: 91,
  },
  {
    kind: "action",
    id: "k-action-2",
    title: "Open Linear issue from #418 repro",
    author: "Triage bot",
    platform: "Linear",
    platformEmoji: "📋",
    occurredAt: "Yesterday",
    status: "completed",
    actionKey: "linear.create_issue",
    inputs: [
      { label: "Team", value: "Runtime", mono: true },
      { label: "Title", value: "Worker OOM on Slack messages > 64KB" },
      { label: "Priority", value: "P2", mono: true },
    ],
    output: "Created LIN-2913 · assigned @dchen",
  },
  {
    kind: "memory",
    id: "k-4",
    title: "GitHub issue: workers crash on long Slack messages",
    author: "David Chen",
    platform: "GitHub",
    platformEmoji: "🐙",
    occurredAt: "Yesterday",
    excerpt:
      "Worker subprocess OOMs when a single message is > 64KB — repro steps in #418.",
    body: "Filed by David. Repro in lobu-ai/lobu#418. Stack trace points to `chat-history.ts:streamAppend` allocating without a chunk boundary. Looks like a small fix; assigning to triage-bot watcher to keep it on radar.",
    tags: [
      { slug: "topic", value: "bug" },
      { slug: "severity", value: "P2" },
    ],
    score: 64,
  },
];

function PaperclipIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M21 11.5 12 20.5a5 5 0 0 1-7-7L13 5.5a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 1 1-3-3l7.5-7.5"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14 4h6v6M20 4l-9 9M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

const KNOWLEDGE_CHIPS: { slug: string; values: string[]; active?: string }[] = [
  {
    slug: "Topic",
    values: ["billing", "release", "bug", "false-positive"],
    active: "billing",
  },
  { slug: "Source", values: ["Slack", "Gmail", "Linear", "GitHub"] },
  { slug: "Review", values: ["needs-review", "approved"] },
];

function KnowledgeFeed({ rows }: { rows?: KnowledgeRow[] }) {
  const useDynamic = rows && rows.length > 0;
  return (
    <div class="flex flex-col gap-3">
      <KnowledgeFilterBar />
      <div
        class="text-[12px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {useDynamic
          ? `${rows.length} items · sorted by recency`
          : "1,284 items · sorted by recency"}
      </div>
      <div class="flex flex-col gap-3">
        {useDynamic
          ? rows.map((row) => <UseCaseKnowledgeCard key={row.id} row={row} />)
          : KNOWLEDGE_ITEMS.map((item) =>
              item.kind === "action" ? (
                <KnowledgeActionCard key={item.id} item={item} />
              ) : (
                <KnowledgeCard key={item.id} item={item} />
              )
            )}
      </div>
    </div>
  );
}

function UseCaseKnowledgeCard({ row }: { row: KnowledgeRow }) {
  return (
    <article
      class="rounded-lg bg-[var(--color-page-surface)] p-4 flex flex-col gap-3"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <header class="flex items-start gap-3">
        <span
          class="inline-flex items-center justify-center w-7 h-7 rounded-md mt-0.5 text-[14px]"
          style={{
            background: "var(--color-page-surface-dim)",
            border: "1px solid var(--color-page-border)",
          }}
          aria-hidden="true"
        >
          {entityEmoji(row.type)}
        </span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h4
              class="text-[14px] font-semibold leading-snug"
              style={{ color: "var(--color-page-text)" }}
            >
              {row.title}
            </h4>
            <Badge label={row.type} tone="amber" />
          </div>
          <div
            class="flex flex-wrap items-center gap-1.5 text-[12px] mt-1"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            <span>Captured {row.occurredAt}</span>
          </div>
        </div>
      </header>

      <p
        class="text-[13px] leading-relaxed"
        style={{ color: "var(--color-page-text)" }}
      >
        {row.summary}
      </p>

      {row.highlights.length > 0 ? (
        <div
          class="grid gap-1.5 rounded-md p-3"
          style={{
            background: "var(--color-page-surface-dim)",
            gridTemplateColumns: "minmax(0, 9rem) 1fr",
          }}
        >
          {row.highlights.slice(0, 4).map((field) => (
            <>
              <span
                key={`${field.label}-l`}
                class="text-[11px] uppercase tracking-wider"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {field.label}
              </span>
              <span
                key={`${field.label}-v`}
                class="text-[12px]"
                style={{ color: "var(--color-page-text)" }}
              >
                {field.value}
              </span>
            </>
          ))}
        </div>
      ) : null}

      {row.chips.length > 0 ? (
        <div class="flex flex-wrap items-center gap-1.5">
          {row.chips.map((chip) => (
            <span
              key={chip}
              class="inline-flex items-center px-2 py-0.5 rounded text-[11px]"
              style={{
                background: "var(--color-page-surface-dim)",
                color: "var(--color-page-text-muted)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function KnowledgeFilterBar() {
  return (
    <div
      class="rounded-lg bg-[var(--color-page-surface)] px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      {KNOWLEDGE_CHIPS.map((group, gi) => (
        <div
          key={group.slug}
          class="flex items-center gap-1.5"
          style={{
            paddingLeft: gi === 0 ? 0 : 8,
            borderLeft:
              gi === 0 ? undefined : "1px solid var(--color-page-border)",
          }}
        >
          <span
            class="text-[11px] font-medium uppercase tracking-wider shrink-0"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {group.slug}
          </span>
          {group.values.map((v) => {
            const isActive = group.active === v;
            return (
              <span
                key={v}
                class="inline-flex items-center px-2 py-0.5 rounded text-[11px]"
                style={{
                  background: isActive
                    ? "var(--color-page-bg-inverted)"
                    : "var(--color-page-surface)",
                  color: isActive
                    ? "var(--color-page-text-inverted)"
                    : "var(--color-page-text)",
                  border: isActive
                    ? "1px solid var(--color-page-text)"
                    : "1px solid var(--color-page-border)",
                  fontWeight: isActive ? 600 : 500,
                }}
              >
                {v}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function KnowledgeCard({ item }: { item: KnowledgeMemoryItem }) {
  return (
    <article
      class="rounded-lg bg-[var(--color-page-surface)] p-4 flex flex-col gap-2"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <header class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <h4
            class="text-[14px] font-semibold leading-snug mb-1"
            style={{ color: "var(--color-page-text)" }}
          >
            {item.title}
          </h4>
          <div
            class="flex flex-wrap items-center gap-1.5 text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            <span
              class="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px]"
              style={{
                background: "var(--color-page-surface-dim)",
                color: "var(--color-page-text-muted)",
              }}
              aria-hidden="true"
            >
              {item.author.charAt(0)}
            </span>
            <span
              class="font-medium"
              style={{ color: "var(--color-page-text)" }}
            >
              {item.author}
            </span>
            <span aria-hidden="true">·</span>
            <span>{item.occurredAt}</span>
            <span aria-hidden="true">·</span>
            <span
              class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
              style={{
                background: "var(--color-page-surface-dim)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <span aria-hidden="true">{item.platformEmoji}</span>
              {item.platform}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <span
            class="inline-flex items-center justify-center h-7 px-2 rounded-md text-[12px] font-semibold tabular-nums"
            style={{
              background: "var(--color-page-surface-dim)",
              color: "var(--color-page-text)",
              border: "1px solid var(--color-page-border)",
            }}
          >
            {item.score}
          </span>
          <span
            class="inline-flex items-center justify-center h-7 w-7 rounded-md"
            style={{
              color: "var(--color-page-text-muted)",
              border: "1px solid var(--color-page-border)",
              background: "var(--color-page-surface)",
            }}
            aria-hidden="true"
          >
            <PaperclipIcon />
          </span>
          <span
            class="inline-flex items-center justify-center h-7 w-7 rounded-md"
            style={{
              color: "var(--color-page-text-muted)",
              border: "1px solid var(--color-page-border)",
              background: "var(--color-page-surface)",
            }}
            aria-hidden="true"
          >
            <ExternalLinkIcon />
          </span>
        </div>
      </header>

      {item.excerpt ? (
        <blockquote
          class="text-[12px] italic pl-2 border-l-2"
          style={{
            borderColor: "var(--color-tg-accent)",
            color: "var(--color-page-text-muted)",
          }}
        >
          {item.excerpt}
        </blockquote>
      ) : null}

      <p
        class="text-[13px] leading-relaxed"
        style={{ color: "var(--color-page-text)" }}
      >
        {item.body}
      </p>

      {item.tags.length > 0 ? (
        <div class="flex flex-wrap items-center gap-1.5 mt-1">
          {item.tags.map((tag) => (
            <span
              key={`${tag.slug}-${tag.value}`}
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
              style={{
                background: "var(--color-page-surface-dim)",
                color: "var(--color-page-text-muted)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <span style={{ color: "var(--color-page-text-muted)" }}>
                {tag.slug}:
              </span>
              <span style={{ color: "var(--color-page-text)" }}>
                {tag.value}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function KnowledgeActionCard({ item }: { item: KnowledgeActionItem }) {
  const isPending = item.status === "pending";
  const isCompleted = item.status === "completed";
  const isFailed = item.status === "failed";

  const accentBg = isPending
    ? "rgba(245,158,11,0.04)"
    : isCompleted
      ? "rgba(16,185,129,0.04)"
      : "rgba(239,68,68,0.04)";
  const accentBorder = isPending
    ? "rgba(245,158,11,0.35)"
    : isCompleted
      ? "rgba(16,185,129,0.35)"
      : "rgba(239,68,68,0.35)";

  return (
    <article
      class="rounded-lg p-4 flex flex-col gap-3"
      style={{
        background: accentBg,
        border: `1px solid ${accentBorder}`,
      }}
    >
      <header class="flex items-start gap-3">
        <span
          class="inline-flex items-center justify-center w-7 h-7 rounded-md mt-0.5"
          style={{
            background: "var(--color-page-surface)",
            border: "1px solid var(--color-page-border)",
            color: "var(--color-page-text)",
          }}
          aria-hidden="true"
        >
          <PlusIcon size={13} />
        </span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h4
              class="text-[14px] font-semibold leading-snug"
              style={{ color: "var(--color-page-text)" }}
            >
              {item.title}
            </h4>
            {isPending ? (
              <Badge label="Pending approval" tone="amber" />
            ) : isCompleted ? (
              <Badge label="Completed" tone="green" />
            ) : (
              <Badge label="Failed" tone="red" />
            )}
            <span
              class="font-mono text-[11px] px-1.5 py-0.5 rounded"
              style={{
                background: "var(--color-page-surface)",
                color: "var(--color-page-text-muted)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              {item.actionKey}
            </span>
          </div>
          <div
            class="flex flex-wrap items-center gap-1.5 text-[12px] mt-1"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            <span>Requested by</span>
            <span
              class="font-medium"
              style={{ color: "var(--color-page-text)" }}
            >
              {item.author}
            </span>
            <span aria-hidden="true">·</span>
            <span>{item.occurredAt}</span>
            <span aria-hidden="true">·</span>
            <span
              class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
              style={{
                background: "var(--color-page-surface)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <span aria-hidden="true">{item.platformEmoji}</span>
              {item.platform}
            </span>
          </div>
        </div>
      </header>

      <div
        class="rounded-md bg-[var(--color-page-surface)] p-3 flex flex-col gap-2"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div
          class="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Input
        </div>
        {item.inputs.map((field) => (
          <ActionField
            key={field.label}
            label={field.label}
            value={field.value}
            mono={field.mono}
            multiline={field.multiline}
            editable={isPending}
          />
        ))}
      </div>

      {isCompleted && item.output ? (
        <div
          class="rounded-md p-3 text-[12px] flex items-start gap-2"
          style={{
            background: "rgba(16,185,129,0.08)",
            border: "1px solid rgba(16,185,129,0.25)",
            color: "#047857",
          }}
        >
          <span class="font-semibold">Output</span>
          <span style={{ color: "#065f46" }}>{item.output}</span>
        </div>
      ) : null}

      {isPending ? (
        <div class="flex items-center gap-2">
          <PrimaryButton label="Confirm" active />
          <GhostButton label="Reject" />
          <span
            class="text-[11px] ml-auto"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Auto-approves in 4m
          </span>
        </div>
      ) : null}
    </article>
  );
}

function ActionField({
  label,
  value,
  mono,
  multiline,
  editable,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
  editable?: boolean;
}) {
  return (
    <div class="flex flex-col gap-1">
      <span
        class="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {label}
      </span>
      <span
        class={[
          "block px-2 py-1.5 rounded text-[12px]",
          mono ? "font-mono" : "",
          multiline ? "whitespace-pre-wrap" : "truncate",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          background: editable
            ? "var(--color-page-surface)"
            : "var(--color-page-surface-dim)",
          color: "var(--color-page-text)",
          border: "1px solid var(--color-page-border)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/* ------------------------------ tab 4: connect ------------------------------ */

function DeployChannelGroup({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; active?: boolean }>;
}) {
  return (
    <div class="flex min-w-0 items-center gap-2">
      <span
        class="shrink-0 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {title}
      </span>
      <div class="flex min-w-0 flex-wrap gap-1.5 lg:flex-nowrap">
        {items.map((item) => (
          <span
            key={item.label}
            class="inline-flex items-center rounded-md px-2 py-1 text-[11px] font-medium"
            style={{
              background: item.active
                ? "rgba(var(--color-tg-accent-rgb), 0.08)"
                : "var(--color-page-surface-dim)",
              border: item.active
                ? "1px solid rgba(var(--color-tg-accent-rgb), 0.25)"
                : "1px solid var(--color-page-border)",
              color: "var(--color-page-text)",
            }}
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function AgentsConnect({
  info,
  agents,
}: {
  info: AgentInfo;
  agents: AgentRow[];
}) {
  const mcpClients = [
    { label: "OpenClaw", active: true },
    { label: "Claude" },
    { label: "ChatGPT" },
    { label: "Any MCP client" },
  ];
  const chatChannels = [
    { label: "Slack", active: true },
    { label: "Telegram" },
    { label: "Discord" },
    { label: "WhatsApp" },
    { label: "Teams" },
    { label: "REST API" },
  ];

  return (
    <div class="flex flex-col gap-4">
      <div
        class="rounded-2xl bg-[var(--color-page-surface)] p-4"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div class="flex min-w-0 flex-1 items-start gap-3">
            <span style={{ color: "var(--color-page-text)" }}>
              <SparklesIcon size={18} />
            </span>
            <div class="min-w-0">
              <h4
                class="text-[15px] font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                Deploy agents everywhere users work
              </h4>
              <p
                class="mt-1 text-[12px] leading-relaxed"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                One Lobu backend reaches MCP clients, chat platforms, and
                always-on workers with the same memory and credentials.
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <PrimaryButton label={info.primaryClient} active />
            <GhostButton label="Slack" />
            <GhostButton label="ChatGPT" />
          </div>
        </div>
        <div
          class="mt-4 flex min-w-0 items-center gap-2 rounded-md px-3 py-2 font-mono text-[12px]"
          style={{
            background: "var(--color-page-surface-dim)",
            color: "var(--color-page-text)",
            border: "1px solid var(--color-page-border)",
          }}
        >
          <span
            class="text-[10px] font-sans uppercase tracking-wider"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            MCP
          </span>
          <span class="flex-1 truncate">{info.mcpEndpoint}</span>
          <span
            class="inline-flex h-6 items-center rounded px-2 text-[11px] font-medium"
            style={{
              background: "var(--color-page-surface)",
              color: "var(--color-page-text)",
              border: "1px solid var(--color-page-border)",
            }}
          >
            Copy
          </span>
        </div>
      </div>

      <div
        class="rounded-2xl bg-[var(--color-page-surface)] p-4"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:gap-8">
          <DeployChannelGroup title="MCP" items={mcpClients} />
          <DeployChannelGroup title="Chat/API" items={chatChannels} />
        </div>
      </div>

      <AlwaysOnAgentsTable rows={agents.slice(0, 3)} />
    </div>
  );
}

const DEFAULT_AGENT_ROWS: AgentRow[] = [
  {
    name: "Triage bot",
    entryPoint: "OpenClaw",
    skills: ["github-triage", "linear-sync"],
    last: "2h ago",
    status: "Active",
  },
  {
    name: "Daily digest",
    entryPoint: "Slack",
    skills: ["digest", "slack-post"],
    last: "1d ago",
    status: "Active",
  },
  {
    name: "Inbox cleaner",
    entryPoint: "ChatGPT",
    skills: ["gmail-triage"],
    last: "12m ago",
    status: "Active",
  },
  {
    name: "Stripe reconciler",
    entryPoint: "Telegram",
    skills: ["stripe", "postgres"],
    last: "—",
    status: "Paused",
  },
];

function AlwaysOnAgentsTable({ rows }: { rows: AgentRow[] }) {
  return (
    <div
      class="rounded-2xl bg-[var(--color-page-surface)] overflow-hidden"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div
        class="flex items-center gap-2 px-5 py-4"
        style={{ borderBottom: "1px solid var(--color-page-border)" }}
      >
        <BotIcon size={16} />
        <h4
          class="text-[14px] font-semibold"
          style={{ color: "var(--color-page-text)" }}
        >
          Always-on agents
        </h4>
        <span
          class="text-[12px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Run from MCP clients, chat platforms, or schedules
        </span>
        <span class="ml-auto inline-flex items-center gap-1.5">
          <SearchInput />
          <PrimaryButton label="Create" icon={<PlusIcon size={12} />} />
        </span>
      </div>
      <div
        class="grid text-[11px] font-medium tracking-wider uppercase px-5 py-2"
        style={{
          gridTemplateColumns: "1.4fr 1.2fr 1.6fr 0.8fr 0.8fr",
          color: "var(--color-page-text-muted)",
          borderBottom: "1px solid var(--color-page-border)",
        }}
      >
        <span>Name</span>
        <span>Entry point</span>
        <span>Skills</span>
        <span>Status</span>
        <span class="text-right">Last run</span>
      </div>
      {rows.map((row, i) => (
        <div
          key={row.name}
          class="grid items-center px-5 py-2.5 text-[13px]"
          style={{
            gridTemplateColumns: "1.4fr 1.2fr 1.6fr 0.8fr 0.8fr",
            color: "var(--color-page-text)",
            borderBottom:
              i === rows.length - 1
                ? undefined
                : "1px solid var(--color-page-border)",
          }}
        >
          <span class="flex items-center gap-2 font-medium">
            <span
              class="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background:
                  row.status === "Active"
                    ? "rgb(16,185,129)"
                    : "rgba(0,0,0,0.25)",
              }}
              aria-hidden="true"
            />
            {row.name}
          </span>
          <span style={{ color: "var(--color-page-text-muted)" }}>
            {row.entryPoint}
          </span>
          <span class="flex flex-wrap items-center gap-1">
            {row.skills.map((s) => (
              <span
                key={s}
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono"
                style={{
                  background: "var(--color-page-surface-dim)",
                  color: "var(--color-page-text)",
                  border: "1px solid var(--color-page-border)",
                }}
              >
                {s}
              </span>
            ))}
          </span>
          <span>
            <Badge
              label={row.status}
              tone={row.status === "Active" ? "green" : "muted"}
            />
          </span>
          <span
            class="text-right tabular-nums text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {row.last}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ entry ------------------------------ */

export function HeroProductCard({
  stage,
  onStageChange,
  useCaseId,
}: {
  stage: HeroStageId;
  onStageChange?: (stage: HeroStageId) => void;
  useCaseId?: LandingUseCaseId;
}) {
  const useCase: LandingUseCaseDefinition | undefined = useCaseId
    ? landingUseCases[useCaseId]
    : undefined;
  const entities: EntityNavItem[] = useCase
    ? buildSidebarEntities(useCase)
    : DEFAULT_ENTITIES;
  const primaryEntity = entities[0]?.label ?? "Members";
  const primaryEntitySingular = useCase?.model.entities[0] ?? "Member";
  const useCaseLabel = useCase?.label ?? "your team";
  const watcherName = useCase?.memory.watcher.name ?? "Active watchers";
  const watcherSchedule = useCase?.memory.watcher.schedule ?? "On schedule";

  const recordRows: RecordRow[] = useCase
    ? buildRecordRows(useCase)
    : DEFAULT_RECORD_ROWS;
  const connectorRows: ConnectorRow[] = useCase
    ? buildConnectors(useCase)
    : DEFAULT_CONNECTOR_ROWS;
  const watcherRows: WatcherRow[] = useCase
    ? buildWatcherRows(useCase)
    : DEFAULT_WATCHER_ROWS;
  const knowledgeRows: KnowledgeRow[] | undefined = useCase
    ? buildKnowledgeRows(useCase)
    : undefined;
  const agentRows: AgentRow[] = useCase
    ? buildAgentRows(useCase)
    : DEFAULT_AGENT_ROWS;
  const agentInfo: AgentInfo = useCase
    ? buildAgentInfo(useCase)
    : {
        identity: "Lobu agent",
        mcpEndpoint: "https://lobu.ai/mcp",
        primaryClient: "Claude",
      };

  if (stage === "model") {
    return (
      <AppShell
        activeNav="members"
        editMode
        entities={entities}
        pageTitle={primaryEntity}
        pageSubtitle={`${recordRows.length} records · ${useCaseLabel} memory`}
        toolbar={
          <>
            <SearchInput />
            <PrimaryButton
              label="Edit"
              active
              icon={<PencilIcon size={11} />}
            />
            <PrimaryButton label="New" icon={<PlusIcon size={12} />} />
          </>
        }
        onStageChange={onStageChange}
      >
        <div class="flex flex-col gap-4">
          <EntitySchemaSummary
            entityLabel={primaryEntitySingular}
            emoji={entityEmoji(primaryEntitySingular)}
          />
          <MembersTable rows={recordRows} />
        </div>
      </AppShell>
    );
  }

  if (stage === "integrate") {
    return (
      <AppShell
        activeNav="connectors"
        entities={entities}
        pageTitle="Connectors"
        pageSubtitle={`Plug Lobu Memory into the systems your ${useCaseLabel.toLowerCase()} team already runs`}
        toolbar={
          <>
            <SearchInput />
            <PrimaryButton
              label="Add Connector"
              icon={<PlusIcon size={12} />}
            />
          </>
        }
        onStageChange={onStageChange}
      >
        <ConnectorsTable connectors={connectorRows} />
      </AppShell>
    );
  }

  if (stage === "watch") {
    return (
      <AppShell
        activeNav="watchers"
        entities={entities}
        pageTitle="Watchers"
        pageSubtitle={`${watcherName} · ${watcherSchedule.toLowerCase()}`}
        toolbar={
          <>
            <SearchInput />
            <GhostButton label="All · Active · Inactive" />
            <PrimaryButton
              label="Create Watcher"
              icon={<PlusIcon size={12} />}
            />
          </>
        }
        onStageChange={onStageChange}
      >
        <WatchersTable rows={watcherRows} />
      </AppShell>
    );
  }

  if (stage === "knowledge") {
    return (
      <AppShell
        activeNav="knowledge"
        entities={entities}
        pageTitle="Knowledge"
        pageSubtitle={`Items collected by your ${useCaseLabel.toLowerCase()} watchers and connectors`}
        toolbar={
          <>
            <SearchInput />
            <GhostButton label="All sources" />
            <PrimaryButton label="Filter" icon={<PlusIcon size={12} />} />
          </>
        }
        onStageChange={onStageChange}
      >
        <KnowledgeFeed rows={knowledgeRows} />
      </AppShell>
    );
  }

  // connect
  return (
    <AppShell
      activeNav="agents"
      entities={entities}
      pageTitle="Agents"
      pageSubtitle={`Connect MCP clients or run always-on ${primaryEntitySingular.toLowerCase()} agents`}
      toolbar={<SearchInput />}
      onStageChange={onStageChange}
    >
      <AgentsConnect info={agentInfo} agents={agentRows} />
    </AppShell>
  );
}
