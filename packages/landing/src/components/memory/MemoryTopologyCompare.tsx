import type { ComponentChildren } from "preact";
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
  return (
    <svg
      viewBox="0 0 240 60"
      class="h-14 w-full"
      aria-hidden="true"
      style={{ color: accentCyan }}
    >
      <defs>
        <marker
          id="memory-arrow-head"
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
        y2="56"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 3"
        marker-end="url(#memory-arrow-head)"
      />
      <line
        x1="120"
        y1="2"
        x2="120"
        y2="56"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 3"
        marker-end="url(#memory-arrow-head)"
      />
      <line
        x1="208"
        y1="2"
        x2="120"
        y2="56"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 3"
        marker-end="url(#memory-arrow-head)"
      />
      <text
        x="68"
        y="34"
        font-size="9"
        font-family="ui-monospace, SFMono-Regular, monospace"
        fill="currentColor"
        opacity="0.85"
      >
        mcp
      </text>
      <text
        x="148"
        y="34"
        font-size="9"
        font-family="ui-monospace, SFMono-Regular, monospace"
        fill="currentColor"
        opacity="0.85"
      >
        mcp
      </text>
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
      <h3
        class="mb-5 text-lg font-semibold"
        style={{ color: textColor }}
      >
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
    <div class="flex flex-col items-center">
      <div class="flex items-end justify-around gap-6 sm:gap-10">
        {AGENT_LABELS.map((label) => (
          <div key={label} class="flex flex-col items-center gap-1">
            <AgentTile label={label} />
            <DownArrow />
            <FsTile />
          </div>
        ))}
      </div>
      <div
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
    <div class="flex flex-col items-center">
      <div class="grid w-full max-w-[18rem] grid-cols-3 items-center gap-4">
        {AGENT_LABELS.map((label) => (
          <div key={label} class="flex justify-center">
            <AgentTile label={label} />
          </div>
        ))}
      </div>
      <ConvergingArrows />
      <div
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
          "no audit trail",
          "dies with the sandbox",
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
