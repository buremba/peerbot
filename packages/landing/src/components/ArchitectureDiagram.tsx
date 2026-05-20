// biome-ignore-all format: stays compact for the landing-page panel
import { messagingChannels } from "./platforms";

/**
 * Architecture diagram — layered stream story (NOT cycling pairs).
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
/*  Connector brand glyphs (simpleicons-style paths, MIT)                     */
/* -------------------------------------------------------------------------- */

type Brand = { key: string; label: string; path: string };

const CONNECTOR_BRANDS: Brand[] = [
  {
    key: "github",
    label: "GitHub",
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  {
    key: "linear",
    label: "Linear",
    path: "M.403 13.795A12.131 12.131 0 0 0 10.203 23.6L.403 13.795zM.182 10.103l13.715 13.714a12.18 12.18 0 0 0 3.137-1.21L1.392 6.966a12.18 12.18 0 0 0-1.21 3.137zm3.135-5.836a12.16 12.16 0 0 1 1.51-1.84L21.572 19.17a12.137 12.137 0 0 1-1.84 1.51L3.317 4.267zM6.682 1.43A12.12 12.12 0 0 1 12 0c6.626 0 12 5.374 12 12 0 1.872-.428 3.643-1.193 5.22L6.682 1.43Z",
  },
  {
    key: "stripe",
    label: "Stripe",
    path: "M13.479 9.883c-1.626-.604-2.512-1.067-2.512-1.803 0-.622.511-.977 1.422-.977 1.668 0 3.379.642 4.558 1.22l.666-4.111c-.935-.446-2.847-1.177-5.49-1.177-1.87 0-3.425.489-4.536 1.401-1.155.954-1.757 2.334-1.757 4.005 0 3.027 1.847 4.328 4.855 5.42 1.937.696 2.587 1.192 2.587 1.954 0 .74-.629 1.158-1.77 1.158-1.396 0-3.741-.69-5.323-1.585L5.5 19.612c1.305.74 3.722 1.5 6.245 1.5 1.977 0 3.629-.464 4.752-1.358 1.262-.985 1.915-2.432 1.915-4.155 0-3.105-1.89-4.392-4.933-5.516z",
  },
  {
    key: "notion",
    label: "Notion",
    path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  },
  {
    key: "gmail",
    label: "Gmail",
    path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  },
  {
    key: "hubspot",
    label: "HubSpot",
    path: "M18.164 7.93V5.084a2.198 2.198 0 0 0 1.267-1.978v-.067A2.2 2.2 0 0 0 17.238.845h-.067a2.2 2.2 0 0 0-2.193 2.194v.067a2.198 2.198 0 0 0 1.267 1.978v2.846a6.215 6.215 0 0 0-2.964 1.305L5.42 3.183A2.482 2.482 0 1 0 .55 3.91c.005.351.085.696.235 1.013l7.736 6.018a6.226 6.226 0 0 0 .094 7.012l-2.354 2.353a2.014 2.014 0 0 0-.583-.092 2.025 2.025 0 1 0 2.024 2.025 2.015 2.015 0 0 0-.093-.584l2.328-2.329a6.243 6.243 0 1 0 8.232-9.396zm-.97 9.343a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4z",
  },
];

function ConnectorGlyph({ brand, size = 22 }: { brand: Brand; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={brand.label} role="img">
      <title>{brand.label}</title>
      <path d={brand.path} fill="var(--color-page-text)" />
    </svg>
  );
}

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
  // Eyebrow + heading + lede mirror Eyebrow / SectionHeading from
  // LandingPage.tsx so the architecture block reads as a peer to the
  // other landing sections rather than its own one-off treatment.
  return (
    <div class="flex flex-col">
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
        Stream events. Derive entities. Expose agents.
      </h2>
      <p
        class="mt-3 max-w-2xl text-[15px] leading-relaxed"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Connectors stream events into memory. Watchers derive typed entities. Agents read that memory or talk to users.
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
/*  Desktop board — three column layered story                                */
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
    <ColumnCard heading="Connectors" footer="event stream → memory">
      <div class="grid grid-cols-3 gap-2">
        {CONNECTOR_BRANDS.map((b) => (
          <div
            key={b.key}
            class="flex items-center justify-center rounded-lg border py-2.5"
            style={{
              borderColor: "var(--color-page-border)",
              backgroundColor: "var(--color-page-bg)",
            }}
          >
            <ConnectorGlyph brand={b} size={20} />
          </div>
        ))}
      </div>
      <SdkPill label="@lobu/connector-sdk" caption="write your own — TypeScript" />
    </ColumnCard>
  );
}

function MemoryColumn() {
  return (
    <ColumnCard heading="Memory" footer="append-only · typed entities">
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
    <ColumnCard heading="Agents" footer="expose to users · or read in code">
      <div class="flex flex-col gap-3">
        <SubBlock heading="Chat bots">
          <div class="grid grid-cols-3 gap-1.5">
            {messagingChannels.map((c) => (
              <div
                key={c.id}
                class="flex items-center justify-center rounded-lg border py-2"
                style={{
                  borderColor: "var(--color-page-border)",
                  backgroundColor: "var(--color-page-bg)",
                  color: "var(--color-page-text)",
                }}
                role="img"
                aria-label={c.label}
              >
                {c.renderIcon(18)}
              </div>
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
          <div
            class="mt-1 text-[11.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            read memory programmatically
          </div>
          <SdkPill label="reactions" caption="automate actions — from @lobu/connector-sdk" />
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

function SdkPill({ label, caption }: { label: string; caption: string }) {
  return (
    <div class="mt-1 flex flex-col gap-1">
      <span
        class="inline-flex items-center self-start rounded-lg border px-2 py-1 font-mono text-[11px]"
        style={{
          borderColor: "var(--color-page-border)",
          backgroundColor: "var(--color-page-surface-dim)",
          color: "var(--color-page-text)",
        }}
      >
        {label}
      </span>
      <span
        class="text-[11.5px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {caption}
      </span>
    </div>
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
 * Entities widget — small table grid. Header row + 3 placeholder rows
 * to signal "structured records, not freeform text". Cells use neutral
 * monospace dashes/blocks so the table reads as a schema preview rather
 * than fake data. Sits in the same box family as StreamBox.
 */
function EntitiesTable() {
  const HEADERS = ["name", "type", "updated"] as const;
  // Placeholder rows — labelled generically so the widget reads as a
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
        cron · LLM
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
