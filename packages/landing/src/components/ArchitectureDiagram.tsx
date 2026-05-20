// biome-ignore-all format: stays compact for the landing-page panel
import { messagingChannels } from "./platforms";

/**
 * Architecture diagram: layered stream story (NOT cycling pairs).
 *
 *   ┌────────────┐         ┌────────────┐         ┌────────────┐
 *   │ Connectors │ events  │   Memory   │  chat   │   Agents   │
 *   │   (logos)  │ ──────► │  events    │ ──────► │  chat bots │
 *   │ sdk pill   │         │  ↓ cron·LLM│  read   │  other     │
 *   │            │         │  entities  │ ──────► │  agents    │
 *   │            │         │  (table)   │         │  sdk pill  │
 *   └────────────┘         └────────────┘         └────────────┘
 *
 * Continuous stream pulse in the `events` box telegraphs "live stream";
 * the entities widget renders as a small table grid to signal structured
 * data rather than a freeform blob.
 * Honors prefers-reduced-motion (drops animations entirely).
 */

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function ArchitectureDiagram() {
  return (
    <div class="flex flex-col gap-6">
      <Header />
      <DiagramBoard />
      <PulseStyles />
    </div>
  );
}

function Header() {
  // Centered header: the architecture board below is the one full-width,
  // symmetric showcase on the page, so a centered eyebrow/heading/lede reads
  // as intentional (and echoes the hero) rather than drifting left over it.
  return (
    <div class="flex flex-col items-center text-center">
      <div
        class="mb-3 font-mono text-[11.5px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--color-tg-accent)" }}
      >
        Architecture
      </div>
      <h2
        class="font-display text-[1.85rem] font-bold leading-[1.1] tracking-tight sm:text-[2.25rem]"
        style={{ color: "var(--color-page-text)" }}
      >
        Events in. Entities out. Agents on top.
      </h2>
      <p
        class="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Connectors stream events into memory. Watchers derive typed entities. Agents read it, talk to users, and act.
      </p>
    </div>
  );
}

function DiagramBoard() {
  return (
    <div
      class="relative rounded-lg border p-6 sm:p-8"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface)",
        boxShadow: "0 1px 0 0 var(--color-page-border)",
      }}
    >
      <div class="hidden lg:block">
        <DesktopBoard />
      </div>
      <div class="block lg:hidden">
        <MobileBoard />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Desktop board: three column layered story                                 */
/* -------------------------------------------------------------------------- */

function DesktopBoard() {
  return (
    <div class="grid grid-cols-[1fr_auto_1.1fr_auto_1.1fr] items-stretch gap-x-2">
      <ConnectorsColumn />
      <ColumnArrow label="events" />
      <MemoryColumn />
      <ColumnArrow label="chat" sublabel="read" split />
      <AgentsColumn />
    </div>
  );
}

function MobileBoard() {
  return (
    <div class="flex flex-col gap-4">
      <ConnectorsColumn />
      <VerticalArrow label="events" />
      <MemoryColumn />
      <VerticalArrow label="chat · read" />
      <AgentsColumn />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Columns                                                                   */
/* -------------------------------------------------------------------------- */

function ConnectorsColumn() {
  return (
    <ColumnCard heading="Connectors" footer="stream events from any source">
      <div class="flex flex-col gap-2">
        <SourceRow
          label="50+ built-in connectors"
          href="https://github.com/lobu-ai/lobu/tree/main/packages/connectors/src"
        />
        <SourceRow label="any MCP server" href="/guides/mcp-proxy/" />
        <SourceRow
          label="custom via connector-sdk"
          href="/getting-started/connector-sdk/"
        />
      </div>
    </ColumnCard>
  );
}

function MemoryColumn() {
  return (
    <ColumnCard heading="Memory" footer="append-only knowledge graph">
      <div class="flex flex-col">
        <StreamBox label="events" />
        <DerivationArrow />
        <EntitiesTable />
      </div>
    </ColumnCard>
  );
}

function AgentsColumn() {
  return (
    <ColumnCard heading="Agents" footer="reach users, or call from code">
      <div class="flex flex-col gap-3">
        <SubBlock heading="Chat bots">
          <div class="grid grid-cols-3 gap-1.5">
            {messagingChannels.map((c) => (
              <a
                key={c.id}
                href={c.href}
                class="flex items-center justify-center rounded-lg border py-2 transition-colors hover:border-[color:var(--color-tg-accent)] hover:text-[color:var(--color-tg-accent)]"
                style={{
                  borderColor: "var(--color-page-border)",
                  backgroundColor: "var(--color-page-bg)",
                  color: "var(--color-page-text)",
                }}
                aria-label={`${c.label} docs`}
                title={c.label}
              >
                {c.renderIcon(18)}
              </a>
            ))}
          </div>
        </SubBlock>
        <SubBlock heading="Other agents">
          <div class="flex flex-wrap gap-1.5">
            {(["HTTP", "MCP", "SDK"] as const).map((p) => (
              <span
                key={p}
                class="rounded-lg border px-2 py-1 font-mono text-[11px]"
                style={{
                  borderColor: "var(--color-page-border)",
                  backgroundColor: "var(--color-page-bg)",
                  color: "var(--color-page-text)",
                }}
              >
                {p}
              </span>
            ))}
          </div>
        </SubBlock>
        <SubBlock heading="External services">
          <SourceRow label="reactions" href="/getting-started/reaction-sdk/" />
        </SubBlock>
      </div>
    </ColumnCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

function ColumnCard({
  heading,
  footer,
  children,
}: {
  heading: string;
  footer: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div
      class="flex flex-col gap-3 rounded-lg border p-4"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-bg)",
      }}
    >
      <div
        class="font-mono text-[10.5px] uppercase tracking-[0.18em]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {heading}
      </div>
      <div class="flex flex-1 flex-col gap-3">{children}</div>
      <div
        class="border-t pt-2 text-[11.5px]"
        style={{
          borderColor: "var(--color-page-border)",
          color: "var(--color-page-text-muted)",
        }}
      >
        {footer}
      </div>
    </div>
  );
}

// Compact bordered row naming one input path (built-in connectors, MCP, the
// SDK). All three render identically; an href makes the row a link to the
// matching docs/source. The full logo wall lives in the Connectors section.
function SourceRow({ label, href }: { label: string; href?: string }) {
  const cls = "block rounded-lg border px-3 py-2 font-mono text-[12px]";
  const style = {
    borderColor: "var(--color-page-border)",
    backgroundColor: "var(--color-page-surface-dim)",
    color: "var(--color-page-text)",
  };
  if (!href) {
    return (
      <div class={cls} style={style}>
        {label}
      </div>
    );
  }
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      class={`${cls} transition-colors hover:border-[color:var(--color-tg-accent)] hover:text-[color:var(--color-tg-accent)]`}
      style={style}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {label}
    </a>
  );
}


function SubBlock({
  heading,
  children,
}: {
  heading: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <div
        class="font-mono text-[10.5px] uppercase tracking-[0.14em]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {heading}
      </div>
      {children}
    </div>
  );
}

/**
 * Two stream boxes (events / entities). Pulse dots live inside as
 * absolutely-positioned spans driven by pure CSS keyframes. The keyframes
 * are gated by `@media (prefers-reduced-motion: reduce)` so reduced-motion
 * sessions see a static frame.
 */
function StreamBox({ label }: { label: string }) {
  return (
    <div
      class="relative flex items-center overflow-hidden rounded-lg border px-3 py-2.5"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface-dim)",
      }}
    >
      <span
        class="font-mono text-[12px]"
        style={{ color: "var(--color-page-text)" }}
      >
        {label}
      </span>
      <span class="ml-auto inline-flex items-center gap-1.5">
        <span class="lobu-pulse-dot lobu-pulse-dot--a" aria-hidden="true" />
        <span class="lobu-pulse-dot lobu-pulse-dot--b" aria-hidden="true" />
        <span class="lobu-pulse-dot lobu-pulse-dot--c" aria-hidden="true" />
      </span>
    </div>
  );
}

/**
 * Entities widget: small table grid. Header row + 3 placeholder rows
 * to signal "structured records, not freeform text". Cells use neutral
 * monospace dashes/blocks so the table reads as a schema preview rather
 * than fake data. Sits in the same box family as StreamBox.
 */
function EntitiesTable() {
  const HEADERS = ["name", "type", "updated"] as const;
  // Placeholder rows, labelled generically so the widget reads as a
  // schema preview, not a snapshot of a real customer's data.
  const ROWS: ReadonlyArray<readonly [string, string, string]> = [
    ["Customer A", "company", "2d"],
    ["Customer B", "person", "5h"],
    ["Customer C", "meeting", "1h"],
  ];
  return (
    <div
      class="relative overflow-hidden rounded-lg border"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface-dim)",
      }}
    >
      <div
        class="flex items-center justify-between border-b px-3 py-1.5"
        style={{ borderColor: "var(--color-page-border)" }}
      >
        <span
          class="font-mono text-[12px]"
          style={{ color: "var(--color-page-text)" }}
        >
          entities
        </span>
        <span
          class="font-mono text-[10px] uppercase tracking-[0.14em]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          table
        </span>
      </div>
      <div class="px-2 py-1.5">
        <div
          class="grid grid-cols-3 gap-x-2 px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.1em]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {HEADERS.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        <div class="flex flex-col">
          {ROWS.map((row, idx) => (
            <div
              key={row[0]}
              class="grid grid-cols-3 gap-x-2 px-1 py-1 font-mono text-[10.5px]"
              style={{
                color: "var(--color-page-text)",
                borderTop:
                  idx === 0 ? undefined : "1px solid var(--color-page-border)",
              }}
            >
              {row.map((cell, i) => (
                <span
                  key={`${row[0]}-${i}`}
                  style={{
                    color:
                      i === row.length - 1
                        ? "var(--color-page-text-muted)"
                        : "var(--color-page-text)",
                  }}
                >
                  {cell}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DerivationArrow() {
  return (
    <div class="flex items-center justify-between gap-2 py-1.5 pl-3">
      <svg width="10" height="20" viewBox="0 0 10 20" aria-hidden="true">
        <title>derive</title>
        <path
          d="M5 0 V14 M2 11 L5 15 L8 11"
          stroke="var(--color-tg-accent)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
      <span
        class="ml-auto rounded-lg px-2 py-0.5 font-mono text-[10.5px]"
        style={{
          backgroundColor: "var(--color-page-bg)",
          color: "var(--color-page-text-muted)",
          border: "1px solid var(--color-page-border)",
        }}
      >
        LLM watcher
      </span>
    </div>
  );
}

/**
 * Inline horizontal arrow between desktop columns. With `split` the arrow
 * branches into two labelled stubs (top: `chat`, bottom: `read`) for the
 * watcher → agents transition.
 */
function ColumnArrow({
  label,
  sublabel,
  split = false,
}: {
  label: string;
  sublabel?: string;
  split?: boolean;
}) {
  if (split) {
    return (
      <div class="flex flex-col items-center justify-center gap-3 px-2">
        <div class="flex items-center gap-1.5">
          <span
            class="font-mono text-[10.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {label}
          </span>
          <Arrow />
        </div>
        <div class="flex items-center gap-1.5">
          <span
            class="font-mono text-[10.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {sublabel}
          </span>
          <Arrow />
        </div>
      </div>
    );
  }
  return (
    <div class="flex flex-col items-center justify-center gap-1 px-2">
      <span
        class="font-mono text-[10.5px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {label}
      </span>
      <Arrow />
    </div>
  );
}

function Arrow() {
  return (
    <svg width="36" height="10" viewBox="0 0 36 10" aria-hidden="true">
      <title>flow</title>
      <path
        d="M0 5 H30 M26 2 L30 5 L26 8"
        stroke="var(--color-tg-accent)"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  );
}

function VerticalArrow({ label }: { label: string }) {
  return (
    <div class="flex flex-col items-center justify-center gap-1" aria-hidden="true">
      <span
        class="font-mono text-[10.5px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {label}
      </span>
      <svg width="12" height="22" viewBox="0 0 12 22">
        <title>flow</title>
        <path
          d="M6 0 V16 M2.5 13 L6 17 L9.5 13"
          stroke="var(--color-tg-accent)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
    </div>
  );
}

/**
 * Pure-CSS pulse animation. Three small dots in the `events` box pulse on
 * a stagger to telegraph "live stream". Reduced motion drops the keyframes
 * and leaves the dots at a static rest opacity.
 */
function PulseStyles() {
  return (
    <style>{`
      .lobu-pulse-dot {
        width: 4px;
        height: 4px;
        border-radius: 9999px;
        background: var(--color-tg-accent);
        display: inline-block;
        opacity: 0.35;
      }
      @media (prefers-reduced-motion: no-preference) {
        .lobu-pulse-dot--a { animation: lobu-pulse 1.8s ease-in-out infinite; animation-delay: 0s; }
        .lobu-pulse-dot--b { animation: lobu-pulse 1.8s ease-in-out infinite; animation-delay: 0.3s; }
        .lobu-pulse-dot--c { animation: lobu-pulse 1.8s ease-in-out infinite; animation-delay: 0.6s; }
      }
      @keyframes lobu-pulse {
        0%, 100% { opacity: 0.2; transform: scale(0.9); }
        50%       { opacity: 1;   transform: scale(1.15); }
      }
    `}</style>
  );
}
