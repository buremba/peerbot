import { messagingChannels } from "./platforms";

/**
 * Lightweight three-box architecture diagram for the dev-focused landing
 * page. Three flat boxes joined by thin arrow labels:
 *
 *   external platforms  ←→  lobu  ←→  knowledge graph
 *
 * All boxes share the same surface, border, and radius — no shadows, no
 * gradients, no badges. Labels are all lowercase monospace.
 */
export function ArchitectureDiagram() {
  return (
    <div class="flex flex-col items-stretch gap-3 md:grid md:grid-cols-[1fr_auto_1.1fr_auto_1fr] md:items-stretch md:gap-3">
      <Box title="external platforms">
        <PlatformList />
      </Box>
      <Arrow top="oauth" bottom="events" />
      <Box title="lobu" emphasised>
        <LobuContents />
      </Box>
      <Arrow top="tools" bottom="syncs" />
      <Box title="knowledge graph">
        <ul class="space-y-1">
          <li>events (append-only)</li>
          <li>entities &amp; relationships</li>
          <li>watchers (reactive + cron)</li>
          <li>vectors (pgvector)</li>
          <li>multi-tenant by org / user</li>
        </ul>
      </Box>
    </div>
  );
}

function Box(props: {
  title: string;
  emphasised?: boolean;
  children: preact.ComponentChildren;
}) {
  return (
    <div
      class="rounded-lg border p-5 font-mono text-[12.5px] leading-[1.65]"
      style={{
        borderColor: props.emphasised
          ? "var(--color-page-text)"
          : "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface)",
        color: "var(--color-page-text-muted)",
      }}
    >
      <div
        class="mb-3 text-[11.5px] uppercase tracking-[0.12em]"
        style={{ color: "var(--color-page-text)" }}
      >
        {props.title}
      </div>
      {props.children}
    </div>
  );
}

function PlatformList() {
  return (
    <>
      <ul class="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {messagingChannels.slice(0, 6).map((channel) => (
          <li key={channel.id} class="flex items-center gap-2">
            <span
              aria-hidden="true"
              class="inline-flex h-3.5 w-3.5 items-center justify-center"
            >
              {channel.renderIcon(12)}
            </span>
            <span>{channel.label.toLowerCase()}</span>
          </li>
        ))}
      </ul>
      <div class="mt-3 text-[11.5px]">
        + github, linear, stripe, gmail, notion…
      </div>
    </>
  );
}

function LobuContents() {
  return (
    <>
      <div
        class="mb-3 text-[13px]"
        style={{ color: "var(--color-page-text)" }}
      >
        cli · mcp · api · sdk
      </div>
      <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
        <div>
          <div
            class="mb-1 uppercase tracking-[0.08em]"
            style={{ color: "var(--color-page-text)" }}
          >
            gateway
          </div>
          <ul class="space-y-0.5">
            <li>secret-proxy</li>
            <li>guardrails</li>
            <li>egress judge</li>
          </ul>
        </div>
        <div>
          <div
            class="mb-1 uppercase tracking-[0.08em]"
            style={{ color: "var(--color-page-text)" }}
          >
            workers
          </div>
          <ul class="space-y-0.5">
            <li>per-user sandbox</li>
            <li>openclaw runtime</li>
            <li>mcp tools</li>
          </ul>
        </div>
      </div>
      <div
        class="mt-4 border-t pt-3 text-[11.5px]"
        style={{ borderColor: "var(--color-page-border)" }}
      >
        postgres + pgvector — the only external dependency
      </div>
    </>
  );
}

function Arrow(props: { top: string; bottom: string }) {
  return (
    <div
      class="flex flex-col items-center justify-center font-mono text-[10.5px] lowercase"
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
