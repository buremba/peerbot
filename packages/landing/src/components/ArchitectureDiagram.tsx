// biome-ignore-all format: stays compact for the landing-page panel
import { messagingChannels } from "./platforms";

/**
 * Three-column architecture flow:
 *
 *   inputs (connector-sdk + brand logos)
 *     ── streaming event capture ──►
 *   knowledge graph (stacked layers + internal dreaming arrow + reactions out)
 *     ── agents read ──►
 *   agents (chat bots + api readers)
 *
 * Flat layers (not a metaphor cube), big column gaps, solid 1.5px arrows,
 * larger brand glyphs. A single hairline-bottom border on each column card
 * adds enough weight to feel like a real diagram without breaking the
 * flat-composition rule (no glow, no drop shadow, no gradient).
 */
export function ArchitectureDiagram() {
  return (
    <div class="flex flex-col gap-6 md:grid md:grid-cols-[1fr_3.5rem_1fr_3.5rem_1fr] md:items-stretch md:gap-0">
      <InputsColumn />
      <BetweenArrow label="streaming event capture" axis="lr" />
      <BetweenArrow label="streaming event capture" axis="tb" />
      <KnowledgeColumn />
      <BetweenArrow label="agents read" axis="lr" />
      <BetweenArrow label="agents read" axis="tb" />
      <AgentsColumn />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared frame                                                              */
/* -------------------------------------------------------------------------- */

function ColumnFrame(props: { title: string; children: preact.ComponentChildren; footer?: preact.ComponentChildren }) {
  return (
    <div
      class="flex h-full min-h-[420px] flex-col rounded-lg border p-6"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface)",
        // Single hairline below the card. Not a glow — just the bottom edge
        // gets a hair more weight to read as 'panel' instead of 'box'.
        boxShadow: "0 1px 0 0 var(--color-page-border)",
      }}
    >
      <div
        class="mb-5 font-mono text-[13px] font-semibold uppercase tracking-[0.16em]"
        style={{ color: "var(--color-page-text)" }}
      >
        {props.title}
      </div>
      <div class="flex flex-1 flex-col gap-3">{props.children}</div>
      {props.footer ? (
        <div
          class="mt-5 border-t pt-3 font-mono text-[11px]"
          style={{ borderColor: "var(--color-page-border)", color: "var(--color-page-text-muted)" }}
        >
          {props.footer}
        </div>
      ) : null}
    </div>
  );
}

function Pill({ label, dim = false }: { label: string; dim?: boolean }) {
  return (
    <span
      class="inline-flex items-center rounded-md border px-2.5 py-1 font-mono text-[12px]"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: dim ? "var(--color-page-bg)" : "var(--color-page-surface-dim)",
        color: "var(--color-page-text)",
      }}
    >
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Inputs column — connector-sdk + brand-logo grid                           */
/* -------------------------------------------------------------------------- */

type Brand = { key: string; label: string; color: string; path: string };

// Paths lifted from simpleicons.org (MIT-licensed brand registry shipped in
// the earlier HeroProductCard.tsx, kept here as a minimal 6-brand subset).
const CONNECTOR_BRANDS: Brand[] = [
  { key: "github", label: "GitHub", color: "var(--color-page-text)", path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.111.82-.261.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" },
  { key: "linear", label: "Linear", color: "#5E6AD2", path: "M.403 13.795A12.131 12.131 0 0 0 10.203 23.6L.403 13.795zM.182 10.103l13.715 13.714a12.18 12.18 0 0 0 3.137-1.21L1.392 6.966a12.18 12.18 0 0 0-1.21 3.137zm3.135-5.836a12.16 12.16 0 0 1 1.51-1.84L21.572 19.17a12.137 12.137 0 0 1-1.84 1.51L3.317 4.267zM6.682 1.43A12.12 12.12 0 0 1 12 0c6.626 0 12 5.374 12 12 0 1.872-.428 3.643-1.193 5.22L6.682 1.43Z" },
  { key: "stripe", label: "Stripe", color: "#635BFF", path: "M13.479 9.883c-1.626-.604-2.512-1.067-2.512-1.803 0-.622.511-.977 1.422-.977 1.668 0 3.379.642 4.558 1.22l.666-4.111c-.935-.446-2.847-1.177-5.49-1.177-1.87 0-3.425.489-4.536 1.401-1.155.954-1.757 2.334-1.757 4.005 0 3.027 1.847 4.328 4.855 5.42 1.937.696 2.587 1.192 2.587 1.954 0 .74-.629 1.158-1.77 1.158-1.396 0-3.741-.69-5.323-1.585L5.5 19.612c1.305.74 3.722 1.5 6.245 1.5 1.977 0 3.629-.464 4.752-1.358 1.262-.985 1.915-2.432 1.915-4.155 0-3.105-1.89-4.392-4.933-5.516z" },
  { key: "notion", label: "Notion", color: "var(--color-page-text)", path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933z" },
  { key: "gmail", label: "Gmail", color: "#EA4335", path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" },
  { key: "hubspot", label: "HubSpot", color: "#FF7A59", path: "M18.164 7.93V5.084a2.198 2.198 0 0 0 1.27-1.985v-.067A2.2 2.2 0 0 0 17.238.832h-.067a2.2 2.2 0 0 0-2.198 2.2v.067a2.196 2.196 0 0 0 1.27 1.985V7.93a6.226 6.226 0 0 0-2.957 1.296L5.512 3.917c.027-.103.045-.21.045-.319A1.717 1.717 0 1 0 4.598 4.91l7.69 5.99a6.255 6.255 0 0 0-.939 3.31c0 1.27.382 2.452 1.04 3.444l-2.341 2.34a2.005 2.005 0 0 0-.585-.097 2.05 2.05 0 1 0 2.052 2.05c0-.205-.039-.405-.094-.594l2.314-2.314a6.27 6.27 0 1 0 4.43-11.108zm-1.107 9.397a3.22 3.22 0 1 1 0-6.44 3.22 3.22 0 0 1 0 6.44z" },
];

function BrandGlyph({ brand, size = 26 }: { brand: Brand; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={brand.label} role="img">
      <title>{brand.label}</title>
      <path d={brand.path} fill={brand.color} />
    </svg>
  );
}

function InputsColumn() {
  return (
    <ColumnFrame title="Connectors" footer={<span>events stream into memory</span>}>
      <Pill label="@lobu/connector-sdk" />
      <div class="text-[12.5px]" style={{ color: "var(--color-page-text-muted)" }}>
        50+ bundled integrations
      </div>
      <div class="mt-3 grid grid-cols-3 gap-3">
        {CONNECTOR_BRANDS.map((b) => (
          <div
            key={b.key}
            class="flex h-14 items-center justify-center rounded-md border"
            style={{ borderColor: "var(--color-page-border)", backgroundColor: "var(--color-page-bg)" }}
          >
            <BrandGlyph brand={b} size={26} />
          </div>
        ))}
      </div>
    </ColumnFrame>
  );
}

/* -------------------------------------------------------------------------- */
/*  Middle column — flat stacked layers + internal dreaming arrow + reactions */
/* -------------------------------------------------------------------------- */

function Layer({ label, sub }: { label: string; sub?: string }) {
  return (
    <div
      class="flex items-center justify-between rounded-md border px-3 py-2.5"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-bg)",
      }}
    >
      <span class="font-mono text-[13px]" style={{ color: "var(--color-page-text)" }}>
        {label}
      </span>
      {sub ? (
        <span class="font-mono text-[10.5px]" style={{ color: "var(--color-page-text-muted)" }}>
          {sub}
        </span>
      ) : null}
    </div>
  );
}

function LayerConnector() {
  // Short vertical bar joining adjacent layers — visual continuity without
  // shouting 'arrow'. Lives between Layer rows.
  return (
    <div class="flex items-center justify-center" aria-hidden="true">
      <span
        class="block h-2 w-px"
        style={{ backgroundColor: "var(--color-page-border)" }}
      />
    </div>
  );
}

/**
 * Inline arrow that lives in the gap between events and entities, pointing
 * UP — the dreaming watcher (LLM, cron) is what lifts raw events into typed
 * entities. Replaces the LayerConnector hairline at that one spot so the
 * stack reads top-to-bottom as: relationships ← entities ← (dreaming) ← events.
 */
function DreamingConnector() {
  return (
    <div class="flex items-center gap-2 pl-3" aria-hidden="true">
      <svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true">
        <title>dreaming watcher lifts events into entities</title>
        <path
          d="M6 18 V4 M2 7 L6 3 L10 7"
          stroke="var(--color-tg-accent)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
      <div class="flex flex-col gap-0.5 font-mono text-[10.5px] leading-tight" style={{ color: "var(--color-page-text-muted)" }}>
        <span style={{ color: "var(--color-page-text)" }}>dreaming watchers</span>
        <span>cron · LLM</span>
      </div>
    </div>
  );
}

/**
 * Reactions arrow pointing OUT of the cube area toward the agents column.
 * Reactions are imperative TS that runs after a watcher extracts something
 * and takes external actions (post to Slack, open a Linear issue, …).
 */
function ReactionsCallout() {
  return (
    <div class="mt-3 flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--color-page-border)" }}>
      <div class="flex flex-col gap-0.5 font-mono text-[11px] leading-tight" style={{ color: "var(--color-page-text-muted)" }}>
        <span style={{ color: "var(--color-page-text)" }}>reactions</span>
        <span>your TS · @lobu/reaction-sdk</span>
      </div>
      <svg width="36" height="12" viewBox="0 0 36 12" aria-hidden="true">
        <title>reactions emit external actions</title>
        <path
          d="M0 6 H30 M27 2.5 L31 6 L27 9.5"
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

function KnowledgeColumn() {
  return (
    <ColumnFrame title="Memory">
      <Layer label="relationships" sub="entity → entity" />
      <LayerConnector />
      <Layer label="entities" sub="typed records" />
      <DreamingConnector />
      <Layer label="events" sub="append-only log" />
      <ReactionsCallout />
    </ColumnFrame>
  );
}

/* -------------------------------------------------------------------------- */
/*  Agents column                                                             */
/* -------------------------------------------------------------------------- */

function SubBlock(props: { title: string; caption: string; children: preact.ComponentChildren }) {
  return (
    <div
      class="rounded-md border p-3"
      style={{ borderColor: "var(--color-page-border)", backgroundColor: "var(--color-page-bg)" }}
    >
      <div
        class="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em]"
        style={{ color: "var(--color-page-text)" }}
      >
        {props.title}
      </div>
      {props.children}
      <div
        class="mt-2 font-mono text-[10.5px]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {props.caption}
      </div>
    </div>
  );
}

function AgentsColumn() {
  return (
    <ColumnFrame title="Agents">
      <SubBlock title="chat bots" caption="users chat with the agent">
        <ul class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px]" style={{ color: "var(--color-page-text-muted)" }}>
          {messagingChannels.slice(0, 6).map((channel) => (
            <li key={channel.id} class="flex items-center gap-2">
              <span aria-hidden="true" class="inline-flex h-3.5 w-3.5 items-center justify-center">
                {channel.renderIcon(12)}
              </span>
              <span>{channel.label.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      </SubBlock>
      <SubBlock title="skills" caption="bundled per agent or shared">
        <ul class="grid grid-cols-2 gap-2 text-[11.5px]" style={{ color: "var(--color-page-text-muted)" }}>
          {["instructions", "tools", "network", "packages"].map((label) => (
            <li
              key={label}
              class="flex items-center justify-center rounded-md border px-2 py-1 font-mono text-[11px]"
              style={{ borderColor: "var(--color-page-border)", backgroundColor: "var(--color-page-surface)", color: "var(--color-page-text)" }}
            >
              {label}
            </li>
          ))}
        </ul>
      </SubBlock>
      <SubBlock title="api readers" caption="agents read memory">
        <ul class="grid grid-cols-3 gap-2 text-[11.5px]" style={{ color: "var(--color-page-text-muted)" }}>
          {["HTTP", "MCP", "SDK"].map((label) => (
            <li
              key={label}
              class="flex items-center justify-center rounded-md border px-2 py-1 font-mono text-[11.5px]"
              style={{ borderColor: "var(--color-page-border)", backgroundColor: "var(--color-page-surface)", color: "var(--color-page-text)" }}
            >
              {label}
            </li>
          ))}
        </ul>
      </SubBlock>
    </ColumnFrame>
  );
}

/* -------------------------------------------------------------------------- */
/*  Connector arrows between columns                                          */
/* -------------------------------------------------------------------------- */

function BetweenArrow({ label, axis }: { label: string; axis: "lr" | "tb" }) {
  // axis 'lr' is the desktop horizontal arrow; 'tb' is the mobile vertical one.
  // Render both into the DOM and toggle visibility via Tailwind so we don't
  // need media-query JS to flip the orientation.
  if (axis === "lr") {
    return (
      <div class="hidden flex-col items-center justify-center md:flex">
        <svg width="56" height="12" viewBox="0 0 56 12" aria-hidden="true">
          <title>{label}</title>
          <path
            d="M0 6 H48 M45 2.5 L49 6 L45 9.5"
            stroke="var(--color-page-text)"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
        <span class="mt-2 max-w-[7rem] text-center font-mono text-[10.5px] leading-tight" style={{ color: "var(--color-page-text-muted)" }}>
          {label}
        </span>
      </div>
    );
  }
  return (
    <div class="flex items-center justify-center md:hidden">
      <span class="font-mono text-[10.5px]" style={{ color: "var(--color-page-text-muted)" }}>
        {label}
      </span>
      <svg class="ml-2" width="12" height="28" viewBox="0 0 12 28" aria-hidden="true">
        <title>{label}</title>
        <path
          d="M6 0 V22 M2.5 19 L6 23 L9.5 19"
          stroke="var(--color-page-text)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
    </div>
  );
}
