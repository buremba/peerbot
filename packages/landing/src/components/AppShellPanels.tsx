// biome-ignore-all format: stays compact for the landing-page right-column

import { useState } from "preact/hooks";
import type { LandingUseCaseDefinition } from "../use-case-definitions";

/* -------------------------------------------------------------------------- */
/*  Shared primitives                                                         */
/* -------------------------------------------------------------------------- */

type Tone = "neutral" | "amber" | "violet" | "green" | "muted" | "red";

function Badge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  const palette: Record<Tone, { bg: string; color: string; border: string }> = {
    neutral: { bg: "var(--color-page-surface-dim)", color: "var(--color-page-text)", border: "transparent" },
    amber: { bg: "rgba(245,158,11,0.12)", color: "#b45309", border: "rgba(245,158,11,0.25)" },
    violet: { bg: "rgba(139,92,246,0.12)", color: "#6d28d9", border: "rgba(139,92,246,0.25)" },
    green: { bg: "rgba(16,185,129,0.12)", color: "#047857", border: "rgba(16,185,129,0.25)" },
    red: { bg: "rgba(239,68,68,0.12)", color: "#b91c1c", border: "rgba(239,68,68,0.25)" },
    muted: { bg: "rgba(0,0,0,0.05)", color: "var(--color-page-text-muted)", border: "transparent" },
  };
  const c = palette[tone];
  return (
    <span class="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium" style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {label}
    </span>
  );
}

function BotIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.6" />
      <path d="M12 4v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}

function HardDriveIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="22" y1="12" x2="2" y2="12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function ChevronRightSmall({ open }: { open?: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms ease" }}>
      <path d="m4.5 3 3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function PanelFrame(props: { eyebrow: string; title: string; children: preact.ComponentChildren }) {
  return (
    <div class="rounded-lg border" style={{ borderColor: "var(--color-page-border)", backgroundColor: "var(--color-page-surface)" }}>
      <div class="flex items-baseline justify-between border-b px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em]" style={{ borderColor: "var(--color-page-border)", color: "var(--color-page-text-muted)" }}>
        <span style={{ color: "var(--color-tg-accent)" }}>{props.eyebrow}</span>
        <span>{props.title}</span>
      </div>
      {props.children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Builders                                                                  */
/* -------------------------------------------------------------------------- */

const TONE_BY_INDEX: Tone[] = ["amber", "violet", "green", "amber", "violet"];
const RELATIVE_TIMES = ["Just now", "12m ago", "2h ago", "1d ago", "5d ago"];
const SYNC_TIMES = ["Just now", "2m ago", "14m ago", "1h ago", "8m ago"];

const SAMPLE_MEMBERS: Array<{ name: string; email: string }> = [
  { name: "Albert Lund", email: "albert@runway.io" },
  { name: "Jenna Roberts", email: "jenna@flatfile.com" },
  { name: "David Chen", email: "david@modal.dev" },
];

const KNOWN_BRANDS = new Set(["github", "gitlab", "hubspot", "salesforce", "pagerduty", "zendesk", "notion", "linear", "slack", "gmail", "stripe", "intercom", "jira", "datadog", "sentry", "shopify", "docusign", "quickbooks", "discourse", "exa"]);
const BRAND_NAME_OVERRIDES: Record<string, string> = {
  github: "GitHub", gitlab: "GitLab", hubspot: "HubSpot", salesforce: "Salesforce", pagerduty: "PagerDuty", zendesk: "Zendesk", notion: "Notion", linear: "Linear", slack: "Slack", gmail: "Gmail", postgres: "Postgres", datadog: "Datadog", sentry: "Sentry", stripe: "Stripe", intercom: "Intercom", jira: "Jira", shopify: "Shopify", docusign: "DocuSign", quickbooks: "QuickBooks", discourse: "Discourse", exa: "Exa",
};

function brandName(slug: string): string {
  const lower = slug.toLowerCase();
  return BRAND_NAME_OVERRIDES[lower] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

function brandKey(name: string): string | null {
  const k = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return null;
  if (KNOWN_BRANDS.has(k)) return k;
  for (const key of KNOWN_BRANDS) {
    if (k.startsWith(key) || k.includes(key)) return key;
  }
  return null;
}

function stripLabelPrefix(label: string): string {
  const m = label.match(/^[A-Za-z][A-Za-z ]*?:\s*(.*)$/);
  return m ? m[1] : label;
}

type RecordRow = {
  id: string;
  name: string;
  summary: string;
  type: string;
  typeTone: Tone;
  tag: string;
  tagTone: Tone;
  updated: string;
};

function buildRecordRows(useCase: LandingUseCaseDefinition): RecordRow[] {
  const children = useCase.memory.recordTree.children ?? [];
  return children.slice(0, 4).map((child, i) => ({
    id: child.id,
    name: stripLabelPrefix(child.label),
    summary: child.summary,
    type: child.kind,
    typeTone: TONE_BY_INDEX[i % TONE_BY_INDEX.length],
    tag: child.chips?.[0] ?? "memory",
    tagTone: TONE_BY_INDEX[(i + 2) % TONE_BY_INDEX.length],
    updated: RELATIVE_TIMES[i % RELATIVE_TIMES.length],
  }));
}

type ConnectorConnection = {
  member: string;
  email: string;
  account: string;
  lastSync: string;
  status: "Active" | "Idle";
};

type ConnectorRow = {
  id: string;
  name: string;
  description: string;
  status: "Connected" | "Available";
  connections: ConnectorConnection[];
};

function synthAccount(name: string, label: string): string {
  const slug = name.split(" ")[0]?.toLowerCase() ?? "user";
  const lower = label.toLowerCase();
  if (lower.includes("github")) return `@${slug}`;
  if (lower.includes("slack") || lower.includes("teams")) return "lobu-prod.workspace";
  if (lower.includes("linear")) return "lobu workspace";
  if (lower.includes("gmail")) return `${slug}@example.com`;
  if (lower.includes("drive")) return `${slug} · Drive`;
  if (lower.includes("stripe") || lower.includes("quickbook")) return `${slug}-acct-001`;
  if (lower.includes("shopify")) return `${slug}.myshopify.com`;
  if (lower.includes("salesforce") || lower.includes("hubspot")) return "lobu-prod.salesforce.com";
  if (lower.includes("docusign")) return `${slug}@lobu`;
  if (lower.includes("discourse")) return "forum.lobu.ai";
  if (lower.includes("exa")) return "exa-search-v1";
  return `${slug}@lobu`;
}

function buildSampleConnections(label: string, count: number): ConnectorConnection[] {
  return SAMPLE_MEMBERS.slice(0, count).map((m, i) => ({
    member: m.name,
    email: m.email,
    account: synthAccount(m.name, label),
    lastSync: SYNC_TIMES[i % SYNC_TIMES.length],
    status: i === 2 ? "Idle" : "Active",
  }));
}

function buildConnectors(useCase: LandingUseCaseDefinition): ConnectorRow[] {
  const connectStep = useCase.memory.howItWorks.find((s) => s.id === "connect");
  const chips = connectStep?.chips ?? [];
  const domains = useCase.skills.allowedDomains ?? [];
  const fromChips = chips.map((label, i) => {
    const connections = i < 2 ? buildSampleConnections(label, i === 0 ? 3 : 2) : [];
    return {
      id: `chip-${i}`,
      name: label,
      description: `${label} integration`,
      status: (connections.length > 0 ? "Connected" : "Available") as ConnectorRow["status"],
      connections,
    };
  });
  const fromDomains = domains
    .map((domain, i) => {
      const host = domain.replace(/^\*\.|^api\.|^\./, "");
      const slug = host.split(".")[0];
      return { id: `domain-${i}`, slug, name: brandName(slug), description: host, status: "Connected" as const, connections: buildSampleConnections(slug, 1) };
    })
    .filter((d) => d.slug.length > 0)
    .slice(0, 2);
  const seen = new Set<string>();
  return [...fromChips, ...fromDomains]
    .filter((c) => {
      const key = brandKey(c.name) ?? c.name.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
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
    { name: watcher.name, entity: primary, agent: agentLabel, status: "Active", schedule: watcher.schedule, last: "Just now" },
    { name: `${second} change tracker`, entity: second, agent: agentLabel, status: "Active", schedule: "every 30m", last: "12m ago" },
    { name: `${primary} digest`, entity: primary, agent: agentLabel, status: "Inactive", schedule: "*/15 * * * *", last: "—" },
  ];
}

type AgentRow = {
  name: string;
  entryPoint: string;
  skills: string[];
  status: "Active" | "Paused";
  last: string;
};

const ENTRY_POINT_OPTIONS = ["Slack", "Telegram", "MCP", "HTTP"];
const FALLBACK_AGENT_SKILLS: Record<string, string[]> = {
  legal: ["contract-review", "clause-risk", "legal-memory"],
  finance: ["reconciliation", "stripe", "close-review"],
  sales: ["account-research", "crm-sync", "renewal-risk"],
  delivery: ["fulfilment", "shipment-watch", "ticket-triage"],
  leadership: ["decision-brief", "risk-summary", "follow-ups"],
  "agent-community": ["member-intros", "event-digest", "moderation"],
  ecommerce: ["refund-watch", "order-summary", "support-replies"],
  market: ["deal-research", "founder-signals", "portfolio-news"],
};

function buildAgentRows(useCase: LandingUseCaseDefinition): AgentRow[] {
  const skills = useCase.skills.skills.length ? useCase.skills.skills : (FALLBACK_AGENT_SKILLS[useCase.id] ?? [useCase.skills.skillId, "memory-sync", "source-monitor"]);
  const baseAgent = useCase.skills.agentId ?? `${useCase.id}-agent`;
  const watcherName = useCase.memory.watcher.name;
  return [
    { name: baseAgent, entryPoint: ENTRY_POINT_OPTIONS[0], skills: skills.slice(0, 2), status: "Active", last: "Just now" },
    { name: watcherName, entryPoint: ENTRY_POINT_OPTIONS[1], skills: skills.slice(2, 4), status: "Active", last: "14m ago" },
    { name: `${useCase.label.toLowerCase()} digest`, entryPoint: ENTRY_POINT_OPTIONS[2], skills: skills.slice(0, 1), status: "Paused", last: "—" },
  ];
}

/* -------------------------------------------------------------------------- */
/*  MemoryPanel — entity chips + record rows                                  */
/* -------------------------------------------------------------------------- */

export function MemoryPanel({ useCase }: { useCase: LandingUseCaseDefinition }) {
  const rows = buildRecordRows(useCase);
  const entities = useCase.model.entities.slice(0, 5);
  const cols = "1.3fr 2fr 0.9fr 0.8fr";
  return (
    <PanelFrame eyebrow={`${useCase.label} memory`} title={`/memory/${useCase.memory.recordTree.kind.toLowerCase()}`}>
      <div class="flex flex-wrap items-center gap-1.5 px-3 py-2.5" style={{ borderBottom: "1px solid var(--color-page-border)" }}>
        <span class="font-mono text-[10.5px] uppercase tracking-[0.1em]" style={{ color: "var(--color-page-text-muted)" }}>entities</span>
        {entities.map((label, i) => (
          <span key={label} class="rounded px-2 py-0.5 text-[11.5px]" style={{ background: i === 0 ? "var(--color-page-surface-dim)" : "transparent", color: i === 0 ? "var(--color-page-text)" : "var(--color-page-text-muted)", border: "1px solid var(--color-page-border)" }}>{label}</span>
        ))}
      </div>
      <div class="grid items-center px-3 py-2 text-[11px] font-medium uppercase tracking-wider" style={{ gridTemplateColumns: cols, color: "var(--color-page-text-muted)", borderBottom: "1px solid var(--color-page-border)" }}>
        <span>Record</span>
        <span>Summary</span>
        <span>Tag</span>
        <span class="text-right">Updated</span>
      </div>
      {rows.map((row, i) => (
        <div key={row.id} class="grid items-center px-3 py-2.5 text-[13px]" style={{ gridTemplateColumns: cols, color: "var(--color-page-text)", borderBottom: i === rows.length - 1 ? undefined : "1px solid var(--color-page-border)" }}>
          <span class="flex min-w-0 items-center gap-2 font-medium">
            <span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]" style={{ background: "var(--color-page-surface-dim)", color: "var(--color-page-text-muted)" }} aria-hidden="true">
              {row.name.charAt(0).toUpperCase()}
            </span>
            <span class="truncate">{row.name}</span>
          </span>
          <span class="truncate text-[12px]" style={{ color: "var(--color-page-text-muted)" }} title={row.summary}>{row.summary}</span>
          <span><Badge label={row.tag} tone={row.tagTone} /></span>
          <span class="text-right tabular-nums text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>{row.updated}</span>
        </div>
      ))}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------------------- */
/*  ConnectorsPanel — collapsible per-connector rows with sample connections  */
/* -------------------------------------------------------------------------- */

export function ConnectorsPanel({ useCase }: { useCase: LandingUseCaseDefinition }) {
  const connectors = buildConnectors(useCase);
  const firstWith = connectors.find((c) => c.connections.length > 0);
  const [openId, setOpenId] = useState<string | null>(firstWith?.id ?? null);
  const cols = "1.6fr 0.9fr 1fr 0.7fr";
  return (
    <PanelFrame eyebrow={`${useCase.label} connectors`} title="/connections">
      <div class="grid px-3 py-2 text-[11px] font-medium uppercase tracking-wider" style={{ gridTemplateColumns: cols, color: "var(--color-page-text-muted)", borderBottom: "1px solid var(--color-page-border)" }}>
        <span>Connector</span>
        <span>Run on</span>
        <span>Last sync</span>
        <span class="text-right">Status</span>
      </div>
      {connectors.map((c, i) => {
        const open = openId === c.id;
        const isLast = i === connectors.length - 1;
        const hasConn = c.connections.length > 0;
        const runOn = hasConn ? ["Any device", "Burak's MacBook", "ops-runner-01"][i % 3] : "—";
        const lastSync = hasConn ? c.connections[0].lastSync : "—";
        return (
          <div key={c.id} style={{ borderBottom: isLast ? undefined : "1px solid var(--color-page-border)" }}>
            <button type="button" onClick={() => setOpenId(open ? null : c.id)} class="grid w-full items-center px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[color:var(--color-page-surface-dim)]" style={{ gridTemplateColumns: cols, color: "var(--color-page-text)", cursor: "pointer" }}>
              <span class="flex min-w-0 items-center gap-2 font-medium">
                <span style={{ color: "var(--color-page-text-muted)" }}><ChevronRightSmall open={open} /></span>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate">{c.name}</span>
                  {hasConn ? <span class="truncate text-[11px]" style={{ color: "var(--color-page-text-muted)" }}>{c.connections.length} connection{c.connections.length === 1 ? "" : "s"}</span> : null}
                </span>
              </span>
              <span class="flex items-center gap-1.5 truncate text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>
                <HardDriveIcon size={11} />
                <span class="truncate">{runOn}</span>
              </span>
              <span class="truncate tabular-nums text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>{lastSync}</span>
              <span class="flex justify-end">
                {hasConn ? <Badge label="Connected" tone="green" /> : <Badge label="Available" tone="muted" />}
              </span>
            </button>
            {open && hasConn ? <ConnectionsRows rows={c.connections} /> : null}
          </div>
        );
      })}
    </PanelFrame>
  );
}

function ConnectionsRows({ rows }: { rows: ConnectorConnection[] }) {
  const cols = "1.4fr 1.6fr 1.4fr 0.7fr";
  return (
    <div style={{ background: "var(--color-page-surface-dim)", borderTop: "1px solid var(--color-page-border)" }}>
      <div class="grid py-1.5 pr-3 pl-12 text-[10px] font-medium uppercase tracking-wider" style={{ gridTemplateColumns: cols, color: "var(--color-page-text-muted)" }}>
        <span>Member</span>
        <span>Connected account</span>
        <span>Last sync</span>
        <span class="text-right">Status</span>
      </div>
      {rows.map((row) => (
        <div key={`${row.email}-${row.account}`} class="grid items-center py-2 pr-3 pl-12 text-[12px]" style={{ gridTemplateColumns: cols, color: "var(--color-page-text)", borderTop: "1px solid var(--color-page-border)" }}>
          <span class="flex items-center gap-2 truncate font-medium">
            <span class="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px]" style={{ background: "var(--color-page-surface)", color: "var(--color-page-text-muted)" }} aria-hidden="true">{row.member.charAt(0)}</span>
            <span class="truncate">{row.member}</span>
          </span>
          <span class="truncate font-mono text-[11px]" style={{ color: "var(--color-page-text)" }}>{row.account}</span>
          <span class="tabular-nums text-[11px]" style={{ color: "var(--color-page-text-muted)" }}>{row.lastSync}</span>
          <span class="flex justify-end"><Badge label={row.status} tone={row.status === "Active" ? "green" : "muted"} /></span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  WatchersPanel                                                             */
/* -------------------------------------------------------------------------- */

export function WatchersPanel({ useCase }: { useCase: LandingUseCaseDefinition }) {
  const rows = buildWatcherRows(useCase);
  const cols = "1.7fr 0.9fr 0.7fr 1fr 0.7fr";
  return (
    <PanelFrame eyebrow={`${useCase.label} watchers`} title="/watchers">
      <div class="grid px-3 py-2 text-[11px] font-medium uppercase tracking-wider" style={{ gridTemplateColumns: cols, color: "var(--color-page-text-muted)", borderBottom: "1px solid var(--color-page-border)" }}>
        <span>Name</span>
        <span>Entity</span>
        <span>Status</span>
        <span>Schedule</span>
        <span class="text-right">Last run</span>
      </div>
      {rows.map((row, i) => (
        <div key={row.name} class="grid items-center px-3 py-2.5 text-[13px]" style={{ gridTemplateColumns: cols, color: "var(--color-page-text)", borderBottom: i === rows.length - 1 ? undefined : "1px solid var(--color-page-border)" }}>
          <span class="flex items-center gap-2 truncate font-medium">
            <span class="inline-block h-1.5 w-1.5 rounded-full" style={{ background: row.status === "Active" ? "rgb(16,185,129)" : "rgba(0,0,0,0.2)" }} aria-hidden="true" />
            <span class="truncate">{row.name}</span>
          </span>
          <span class="truncate" style={{ color: "var(--color-page-text-muted)" }}>{row.entity}</span>
          <span><Badge label={row.status} tone={row.status === "Active" ? "green" : "muted"} /></span>
          <span class="truncate font-mono text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>{row.schedule}</span>
          <span class="text-right tabular-nums text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>{row.last}</span>
        </div>
      ))}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------------------- */
/*  AgentsPanel                                                               */
/* -------------------------------------------------------------------------- */

export function AgentsPanel({ useCase }: { useCase: LandingUseCaseDefinition }) {
  const rows = buildAgentRows(useCase);
  const cols = "1.6fr 0.9fr 1.6fr 0.7fr 0.7fr";
  return (
    <PanelFrame eyebrow={`${useCase.label} agents`} title="/agents">
      <div class="grid px-3 py-2 text-[11px] font-medium uppercase tracking-wider" style={{ gridTemplateColumns: cols, color: "var(--color-page-text-muted)", borderBottom: "1px solid var(--color-page-border)" }}>
        <span>Agent</span>
        <span>Channel</span>
        <span>Skills</span>
        <span>Status</span>
        <span class="text-right">Last run</span>
      </div>
      {rows.map((row, i) => (
        <div key={row.name} class="grid items-center px-3 py-2.5 text-[13px]" style={{ gridTemplateColumns: cols, color: "var(--color-page-text)", borderBottom: i === rows.length - 1 ? undefined : "1px solid var(--color-page-border)" }}>
          <span class="flex items-center gap-2 truncate font-medium">
            <span style={{ color: "var(--color-page-text-muted)" }}><BotIcon size={12} /></span>
            <span class="truncate">{row.name}</span>
          </span>
          <span class="truncate text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>{row.entryPoint}</span>
          <span class="flex flex-wrap items-center gap-1">
            {row.skills.length === 0 ? <span style={{ color: "var(--color-page-text-muted)" }}>—</span> : row.skills.map((s) => <Badge key={s} label={s} tone="muted" />)}
          </span>
          <span><Badge label={row.status} tone={row.status === "Active" ? "green" : "muted"} /></span>
          <span class="text-right tabular-nums text-[12px]" style={{ color: "var(--color-page-text-muted)" }}>{row.last}</span>
        </div>
      ))}
    </PanelFrame>
  );
}
