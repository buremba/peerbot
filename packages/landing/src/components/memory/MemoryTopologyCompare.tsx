import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import {
  accentCyan,
  cardBg,
  cardBorder,
  innerCardBg,
  labelGray,
  textColor,
  textMuted,
} from "./styles";

const AGENT_LABELS = ["A1", "A2", "A3"] as const;

function AgentTile({ label }: { label: string }) {
  return (
    <div
      class="flex h-12 w-12 items-center justify-center rounded-lg font-mono text-[0.8rem] font-semibold"
      style={{
        backgroundColor: innerCardBg,
        border: `1px solid ${cardBorder}`,
        color: textColor,
      }}
    >
      {label}
    </div>
  );
}

function FsTile() {
  return (
    <div
      class="flex h-10 w-12 items-center justify-center rounded-md font-mono text-[0.7rem]"
      style={{
        backgroundColor: "rgba(255,255,255,0.02)",
        border: `1px dashed ${cardBorder}`,
        color: labelGray,
      }}
    >
      fs
    </div>
  );
}

function DownArrow() {
  return (
    <svg
      width="14"
      height="22"
      viewBox="0 0 14 22"
      aria-hidden="true"
      style={{ color: labelGray }}
    >
      <line
        x1="7"
        y1="0"
        x2="7"
        y2="16"
        stroke="currentColor"
        stroke-width="1.2"
      />
      <polyline
        points="3,14 7,20 11,14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ConvergingArrows() {
  const reactId = useId();
  const markerId = `memory-arrow-head-${reactId.replace(/[:]/g, "")}`;
  return (
    <svg
      viewBox="0 0 240 70"
      class="h-16 w-full"
      aria-hidden="true"
      style={{ color: accentCyan }}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>
      <line
        x1="32"
        y1="2"
        x2="120"
        y2="62"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 3"
        marker-end={`url(#${markerId})`}
      />
      <line
        x1="120"
        y1="2"
        x2="120"
        y2="62"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 3"
        marker-end={`url(#${markerId})`}
      />
      <line
        x1="208"
        y1="2"
        x2="120"
        y2="62"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 3"
        marker-end={`url(#${markerId})`}
      />
      <g>
        <rect
          x="58"
          y="30"
          width="22"
          height="13"
          rx="3"
          fill="rgba(5,7,10,0.92)"
          stroke="currentColor"
          stroke-width="0.6"
          opacity="0.95"
        />
        <text
          x="69"
          y="39"
          font-size="9"
          font-family="ui-monospace, SFMono-Regular, monospace"
          fill="currentColor"
          text-anchor="middle"
        >
          mcp
        </text>
      </g>
      <g>
        <rect
          x="160"
          y="30"
          width="22"
          height="13"
          rx="3"
          fill="rgba(5,7,10,0.92)"
          stroke="currentColor"
          stroke-width="0.6"
          opacity="0.95"
        />
        <text
          x="171"
          y="39"
          font-size="9"
          font-family="ui-monospace, SFMono-Regular, monospace"
          fill="currentColor"
          text-anchor="middle"
        >
          mcp
        </text>
      </g>
    </svg>
  );
}

function CardShell({
  eyebrow,
  eyebrowColor,
  title,
  children,
  bullets,
}: {
  eyebrow: string;
  eyebrowColor: string;
  title: string;
  children: ComponentChildren;
  bullets: string[];
}) {
  return (
    <div
      class="flex flex-col rounded-2xl p-5 sm:p-6"
      style={{
        background: cardBg,
        border: `1px solid ${cardBorder}`,
      }}
    >
      <div
        class="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em]"
        style={{ color: eyebrowColor }}
      >
        {eyebrow}
      </div>
      <h3 class="mb-5 text-lg font-semibold" style={{ color: textColor }}>
        {title}
      </h3>

      <div
        class="rounded-xl px-4 py-5"
        style={{
          backgroundColor: innerCardBg,
          border: `1px solid ${cardBorder}`,
        }}
      >
        {children}
      </div>

      <ul
        class="m-0 mt-5 flex list-none flex-col gap-2 p-0 text-[0.88rem] leading-6"
        style={{ color: textMuted }}
      >
        {bullets.map((bullet) => (
          <li key={bullet} class="flex items-start gap-2">
            <span aria-hidden="true" class="mt-[2px]">
              ·
            </span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SiloedDiagram() {
  return (
    <div
      class="flex flex-col items-center"
      role="img"
      aria-label="Three agents, each pointing down to its own private filesystem. No shared layer between them."
    >
      <div
        class="flex items-end justify-around gap-6 sm:gap-10"
        aria-hidden="true"
      >
        {AGENT_LABELS.map((label) => (
          <div key={label} class="flex flex-col items-center gap-1">
            <AgentTile label={label} />
            <DownArrow />
            <FsTile />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        class="mt-4 text-[10px] uppercase tracking-[0.18em]"
        style={{ color: labelGray }}
      >
        no shared layer
      </div>
    </div>
  );
}

function SharedDiagram() {
  return (
    <div
      class="flex flex-col items-center"
      role="img"
      aria-label="Three agents converging through MCP onto a single shared Lobu Memory layer of entities and events."
    >
      <div
        class="grid w-full max-w-[18rem] grid-cols-3 items-center gap-4"
        aria-hidden="true"
      >
        {AGENT_LABELS.map((label) => (
          <div key={label} class="flex justify-center">
            <AgentTile label={label} />
          </div>
        ))}
      </div>
      <ConvergingArrows />
      <div
        aria-hidden="true"
        class="mt-1 flex w-full max-w-[18rem] flex-col items-center rounded-lg px-3 py-2"
        style={{
          backgroundColor: "rgba(103, 232, 249, 0.08)",
          border: `1px solid rgba(103, 232, 249, 0.4)`,
          color: textColor,
        }}
      >
        <div class="text-[0.92rem] font-semibold">Lobu Memory</div>
        <div
          class="mt-0.5 font-mono text-[0.72rem]"
          style={{ color: labelGray }}
        >
          entities · events
        </div>
      </div>
    </div>
  );
}

export function MemoryTopologyCompare() {
  return (
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <CardShell
        eyebrow="Siloed"
        eyebrowColor={labelGray}
        title="Each agent has its own filesystem"
        bullets={[
          "no cross-agent recall",
          "audit is per-agent and manual",
          "tied to one sandbox / session",
        ]}
      >
        <SiloedDiagram />
      </CardShell>

      <CardShell
        eyebrow="Shared via MCP"
        eyebrowColor={accentCyan}
        title="Agents share Lobu Memory through MCP"
        bullets={[
          "one truth across agents",
          "dedup via entity model",
          "inspectable + correctable",
        ]}
      >
        <SharedDiagram />
      </CardShell>
    </div>
  );
}
