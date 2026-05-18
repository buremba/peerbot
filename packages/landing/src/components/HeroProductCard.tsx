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

type RecordRow = {
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

type ConnectorConnection = {
  member: string;
  email: string;
  account: string;
  lastSync: string;
  status: "Active" | "Idle" | "Error";
};

type ConnectorRow = {
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
  const fromDomains = domains
    .map((domain, i) => {
      // Generated data uses both glob and leading-dot wildcards
      // (*.example.com, .example.com) plus the bare host. Normalise all
      // three shapes to the registrable hostname before slugging.
      const host = domain.replace(/^\*\.|^api\.|^\./, "");
      const slug = host.split(".")[0];
      return {
        id: `domain-${i}`,
        slug,
        name: brandName(slug),
        description: host,
        status: "Connected" as const,
        connections: buildSampleConnections(slug, 1),
      };
    })
    .filter((d) => d.slug.length > 0)
    .slice(0, 3);
  const seen = new Set<string>();
  return [...fromChips, ...fromDomains].filter((c) => {
    // Dedupe by brand key when the name resolves to one we know about
    // (so 'github.com' and '.githubusercontent.com' collapse into a single
    // GitHub row instead of GitHub + 'Githubusercontent'); otherwise fall
    // back to a lowercase name match.
    const brand = brandKey(c.name);
    const key = brand ?? c.name.toLowerCase();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type WatcherRow = {
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

type AgentRow = {
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

type AgentInfo = {
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

type KnowledgeRow = {
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

type NavStage = "members" | "connectors" | "watchers" | "agents" | "knowledge";
type Pill = "connections" | "home" | "agents";

function pillForStage(stage: NavStage): Pill {
  if (stage === "connectors") return "connections";
  if (stage === "agents" || stage === "watchers") return "agents";
  return "home";
}

function LobuLeftWing({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 221 420.701311"
      fill="currentColor"
      preserveAspectRatio="xMaxYMid meet"
      aria-hidden="true"
    >
      <g transform="translate(-10.239564,430.701311) scale(0.1,-0.1)">
        <path d="M1949 4276 c-84 -30 -223 -120 -291 -189 -29 -29 -186 -190 -348 -357 -162 -168 -466 -480 -675 -695 -209 -214 -398 -417 -420 -450 -83 -125 -120 -265 -111 -413 7 -113 26 -184 77 -283 51 -97 115 -168 865 -950 171 -178 380 -397 465 -487 160 -170 242 -238 345 -290 65 -33 164 -62 209 -62 l28 0 -6 228 c-7 297 -31 434 -106 612 -70 164 -128 237 -437 553 -302 309 -353 373 -401 505 -45 123 -42 283 7 414 37 99 90 164 391 478 160 168 313 337 339 375 151 224 197 403 207 808 l6 227 -39 0 c-22 0 -69 -11 -105 -24z" />
      </g>
    </svg>
  );
}

function LobuRightWing({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="221 0 221.163213 420.701311"
      fill="currentColor"
      preserveAspectRatio="xMinYMid meet"
      aria-hidden="true"
    >
      <g transform="translate(-10.239564,430.701311) scale(0.1,-0.1)">
        <path d="M2510 4271 c-4 -278 9 -467 40 -604 29 -131 95 -276 178 -392 51 -71 81 -103 462 -491 190 -193 220 -229 258 -300 57 -111 75 -194 69 -314 -6 -109 -34 -205 -87 -296 -24 -41 -133 -158 -356 -384 -349 -354 -384 -398 -455 -574 -72 -179 -108 -388 -112 -641 -1 -90 2 -167 6 -171 11 -12 141 13 200 38 109 45 209 121 342 259 72 74 231 238 355 364 124 127 334 342 465 480 132 137 294 306 360 375 146 151 172 184 218 276 57 112 71 174 71 304 0 131 -21 217 -80 331 -45 86 -87 132 -543 599 -669 685 -974 990 -1036 1034 -103 74 -205 119 -304 135 l-51 8 0 -36z" />
      </g>
    </svg>
  );
}

function DatabaseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

function FingerprintIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4" />
      <path d="M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2" />
    </svg>
  );
}

function HardDriveIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="12" x2="2" y2="12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function CableIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9a2 2 0 0 1-2-2V5h6v2a2 2 0 0 1-2 2Z" />
      <path d="M3 5V3" />
      <path d="M7 5V3" />
      <path d="M19 21a2 2 0 0 1-2-2v-2h6v2a2 2 0 0 1-2 2Z" />
      <path d="M21 21v-2" />
      <path d="M17 21v-2" />
      <path d="M5 9v3a4 4 0 0 0 4 4h6a4 4 0 0 1 4 4v0" />
    </svg>
  );
}

function RssIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" />
    </svg>
  );
}

function PillButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ComponentChildren;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={`group relative flex h-8 items-center gap-1.5 rounded-full text-[13px] transition-all duration-200 ${
        active ? "px-2.5" : "w-8 justify-center px-0"
      }`}
      style={{
        background: active ? "var(--color-page-surface-dim)" : "transparent",
        color: active
          ? "var(--color-page-text)"
          : "var(--color-page-text-muted)",
      }}
      aria-pressed={active}
    >
      <span class="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
        {icon}
      </span>
      <span
        class="overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200"
        style={{
          maxWidth: active ? "8rem" : "0",
          opacity: active ? 1 : 0,
          paddingRight: active ? "0.125rem" : "0",
          fontWeight: active ? 600 : 500,
        }}
      >
        {label}
      </span>
    </button>
  );
}

function SearchPillButton({ badge }: { badge?: number }) {
  return (
    <button
      type="button"
      class="relative flex h-8 w-8 items-center justify-center rounded-full transition-colors"
      style={{ color: "var(--color-page-text-muted)" }}
      aria-label="Search (⌘K)"
    >
      <SearchIcon size={14} />
      {badge ? (
        <span
          class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
          style={{ background: "var(--color-tg-accent)" }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function PillRow({
  pill,
  onPillChange,
  inboxBadge,
}: {
  pill: Pill;
  onPillChange?: (next: Pill) => void;
  inboxBadge?: number;
}) {
  return (
    <div class="flex items-center gap-1 px-2 py-2">
      <PillButton
        active={pill === "connections"}
        icon={<LobuLeftWing size={14} />}
        label="Connectors"
        onClick={() => onPillChange?.("connections")}
      />
      <PillButton
        active={pill === "home"}
        icon={<DatabaseIcon size={14} />}
        label="Memory"
        onClick={() => onPillChange?.("home")}
      />
      <PillButton
        active={pill === "agents"}
        icon={<LobuRightWing size={14} />}
        label="Agents"
        onClick={() => onPillChange?.("agents")}
      />
      <div class="ml-auto">
        <SearchPillButton badge={inboxBadge} />
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  label,
}: {
  icon: ComponentChildren;
  label: string;
}) {
  return (
    <div
      class="flex items-center gap-1.5 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider"
      style={{ color: "var(--color-page-text-muted)" }}
    >
      <span class="opacity-70">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function SidebarRow({
  active,
  onClick,
  leading,
  label,
  count,
  muted,
}: {
  active?: boolean;
  onClick?: () => void;
  leading: ComponentChildren;
  label: string;
  count?: number | string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-left transition-colors hover:bg-[rgba(0,0,0,0.04)]"
      style={{
        background: active ? "var(--color-page-surface-dim)" : "transparent",
        color: active
          ? "var(--color-page-text)"
          : muted
            ? "var(--color-page-text-muted)"
            : "var(--color-page-text)",
        fontWeight: active ? 600 : 500,
      }}
    >
      <span class="flex h-4 w-4 shrink-0 items-center justify-center">
        {leading}
      </span>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      {count != null ? (
        <span
          class="text-[11px] tabular-nums"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function StatusDot({ tone }: { tone: "green" | "amber" | "muted" }) {
  const bg =
    tone === "green" ? "#22c55e" : tone === "amber" ? "#f59e0b" : "#9ca3af";
  return (
    <span
      class="block h-1.5 w-1.5 rounded-full"
      style={{ background: bg }}
      aria-hidden="true"
    />
  );
}

function MemoryPillSection({
  entities,
  activeNav,
  onStageChange,
}: {
  entities: EntityNavItem[];
  activeNav: NavStage;
  onStageChange?: (stage: HeroStageId) => void;
}) {
  return (
    <div class="flex flex-col">
      <SectionHeader icon={<DatabaseIcon size={12} />} label="Entities" />
      <div class="flex flex-col gap-0.5 px-2">
        {entities.map((item) => (
          <SidebarRow
            key={item.label}
            active={activeNav === "members" && item.active}
            onClick={() => onStageChange?.("model")}
            leading={<span class="text-[13px]">{item.emoji}</span>}
            label={item.label}
            count={item.count}
          />
        ))}
      </div>
      <SectionHeader icon={<RssIcon size={12} />} label="Events" />
      <div class="flex flex-col gap-0.5 px-2 pb-2">
        <SidebarRow
          active={activeNav === "knowledge"}
          onClick={() => onStageChange?.("knowledge")}
          leading={<RssIcon size={12} />}
          label="All knowledge"
          count={1284}
        />
      </div>
    </div>
  );
}

type SidebarConnection = {
  label: string;
  connectorName: string;
  initial: string;
  status: "active" | "pending";
  feedCount?: number;
};

// Brand mark registry. Paths are simplified silhouettes of each vendor's
// SimpleIcons mark (single-color, viewBox 0 0 24 24) so we can re-tint via
// the brand color background. The fallback (BrandLetter) handles names we
// don't have a mark for.
const BRAND_REGISTRY: Record<string, { color: string; path: string }> = {
  github: {
    color: "#181717",
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.111.82-.261.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  linkedin: {
    color: "#0A66C2",
    path: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.226.792 24 1.771 24h20.451C23.2 24 24 23.226 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  },
  slack: {
    color: "#4A154B",
    path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.527 2.527 0 0 1 2.521 2.521 2.527 2.527 0 0 1-2.521 2.521H2.522A2.527 2.527 0 0 1 0 8.834a2.527 2.527 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.527 2.527 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  },
  gmail: {
    color: "#EA4335",
    path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  },
  stripe: {
    color: "#635BFF",
    path: "M13.479 9.883c-1.626-.604-2.512-1.067-2.512-1.803 0-.622.511-.977 1.422-.977 1.668 0 3.379.642 4.558 1.22l.666-4.111c-.935-.446-2.847-1.177-5.49-1.177-1.87 0-3.425.489-4.536 1.401-1.155.954-1.757 2.334-1.757 4.005 0 3.027 1.847 4.328 4.855 5.42 1.937.696 2.587 1.192 2.587 1.954 0 .74-.629 1.158-1.77 1.158-1.396 0-3.741-.69-5.323-1.585L5.5 19.612c1.305.74 3.722 1.5 6.245 1.5 1.977 0 3.629-.464 4.752-1.358 1.262-.985 1.915-2.432 1.915-4.155 0-3.105-1.89-4.392-4.933-5.516z",
  },
  hubspot: {
    color: "#FF7A59",
    path: "M18.164 7.93V5.084a2.198 2.198 0 0 0 1.27-1.985v-.067A2.2 2.2 0 0 0 17.238.832h-.067a2.2 2.2 0 0 0-2.198 2.2v.067a2.196 2.196 0 0 0 1.27 1.985V7.93a6.226 6.226 0 0 0-2.957 1.296L5.512 3.917c.027-.103.045-.21.045-.319A1.717 1.717 0 1 0 4.598 4.91l7.69 5.99a6.255 6.255 0 0 0-.939 3.31c0 1.27.382 2.452 1.04 3.444l-2.341 2.34a2.005 2.005 0 0 0-.585-.097 2.05 2.05 0 1 0 2.052 2.05c0-.205-.039-.405-.094-.594l2.314-2.314a6.27 6.27 0 1 0 4.43-11.108zm-1.107 9.397a3.22 3.22 0 1 1 0-6.44 3.22 3.22 0 0 1 0 6.44z",
  },
  notion: {
    color: "#111111",
    path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933z",
  },
  discord: {
    color: "#5865F2",
    path: "M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z",
  },
  telegram: {
    color: "#26A5E4",
    path: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.464.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  },
  whatsapp: {
    color: "#25D366",
    path: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0 0 20.465 3.488",
  },
  crunchbase: {
    color: "#146AFF",
    path: "M21.6 0H2.4A2.41 2.41 0 0 0 0 2.4v19.2A2.41 2.41 0 0 0 2.4 24h19.2a2.41 2.41 0 0 0 2.4-2.4V2.4A2.41 2.41 0 0 0 21.6 0zM9.7 16.8c-.7 0-1.4-.17-2-.5v.4H6V5.06h1.7v3.7a4.04 4.04 0 0 1 2-.55c2.39 0 4.32 1.94 4.32 4.3 0 2.37-1.93 4.3-4.32 4.3zm6.9-.5c-.6.33-1.3.5-2 .5-2.37 0-4.3-1.93-4.3-4.3 0-2.36 1.93-4.3 4.3-4.3 1.43 0 2.74.7 3.54 1.83l-1.43.95a2.6 2.6 0 0 0-4.7 1.52 2.6 2.6 0 0 0 4.7 1.5l1.43.97a4.27 4.27 0 0 1-1.54 1.33zM9.7 10.04A2.6 2.6 0 0 0 7.1 12.6a2.6 2.6 0 0 0 5.2 0 2.6 2.6 0 0 0-2.6-2.55z",
  },
  linear: {
    color: "#5E6AD2",
    path: "M.403 13.795A12.131 12.131 0 0 0 10.203 23.6L.403 13.795zM.182 10.103l13.715 13.714a12.18 12.18 0 0 0 3.137-1.21L1.392 6.966a12.18 12.18 0 0 0-1.21 3.137zm3.135-5.836a12.16 12.16 0 0 1 1.51-1.84L21.572 19.17a12.137 12.137 0 0 1-1.84 1.51L3.317 4.267zM6.682 1.43A12.12 12.12 0 0 1 12 0c6.626 0 12 5.374 12 12 0 1.872-.428 3.643-1.193 5.22L6.682 1.43Z",
  },
  zoom: {
    color: "#0B5CFF",
    path: "M24 12C24 5.4 18.6 0 12 0S0 5.4 0 12s5.4 12 12 12 12-5.4 12-12zM4.4 6.2h7.1c1.7 0 3.1 1.4 3.1 3.1v5.5H7.5c-1.7 0-3.1-1.4-3.1-3.1V6.2zm15.2 9.4l-3-2.6V7.2l3-2.6c.4-.3 1.1 0 1.1.6v10.8c0 .6-.7.9-1.1.6z",
  },
  // chat / mcp clients
  openclaw: {
    color: "#F97316",
    path: "M12 2 4 6v6c0 4.5 3.5 8.5 8 10 4.5-1.5 8-5.5 8-10V6l-8-4zm0 2.2 6 3v4.8c0 3.5-2.8 6.8-6 7.9-3.2-1.1-6-4.4-6-7.9V7.2l6-3z",
  },
  chatgpt: {
    color: "#10A37F",
    path: "M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A5.98 5.98 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z",
  },
  claude: {
    color: "#D97757",
    path: "M4.709 15.955l4.72-2.647.079-.23-.079-.128H9.2l-.79-.048-2.698-.073-2.34-.097-2.265-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.6-2.552-1.687-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.892.686 1.908 1.477 2.491 1.834.365.304.146-.103.018-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 0 1-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.418 1.002 2.228 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.2-1.657-.85-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.926-1.415-2.167-1.142-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.388-1.924.316-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.413.164-.716-.37.067-.662.4-.59 2.388-3.036 1.44-1.882.93-1.087-.006-.158h-.054L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
  },
  cursor: {
    color: "#000000",
    path: "M11.925 24l10.425-6-10.425-6L1.5 18l10.425 6zM22.35 6L11.925 0 1.5 6v12l10.425-6L22.35 6z",
  },
};

function brandKey(name: string): string | null {
  const k = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!k) return null;
  if (k in BRAND_REGISTRY) return k;
  // suffix matches (e.g. "Crunchbase API" -> "crunchbase")
  for (const key of Object.keys(BRAND_REGISTRY)) {
    if (k.startsWith(key) || k.includes(key)) return key;
  }
  return null;
}

function BrandLetter({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase() || "?";
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      class="inline-flex items-center justify-center rounded text-[9px] font-semibold text-white"
      style={{
        width: "100%",
        height: "100%",
        background: `hsl(${hue} 55% 50%)`,
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

function BrandLogo({
  name,
  size = 16,
  radius = 3,
}: {
  name: string;
  size?: number;
  radius?: number;
}) {
  const key = brandKey(name);
  const brand = key ? BRAND_REGISTRY[key] : null;
  return (
    <span
      class="inline-flex items-center justify-center shrink-0"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${radius}px`,
        background: brand ? brand.color : "transparent",
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      {brand ? (
        <svg
          width={Math.round(size * 0.7)}
          height={Math.round(size * 0.7)}
          viewBox="0 0 24 24"
          fill="white"
          aria-hidden="true"
        >
          <path d={brand.path} />
        </svg>
      ) : (
        <BrandLetter name={name} />
      )}
    </span>
  );
}

function ConnectorTinyMark({ name }: { name: string }) {
  return <BrandLogo name={name} size={16} radius={3} />;
}

function ConnectorsPillSection({
  connections,
  activeNav,
  onStageChange,
}: {
  connections: SidebarConnection[];
  activeNav: NavStage;
  onStageChange?: (stage: HeroStageId) => void;
}) {
  return (
    <div class="flex flex-col">
      <SectionHeader icon={<CableIcon size={12} />} label="Connections" />
      <div class="flex flex-col gap-0.5 px-2">
        {connections.map((c, i) => (
          <SidebarRow
            key={`${c.connectorName}-${c.label}-${i}`}
            active={activeNav === "connectors" && i === 0}
            onClick={() => onStageChange?.("integrate")}
            leading={
              <span class="flex items-center gap-1.5">
                <StatusDot tone={c.status === "active" ? "green" : "amber"} />
                <ConnectorTinyMark name={c.connectorName} />
              </span>
            }
            label={c.label}
            count={c.feedCount}
          />
        ))}
      </div>
      <SectionHeader icon={<HardDriveIcon size={12} />} label="Devices" />
      <div class="flex flex-col gap-0.5 px-2 pb-2">
        <SidebarRow
          leading={<StatusDot tone="green" />}
          label="Burak's MacBook Pro"
        />
        <SidebarRow
          leading={<StatusDot tone="muted" />}
          label="ops-runner-01"
          muted
        />
      </div>
    </div>
  );
}

type SidebarAgent = { name: string };
type SidebarWatcher = { name: string };

function AgentTabLink({
  icon,
  label,
}: {
  icon: ComponentChildren;
  label: string;
}) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12px] text-left transition-colors hover:bg-[rgba(0,0,0,0.04)]"
      style={{ color: "var(--color-page-text-muted)" }}
    >
      <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span class="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function AgentSubGroup({
  label,
  icon,
  items,
  active,
}: {
  label: string;
  icon: ComponentChildren;
  items: Array<{ name: string; leading?: ComponentChildren }>;
  active?: boolean;
}) {
  return (
    <div class="flex flex-col gap-0.5 pt-1">
      <div
        class="flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider"
        style={{
          color: active
            ? "var(--color-page-text)"
            : "var(--color-page-text-muted)",
        }}
      >
        <span style={{ opacity: 0.8 }}>{icon}</span>
        <span>{label}</span>
      </div>
      {items.map((it) => (
        <button
          key={it.name}
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12px] text-left transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: "var(--color-page-text)" }}
        >
          {it.leading ? (
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              {it.leading}
            </span>
          ) : null}
          <span class="min-w-0 flex-1 truncate">{it.name}</span>
        </button>
      ))}
    </div>
  );
}

function AgentsPillSection({
  agents,
  watchers,
  activeNav,
  onStageChange,
}: {
  agents: SidebarAgent[];
  watchers: SidebarWatcher[];
  activeNav: NavStage;
  onStageChange?: (stage: HeroStageId) => void;
}) {
  // First agent is the "selected" one in the demo. Its detail page renders
  // a Watchers / Providers / Skills / Channels / Settings stack so the
  // sidebar mirrors the same set of nested rows with sample items.
  return (
    <div class="flex flex-col">
      <SectionHeader icon={<LobuRightWing size={12} />} label="Agents" />
      <div class="flex flex-col gap-0.5 px-2">
        {agents.map((a, i) => {
          const isSelected = i === 0;
          const isActive =
            (activeNav === "agents" || activeNav === "watchers") && isSelected;
          return (
            <div key={a.name} class="flex flex-col">
              <SidebarRow
                active={isActive}
                onClick={() => onStageChange?.("connect")}
                leading={<BotIcon size={12} />}
                label={a.name}
              />
              {isSelected ? (
                <div
                  class="ml-3 mt-0.5 flex flex-col gap-0.5 px-2 pb-1"
                  style={{
                    borderLeft: "1px solid var(--color-page-border)",
                  }}
                >
                  <AgentSubGroup
                    label="Watchers"
                    icon={<WatchersIcon size={10} />}
                    items={watchers.map((w) => ({
                      name: w.name,
                      leading: <StatusDot tone="green" />,
                    }))}
                    active={activeNav === "watchers"}
                  />
                  <AgentTabLink
                    icon={<KeyIcon size={11} />}
                    label="Providers"
                  />
                  <AgentTabLink icon={<CodeIcon size={11} />} label="Skills" />
                  <AgentTabLink
                    icon={<LobuRightWing size={11} />}
                    label="Channels"
                  />
                  <AgentTabLink
                    icon={<FingerprintIcon size={11} />}
                    label="Personality"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MenuIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function Sidebar({
  activeNav,
  onStageChange,
  entities,
  connections,
  agents,
  watchers,
  mobileOpen,
  onMobileClose,
}: {
  activeNav: NavStage;
  onStageChange?: (stage: HeroStageId) => void;
  entities: EntityNavItem[];
  connections: SidebarConnection[];
  agents: SidebarAgent[];
  watchers: SidebarWatcher[];
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const pill = pillForStage(activeNav);
  const handlePillChange = (next: Pill) => {
    if (next === "connections") onStageChange?.("integrate");
    else if (next === "agents") onStageChange?.("connect");
    else onStageChange?.("model");
    onMobileClose?.();
  };

  // Wrap onStageChange to auto-close the mobile drawer when an item is chosen.
  const wrappedOnStageChange = onStageChange
    ? (s: HeroStageId) => {
        onStageChange(s);
        onMobileClose?.();
      }
    : undefined;

  const sidebarBody = (
    <>
      <div class="flex items-center justify-between md:block">
        <PillRow pill={pill} onPillChange={handlePillChange} inboxBadge={3} />
        <button
          type="button"
          onClick={onMobileClose}
          aria-label="Close menu"
          class="mr-2 md:hidden inline-flex h-7 w-7 items-center justify-center rounded-md"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <CloseIcon />
        </button>
      </div>
      <div class="flex-1">
        {pill === "home" ? (
          <MemoryPillSection
            entities={entities}
            activeNav={activeNav}
            onStageChange={wrappedOnStageChange}
          />
        ) : null}
        {pill === "connections" ? (
          <ConnectorsPillSection
            connections={connections}
            activeNav={activeNav}
            onStageChange={wrappedOnStageChange}
          />
        ) : null}
        {pill === "agents" ? (
          <AgentsPillSection
            agents={agents}
            watchers={watchers}
            activeNav={activeNav}
            onStageChange={wrappedOnStageChange}
          />
        ) : null}
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar — grid column 1 */}
      <aside
        class="hidden md:flex flex-col"
        style={{
          background: "var(--color-page-surface-dim)",
          borderRight: "1px solid var(--color-page-border)",
          width: "248px",
          minWidth: "248px",
        }}
      >
        {sidebarBody}
      </aside>

      {/* Mobile drawer + backdrop */}
      {mobileOpen ? (
        <>
          <div
            class="md:hidden absolute inset-0 z-10"
            style={{ background: "rgba(0,0,0,0.4)" }}
            onClick={onMobileClose}
            aria-hidden="true"
          />
          <aside
            class="md:hidden absolute inset-y-0 left-0 z-20 flex flex-col"
            style={{
              background: "var(--color-page-surface-dim)",
              borderRight: "1px solid var(--color-page-border)",
              width: "248px",
            }}
          >
            {sidebarBody}
          </aside>
        </>
      ) : null}
    </>
  );
}

function AppShell({
  activeNav,
  pageTitle,
  pageSubtitle,
  toolbar,
  children,
  rightPanel,
  onStageChange,
  entities,
  connections,
  agents,
  watchers,
}: {
  activeNav: NavStage;
  entities: EntityNavItem[];
  connections: SidebarConnection[];
  agents: SidebarAgent[];
  watchers: SidebarWatcher[];
  pageTitle: string;
  pageSubtitle?: string;
  toolbar?: ComponentChildren;
  children: ComponentChildren;
  rightPanel?: ComponentChildren;
  onStageChange?: (stage: HeroStageId) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div
      class="max-w-[72rem] mx-auto rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-[248px_1fr] relative bg-[var(--color-page-surface)]"
      style={{
        border: "1px solid var(--color-page-border)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.06)",
      }}
    >
      <Sidebar
        activeNav={activeNav}
        onStageChange={onStageChange}
        entities={entities}
        connections={connections}
        agents={agents}
        watchers={watchers}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div class="relative flex flex-col min-h-0 overflow-hidden">
        <div
          class="md:hidden flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: "1px solid var(--color-page-border)" }}
        >
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            class="inline-flex h-8 w-8 items-center justify-center rounded-md"
            style={{ color: "var(--color-page-text)" }}
          >
            <MenuIcon />
          </button>
          <span
            class="text-[12px] font-medium"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            lobu-prod
          </span>
        </div>
        {pageTitle ? (
          <div
            class="px-4 pt-3 pb-3"
            style={{ borderBottom: "1px solid var(--color-page-border)" }}
          >
            <div class="flex flex-wrap items-center gap-3">
              <div class="flex flex-col min-w-0">
                <h3
                  class="font-display text-[16px] font-semibold leading-tight"
                  style={{
                    color: "var(--color-page-text)",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {pageTitle}
                </h3>
                {pageSubtitle ? (
                  <p
                    class="text-[11px] mt-0.5 leading-snug"
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
        ) : null}
        <div class="flex-1 px-4 py-3">{children}</div>
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
    <div class="rounded-lg overflow-hidden">
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
    <div class="p-1">
      <div class="flex flex-wrap items-start gap-3">
        <span
          class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[15px]"
          style={{ background: "var(--color-page-surface-dim)" }}
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

function StatsStripCard({
  stats,
}: {
  stats: Array<{ label: string; value: number }>;
}) {
  return (
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {stats.map((s) => (
        <div
          key={s.label}
          class="rounded-lg px-3 py-2"
          style={{ background: "var(--color-page-surface-dim)" }}
        >
          <div
            class="text-[11px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {s.label}
          </div>
          <div
            class="mt-0.5 text-[20px] font-semibold leading-none"
            style={{ color: "var(--color-page-text)" }}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function FeatureGridLite({
  items,
}: {
  items: Array<{ icon: ComponentChildren; title: string; body: string }>;
}) {
  return (
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
      {items.map((it) => (
        <div
          key={it.title}
          class="rounded-lg p-3 flex flex-col gap-1.5"
          style={{ background: "var(--color-page-surface-dim)" }}
        >
          <span
            class="inline-flex h-5 w-5 items-center justify-center"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {it.icon}
          </span>
          <span
            class="text-[12px] font-medium"
            style={{ color: "var(--color-page-text)" }}
          >
            {it.title}
          </span>
          <p
            class="text-[11px] leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {it.body}
          </p>
        </div>
      ))}
    </div>
  );
}

function FolderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ShieldIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function BellIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function CloudIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 16.9" />
    </svg>
  );
}

function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function CodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function LibraryIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </svg>
  );
}

function PlugIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

function KeyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

type DeviceAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "copy"; label: string; command: string }
  | { kind: "status"; label: string };

function CopyIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ExternalIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function BrandTile({
  icon,
  iconBg,
  name,
  subtitle,
  trailing,
  onClick,
  href,
}: {
  icon: ComponentChildren;
  iconBg: string;
  name: string;
  subtitle: string;
  trailing?: ComponentChildren;
  onClick?: () => void;
  href?: string;
}) {
  const inner = (
    <>
      <span
        class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-white"
        style={{ background: iconBg }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div class="min-w-0 flex-1">
        <div
          class="text-[12px] font-medium truncate"
          style={{ color: "var(--color-page-text)" }}
        >
          {name}
        </div>
        <div
          class="text-[10px] truncate"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {subtitle}
        </div>
      </div>
      {trailing ? (
        <span
          class="shrink-0"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {trailing}
        </span>
      ) : null}
    </>
  );
  const cls =
    "flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-[var(--color-page-surface)]";
  const style = { background: "var(--color-page-surface-dim)" };
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        class={cls}
        style={style}
      >
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        class={`${cls} text-left`}
        style={style}
      >
        {inner}
      </button>
    );
  }
  return (
    <div class={cls} style={style}>
      {inner}
    </div>
  );
}

function DeviceTargetCard({
  icon,
  iconBg,
  name,
  subtitle,
  action,
}: {
  icon: ComponentChildren;
  iconBg: string;
  name: string;
  subtitle: string;
  action: DeviceAction;
}) {
  const [copied, setCopied] = useState(false);
  if (action.kind === "link") {
    return (
      <BrandTile
        icon={icon}
        iconBg={iconBg}
        name={name}
        subtitle={subtitle}
        trailing={<ExternalIcon size={12} />}
        href={action.href}
      />
    );
  }
  if (action.kind === "copy") {
    const handleCopy = async () => {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      try {
        await navigator.clipboard.writeText(action.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // noop
      }
    };
    return (
      <BrandTile
        icon={icon}
        iconBg={iconBg}
        name={name}
        subtitle={subtitle}
        trailing={copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        onClick={handleCopy}
      />
    );
  }
  return (
    <BrandTile
      icon={icon}
      iconBg={iconBg}
      name={name}
      subtitle={subtitle}
      trailing={<StatusDot tone="green" />}
    />
  );
}

function ConnectorCatalogTile({
  name,
  category,
}: {
  name: string;
  category: string;
}) {
  return (
    <div
      class="flex items-center gap-2 rounded-md p-2"
      style={{ background: "var(--color-page-surface-dim)" }}
    >
      <BrandLogo name={name} size={26} radius={4} />
      <div class="min-w-0">
        <div
          class="text-[12px] font-medium truncate"
          style={{ color: "var(--color-page-text)" }}
        >
          {name}
        </div>
        <div
          class="text-[10px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {category}
        </div>
      </div>
    </div>
  );
}

function ConnectorsLanding({
  connectorRows,
}: {
  connectorRows: ConnectorRow[];
}) {
  const totalConnections = connectorRows.reduce(
    (acc, c) => acc + c.connections.length,
    0
  );
  const stats = [
    { label: "Connectors", value: connectorRows.length },
    { label: "Connections", value: totalConnections },
    { label: "Feeds", value: totalConnections * 3 },
    { label: "Devices", value: 2 },
  ];

  const deviceBenefits = [
    {
      icon: <FolderIcon />,
      title: "Local data into memory",
      body: "Files, Screen Time, browser history — sources that only live on your machine.",
    },
    {
      icon: <ShieldIcon />,
      title: "Secure browser auth",
      body: "Cookies and tokens stay on-device. Lobu's servers never see them.",
    },
    {
      icon: <BellIcon />,
      title: "Local notifications",
      body: "Chat events, watcher triggers, and tool calls in your menu bar.",
    },
    {
      icon: <HardDriveIcon size={14} />,
      title: "Hybrid execution",
      body: "Pin sensitive workloads to your device. Everything else runs serverless.",
    },
  ];

  const cliCommand = "npm i -g @lobu/cli\nlobu login";
  const dockerCommand = `docker run -d --name lobu-bridge \\
  -v lobu-state:/var/lib/lobu \\
  -e LOBU_WORKSPACE_URL=<workspace-url> \\
  ghcr.io/lobu-ai/lobu-bridge:latest`;

  const deviceTargets: Array<{
    icon: ComponentChildren;
    iconBg: string;
    name: string;
    subtitle: string;
    action: DeviceAction;
  }> = [
    {
      icon: (
        <svg
          aria-hidden="true"
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.52-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.08zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
        </svg>
      ),
      iconBg: "#111111",
      name: "macOS",
      subtitle: "Menu bar app · .dmg",
      action: {
        kind: "link",
        label: "Download .dmg",
        href: "https://github.com/lobu-ai/lobu/releases/latest/download/Owletto.dmg",
      },
    },
    {
      icon: <TerminalIcon size={12} />,
      iconBg: "#1F2937",
      name: "CLI",
      subtitle: "npm i -g @lobu/cli",
      action: { kind: "copy", label: "Install + log in", command: cliCommand },
    },
    {
      icon: (
        <svg
          aria-hidden="true"
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.185.185 0 0 0-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 0 0 .186-.186V3.574a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.186m0 2.715h2.118a.187.187 0 0 0 .186-.186V6.29a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H8.1a.185.185 0 0 0-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 0 0 .185-.186V6.29a.185.185 0 0 0-.185-.185H5.136a.186.186 0 0 0-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.184-.186h-2.12a.185.185 0 0 0-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 0 0 .185-.185V9.006a.185.185 0 0 0-.184-.186h-2.12a.186.186 0 0 0-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.184-.186h-2.12a.185.185 0 0 0-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 0 0-.75.748 11.376 11.376 0 0 0 .692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137a16.094 16.094 0 0 0 2.913-.262 12.27 12.27 0 0 0 3.805-1.38c.965-.582 1.832-1.31 2.572-2.161 1.236-1.418 1.974-3.012 2.521-4.426h.097c1.71 0 2.616-.823 2.65-1.74l.005-.184Z" />
        </svg>
      ),
      iconBg: "#2496ED",
      name: "Docker",
      subtitle: "Self-hosted bridge",
      action: { kind: "copy", label: "Run command", command: dockerCommand },
    },
    {
      icon: <CloudIcon size={12} />,
      iconBg: "#0EA5E9",
      name: "Serverless",
      subtitle: "Free in beta",
      action: { kind: "status", label: "Free in beta" },
    },
  ];

  const connectionPaths = [
    {
      icon: <LibraryIcon />,
      title: "Pick from the catalog",
      body: "50+ built-in connectors. OAuth, API key, or browser session.",
    },
    {
      icon: <PlugIcon />,
      title: "Bring your own MCP server",
      body: "Point Lobu at any MCP endpoint. Tools wire into memory automatically.",
    },
    {
      icon: <CodeIcon />,
      title: "Let your agent write one",
      body: "Lobu runs agent-authored TypeScript connectors serverlessly — no hosting.",
    },
    {
      icon: <KeyIcon />,
      title: "Any auth shape",
      body: "API key, OAuth, browser session, or none. Credentials stay where you choose.",
    },
  ];

  const catalogTiles: Array<{ name: string; category: string }> = connectorRows
    .slice(0, 8)
    .map((c) => ({
      name: c.name,
      category: c.description,
    }));
  const fallbacks: Array<{ name: string; category: string }> = [
    { name: "Slack", category: "Chat" },
    { name: "GitHub", category: "Code" },
    { name: "Linear", category: "Issues" },
    { name: "Notion", category: "Docs" },
    { name: "Gmail", category: "Email" },
    { name: "Stripe", category: "Payments" },
    { name: "HubSpot", category: "CRM" },
    { name: "LinkedIn", category: "People" },
  ];
  while (catalogTiles.length < 8) {
    catalogTiles.push(fallbacks[catalogTiles.length % fallbacks.length]);
  }

  return (
    <div class="flex flex-col gap-4">
      <StatsStripCard stats={stats} />

      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <HardDriveIcon size={14} />
          <h4
            class="text-[13px] font-semibold leading-none"
            style={{ color: "var(--color-page-text)" }}
          >
            Devices
          </h4>
        </div>
        <FeatureGridLite items={deviceBenefits} />
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {deviceTargets.map((t) => (
            <DeviceTargetCard
              key={t.name}
              icon={t.icon}
              iconBg={t.iconBg}
              name={t.name}
              subtitle={t.subtitle}
              action={t.action}
            />
          ))}
        </div>
      </div>

      <div class="flex flex-col gap-2 pt-2">
        <div class="flex items-center gap-2">
          <CableIcon size={14} />
          <h4
            class="text-[13px] font-semibold leading-none"
            style={{ color: "var(--color-page-text)" }}
          >
            Connections
          </h4>
        </div>
        <FeatureGridLite items={connectionPaths} />
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {catalogTiles.map((t, i) => (
            <ConnectorCatalogTile key={`${t.name}-${i}`} {...t} />
          ))}
        </div>
      </div>
    </div>
  );
}

type ActionMode = "auto" | "approval" | "disabled";

function ActionModeChips({ mode }: { mode: ActionMode }) {
  const items: Array<{
    id: ActionMode;
    label: string;
    tone: "green" | "amber" | "muted";
  }> = [
    { id: "auto", label: "Auto", tone: "green" },
    { id: "approval", label: "Approval", tone: "amber" },
    { id: "disabled", label: "Disabled", tone: "muted" },
  ];
  return (
    <span
      class="inline-flex rounded-md overflow-hidden"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      {items.map((item) => {
        const active = item.id === mode;
        const palette =
          item.tone === "green"
            ? { bg: "rgba(16,185,129,0.18)", fg: "#047857" }
            : item.tone === "amber"
              ? { bg: "rgba(245,158,11,0.18)", fg: "#b45309" }
              : { bg: "rgba(0,0,0,0.05)", fg: "var(--color-page-text-muted)" };
        return (
          <span
            key={item.id}
            class="px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider"
            style={{
              background: active ? palette.bg : "transparent",
              color: active ? palette.fg : "var(--color-page-text-muted)",
              opacity: active ? 1 : 0.6,
            }}
          >
            {item.label}
          </span>
        );
      })}
    </span>
  );
}

function ConnectorsTable({ connectors }: { connectors: ConnectorRow[] }) {
  const firstWithConnections = connectors.find((c) => c.connections.length > 0);
  const [openId, setOpenId] = useState<string | null>(
    firstWithConnections?.id ?? null
  );
  const cols = "1.5fr 1.6fr 0.9fr 0.7fr";

  function modeFor(c: ConnectorRow, idx: number): ActionMode {
    if (c.connections.length === 0) return "disabled";
    return idx % 3 === 1 ? "approval" : "auto";
  }

  function runOnFor(c: ConnectorRow, idx: number): string {
    if (c.connections.length === 0) return "—";
    const devices = ["Any device", "Burak's MacBook", "ops-runner-01"];
    return devices[idx % devices.length];
  }

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
        <span>Action mode</span>
        <span>Run on</span>
        <span class="text-right">Status</span>
      </div>
      {connectors.map((c, i) => {
        const open = openId === c.id;
        const isLast = i === connectors.length - 1;
        const hasConnections = c.connections.length > 0;
        const mode = modeFor(c, i);
        const runOn = runOnFor(c, i);
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
                <span class="flex flex-col min-w-0">
                  <span class="truncate">{c.name}</span>
                  {hasConnections ? (
                    <span
                      class="text-[11px] truncate"
                      style={{ color: "var(--color-page-text-muted)" }}
                    >
                      {c.connections.length} connection
                      {c.connections.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </span>
              </span>
              <span>
                <ActionModeChips mode={mode} />
              </span>
              <span
                class="flex items-center gap-1.5 text-[12px] truncate"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                <HardDriveIcon size={11} />
                <span class="truncate">{runOn}</span>
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

function KnowledgeSearchInput() {
  return (
    <div
      class="flex items-center gap-2 rounded-md px-2.5 py-1.5"
      style={{ background: "var(--color-page-surface-dim)" }}
    >
      <SearchIcon size={12} />
      <input
        type="text"
        placeholder="Search knowledge..."
        class="flex-1 bg-transparent text-[12px] outline-none"
        style={{ color: "var(--color-page-text)" }}
      />
    </div>
  );
}

function KnowledgeFeed({ rows }: { rows?: KnowledgeRow[] }) {
  const useDynamic = rows && rows.length > 0;
  const items = useDynamic
    ? rows
        .slice(0, 2)
        .map((row) => <UseCaseKnowledgeCard key={row.id} row={row} />)
    : KNOWLEDGE_ITEMS.slice(0, 2).map((item) =>
        item.kind === "action" ? (
          <KnowledgeActionCard key={item.id} item={item} />
        ) : (
          <KnowledgeCard key={item.id} item={item} />
        )
      );
  return (
    <div class="flex flex-col gap-3">
      <KnowledgeSearchInput />
      <div class="flex flex-col gap-3">{items}</div>
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

function WatcherDetail({ watchers }: { watchers: WatcherRow[] }) {
  // Sidebar already lists every watcher under the active agent, so the
  // content pane only renders the currently-selected one — matches v2
  // /agents/$agentId?tab=watchers&w=<id> where the route is a single
  // watcher, not a list.
  const selected = watchers[0];
  if (!selected) return null;

  type MemoryWrite = {
    entityType: string;
    title: string;
    body: string;
    source: string;
    sourceBrand: string;
  };
  const runs: Array<{
    when: string;
    status: "success" | "running" | "skipped" | "error";
    summary: string;
    writes?: MemoryWrite[];
  }> = [
    {
      when: "Just now",
      status: "success",
      summary: "Wrote 3 memory events",
      writes: [
        {
          entityType: "Company",
          title: "Lovable",
          body: "Raised $200M Series C led by a16z, valuation $1.8B. Headcount up 40% in 60 days.",
          source: "TechCrunch",
          sourceBrand: "chatgpt",
        },
        {
          entityType: "Founder",
          title: "Anton Osika",
          body: "Hired 8 engineers in October — 4 ex-Stripe, 2 ex-OpenAI. Public on LinkedIn.",
          source: "LinkedIn",
          sourceBrand: "linkedin",
        },
      ],
    },
    {
      when: "12m ago",
      status: "success",
      summary: "Wrote 1 memory event",
      writes: [
        {
          entityType: "Company",
          title: "Anysphere",
          body: "Cursor parent secured $900M from Thrive Capital. Pre-money $9B.",
          source: "Crunchbase",
          sourceBrand: "crunchbase",
        },
      ],
    },
    {
      when: "1h ago",
      status: "skipped",
      summary: "No new events since last run",
    },
    {
      when: "2h ago",
      status: "success",
      summary: "Wrote 22 events · 4 superseded older rows",
    },
    {
      when: "5h ago",
      status: "error",
      summary: "LinkedIn rate-limited — retried via fallback (succeeded)",
    },
  ];

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <StatusDot tone={selected.status === "Active" ? "green" : "muted"} />
          <span
            class="text-[14px] font-semibold truncate"
            style={{ color: "var(--color-page-text)" }}
          >
            {selected.name}
          </span>
        </div>
        <span
          class="text-[11px] tabular-nums"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {selected.schedule} · next in 47m
        </span>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div>
          <div
            class="text-[10px] uppercase tracking-wider"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Entity
          </div>
          <div
            class="text-[12px] mt-0.5"
            style={{ color: "var(--color-page-text)" }}
          >
            {entityEmoji(selected.entity)} {selected.entity}
          </div>
        </div>
        <div>
          <div
            class="text-[10px] uppercase tracking-wider"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Owner agent
          </div>
          <div
            class="text-[12px] mt-0.5"
            style={{ color: "var(--color-page-text)" }}
          >
            {selected.agent}
          </div>
        </div>
        <div>
          <div
            class="text-[10px] uppercase tracking-wider"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Last run
          </div>
          <div
            class="text-[12px] mt-0.5"
            style={{ color: "var(--color-page-text)" }}
          >
            {selected.last}
          </div>
        </div>
      </div>

      <div
        class="text-[10px] font-semibold uppercase tracking-wider pt-2"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Run timeline
      </div>

      <ol class="flex flex-col gap-3">
        {runs.map((r, i) => {
          const tone =
            r.status === "success"
              ? "green"
              : r.status === "running"
                ? "amber"
                : r.status === "error"
                  ? "muted"
                  : "muted";
          return (
            <li key={i} class="flex items-start gap-2">
              <span class="mt-1.5">
                <StatusDot tone={tone as "green" | "amber" | "muted"} />
              </span>
              <div class="min-w-0 flex-1 flex flex-col gap-1.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-2 min-w-0">
                    <span
                      class="text-[12px] font-medium capitalize"
                      style={{
                        color:
                          r.status === "error"
                            ? "#b91c1c"
                            : "var(--color-page-text)",
                      }}
                    >
                      {r.status}
                    </span>
                    <span
                      class="text-[11px] truncate"
                      style={{ color: "var(--color-page-text-muted)" }}
                    >
                      {r.summary}
                    </span>
                  </span>
                  <span
                    class="text-[11px] tabular-nums shrink-0"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    {r.when}
                  </span>
                </div>
                {r.writes && r.writes.length > 0 ? (
                  <div class="flex flex-col gap-1.5">
                    {r.writes.map((w, wi) => (
                      <div
                        key={wi}
                        class="rounded-md p-2.5 flex flex-col gap-1"
                        style={{
                          background: "var(--color-page-surface-dim)",
                        }}
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <span
                            class="text-[12px] font-semibold truncate"
                            style={{ color: "var(--color-page-text)" }}
                          >
                            {entityEmoji(w.entityType)} {w.title}
                          </span>
                          <Badge label={w.entityType} tone="amber" />
                        </div>
                        <p
                          class="text-[11px] leading-snug"
                          style={{ color: "var(--color-page-text)" }}
                        >
                          {w.body}
                        </p>
                        <div
                          class="flex items-center gap-1.5 text-[10px]"
                          style={{ color: "var(--color-page-text-muted)" }}
                        >
                          <BrandLogo
                            name={w.sourceBrand}
                            size={12}
                            radius={2}
                          />
                          <span>Source: {w.source}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function BringYourOwnAgentCard() {
  const clients: Array<{ name: string; brand: string }> = [
    { name: "Cursor", brand: "cursor" },
    { name: "Claude Code", brand: "claude" },
    { name: "ChatGPT", brand: "chatgpt" },
    { name: "OpenClaw", brand: "openclaw" },
  ];
  return (
    <div class="flex flex-col gap-2 pt-2">
      <div class="flex items-center gap-2">
        <PlugIcon size={14} />
        <h4
          class="text-[13px] font-semibold leading-none"
          style={{ color: "var(--color-page-text)" }}
        >
          Bring your own agent
        </h4>
      </div>
      <p
        class="text-[12px] leading-relaxed"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Hook up Cursor, Claude Code, ChatGPT, Codex, or any MCP-capable app.
        Same memory and connections as Lobu-hosted agents.
      </p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {clients.map((c) => (
          <div
            key={c.name}
            class="flex items-center gap-2 rounded-md p-2"
            style={{ background: "var(--color-page-surface-dim)" }}
          >
            <BrandLogo name={c.brand} size={20} radius={4} />
            <div class="min-w-0 flex-1">
              <div
                class="text-[12px] font-medium truncate"
                style={{ color: "var(--color-page-text)" }}
              >
                {c.name}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentsConnect({
  agents,
  watchers,
}: {
  info: AgentInfo;
  agents: AgentRow[];
  watchers: WatcherRow[];
}) {
  const selectedAgent = agents[0];
  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <span
          class="inline-flex h-8 w-8 items-center justify-center rounded-md"
          style={{
            background: "var(--color-page-surface-dim)",
            color: "var(--color-page-text)",
          }}
        >
          <BotIcon size={16} />
        </span>
        <div class="min-w-0 flex-1">
          <h4
            class="text-[15px] font-semibold leading-tight"
            style={{ color: "var(--color-page-text)" }}
          >
            {selectedAgent?.name ?? "Agent"}
          </h4>
          <p
            class="text-[12px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Next run in 47m
          </p>
        </div>
      </div>
      <WatcherDetail watchers={watchers} />
      <BringYourOwnAgentCard />
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

  // Flatten connectorRows (one row per connector with N nested connections)
  // into the v2 sidebar shape (one row per individual connection).
  // One row per connector (not per sub-connection) so the sidebar reflects
  // the use case's actual integrations — Crunchbase / LinkedIn for VC,
  // GitHub / Linear for engineering, etc. — instead of always showing the
  // same sample member names.
  const sidebarConnections: SidebarConnection[] = connectorRows
    .slice(0, 6)
    .map((c) => ({
      label: c.name,
      connectorName: c.name,
      initial: c.name.charAt(0).toUpperCase(),
      status: c.status === "Connected" ? "active" : "pending",
      feedCount: c.connections.length > 0 ? c.connections.length : undefined,
    }));
  const sidebarAgents: SidebarAgent[] = agentRows
    .slice(0, 4)
    .map((a) => ({ name: a.name }));
  const sidebarWatchers: SidebarWatcher[] = watcherRows
    .slice(0, 3)
    .map((w) => ({ name: w.name }));

  const shellProps = {
    entities,
    connections: sidebarConnections,
    agents: sidebarAgents,
    watchers: sidebarWatchers,
  };

  if (stage === "model") {
    return (
      <AppShell
        activeNav="members"
        {...shellProps}
        pageTitle=""
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
        {...shellProps}
        pageTitle=""
        onStageChange={onStageChange}
      >
        <ConnectorsLanding connectorRows={connectorRows} />
      </AppShell>
    );
  }

  if (stage === "knowledge") {
    return (
      <AppShell
        activeNav="knowledge"
        {...shellProps}
        pageTitle=""
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
      {...shellProps}
      pageTitle=""
      onStageChange={onStageChange}
    >
      <AgentsConnect
        info={agentInfo}
        agents={agentRows}
        watchers={watcherRows}
      />
    </AppShell>
  );
}
