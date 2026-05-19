import { messagingChannels } from "./platforms";

/**
 * Lightweight three-box architecture diagram for the dev-focused landing
 * page. Mirrors the mockup's monospace pattern (external platforms ↔ Lobu
 * control plane + worker fleet ↔ company context / memory) while keeping the
 * existing warm Lobu palette. Replaces the older multi-card / feature-pill
 * variant — the rest of the page covers each surface in depth.
 */
export function ArchitectureDiagram() {
  return (
    <div
      class="rounded-lg border bg-[var(--color-page-surface)]/60 p-5 sm:p-8"
      style={{ borderColor: "var(--color-page-border)" }}
    >
      <div class="flex flex-col items-stretch gap-4 md:grid md:grid-cols-[1fr_auto_1.1fr_auto_1fr] md:items-center md:gap-2">
        <ExternalPlatformsBox />
        <ArrowLabel top="OAuth" bottom="Events" />
        <LobuBox />
        <ArrowLabel top="Tools" bottom="Syncs" />
        <MemoryBox />
      </div>
    </div>
  );
}

function BoxFrame(props: {
  eyebrow: string;
  title: string;
  children?: preact.ComponentChildren;
}) {
  return (
    <div
      class="rounded-lg border bg-[var(--color-page-bg)] p-4 font-mono text-[12.5px] leading-[1.6]"
      style={{ borderColor: "var(--color-page-border)" }}
    >
      <div
        class="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--color-tg-accent)" }}
      >
        {props.eyebrow}
      </div>
      <div
        class="mb-3 font-sans text-sm font-semibold tracking-tight"
        style={{ color: "var(--color-page-text)" }}
      >
        {props.title}
      </div>
      <div style={{ color: "var(--color-page-text-muted)" }}>
        {props.children}
      </div>
    </div>
  );
}

function ExternalPlatformsBox() {
  return (
    <BoxFrame eyebrow="External" title="Chat + data platforms">
      <ul class="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {messagingChannels.slice(0, 6).map((channel) => (
          <li key={channel.id} class="flex items-center gap-2">
            <span
              aria-hidden="true"
              class="inline-flex h-4 w-4 items-center justify-center"
            >
              {channel.renderIcon(14)}
            </span>
            <span>{channel.label}</span>
          </li>
        ))}
      </ul>
      <div class="mt-3 text-[11.5px]">
        + GitHub, Linear, Stripe, Gmail, Notion…
      </div>
    </BoxFrame>
  );
}

function LobuBox() {
  return (
    <div
      class="rounded-lg border-2 p-5 font-mono text-[12.5px] leading-[1.6]"
      style={{
        borderColor: "var(--color-tg-accent)",
        backgroundColor: "var(--color-page-bg)",
      }}
    >
      <div
        class="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--color-tg-accent)" }}
      >
        Lobu
      </div>
      <div
        class="mb-3 font-sans text-base font-semibold tracking-tight"
        style={{ color: "var(--color-page-text)" }}
      >
        CLI · MCP · API · SDK
      </div>
      <div
        class="grid grid-cols-2 gap-2 text-[11.5px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        <SubBox label="Gateway" lines={["secret-proxy", "guardrails", "egress judge"]} />
        <SubBox
          label="Workers"
          lines={["per-user sandbox", "OpenClaw runtime", "MCP tools"]}
        />
      </div>
      <div
        class="mt-3 rounded-md px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: "var(--color-landing-callout-bg)",
          color: "var(--color-page-text)",
        }}
      >
        Postgres + pgvector — the only external dependency
      </div>
    </div>
  );
}

function SubBox(props: { label: string; lines: string[] }) {
  return (
    <div
      class="rounded-md border p-2"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface)",
      }}
    >
      <div class="mb-1 font-semibold" style={{ color: "var(--color-page-text)" }}>
        {props.label}
      </div>
      <ul class="space-y-0.5">
        {props.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function MemoryBox() {
  return (
    <BoxFrame eyebrow="Memory" title="Your company context">
      <ul class="space-y-1">
        <li>events (append-only)</li>
        <li>entities &amp; relationships</li>
        <li>watchers (reactive + cron)</li>
        <li>vectors (pgvector)</li>
        <li>multi-tenant by org / user</li>
      </ul>
    </BoxFrame>
  );
}

function ArrowLabel(props: { top: string; bottom: string }) {
  return (
    <div
      class="flex flex-col items-center justify-center font-mono text-[10.5px]"
      style={{ color: "var(--color-page-text-muted)" }}
    >
      <span>{props.top}</span>
      <span aria-hidden="true" class="my-1 hidden md:block">
        ←→
      </span>
      <span aria-hidden="true" class="my-1 block md:hidden">
        ↓↑
      </span>
      <span>{props.bottom}</span>
    </div>
  );
}
