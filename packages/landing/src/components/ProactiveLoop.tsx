/**
 * Outcome artifact for the homepage: shows the proactive loop end to end
 * WITHOUT any code, so a non-TS reader gets the value in one glance.
 *
 *   raw events  ──►  graph derives a typed entity  ──►  agent acts (surfaces in chat)
 *
 * The graph (left) is the substance; the chat (right) is just one surface.
 * Reuses SampleChat with a custom proactive (bot-first) message list.
 */

import type { UseCase } from "../types";
import { SampleChat, SLACK_THEME } from "./SampleChat";

// Proactive: the agent speaks first, unprompted, because the graph changed.
const PROACTIVE_SCENARIO: UseCase = {
  id: "proactive-renewal",
  tabLabel: "Renewal risk",
  title: "Proactive renewal risk",
  description: "The agent flags churn risk before anyone asks.",
  settingsLabel: "",
  chatLabel: "",
  botName: "Revenue agent",
  botInitial: "R",
  botColor: "#36c5ab",
  messages: [
    {
      role: "bot",
      text: "Heads up: Acme Corp is trending toward churn. Logins are down 38% over 14 days and their renewal is in 21 days.\n\nWant me to draft a check-in for their CSM?",
      buttons: [{ label: "Draft the email", action: "link" }],
    },
    {
      role: "user",
      text: "Yes, and include the usage drop.",
    },
    {
      role: "bot",
      text: "Drafted. Saved it to the Acme account and pinged @dana.",
    },
  ],
};

// The "what the graph knew" record that triggered the message above. Field
// names match the sales example's entity types (account / renewal-risk).
const GRAPH_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["account", "Acme Corp"],
  ["health", "at risk"],
  ["signal", "logins −38% / 14d"],
  ["renewal_in", "21 days"],
];

const SOURCE_EVENTS = [
  "Product usage",
  "CRM renewal date",
  "Support tickets",
  "Slack notes",
] as const;

function GraphCard() {
  return (
    <div
      class="flex w-full flex-col gap-3 rounded-[14px] border p-4"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-bg)",
        minWidth: "280px",
        maxWidth: "460px",
      }}
    >
      <div class="flex items-center justify-between">
        <span
          class="font-mono text-[11px] uppercase tracking-[0.16em]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Live company memory
        </span>
        <span
          class="rounded-md border px-2 py-0.5 font-mono text-[10.5px]"
          style={{
            borderColor: "var(--color-page-border)",
            color: "var(--color-tg-accent)",
          }}
        >
          account
        </span>
      </div>

      <div class="flex flex-col">
        {GRAPH_FIELDS.map((row, idx) => (
          <div
            key={row[0]}
            class="grid grid-cols-[100px_1fr] gap-x-3 py-1.5 font-mono text-[12.5px]"
            style={{
              borderTop:
                idx === 0 ? undefined : "1px solid var(--color-page-border)",
            }}
          >
            <span style={{ color: "var(--color-page-text-muted)" }}>
              {row[0]}
            </span>
            <span style={{ color: "var(--color-page-text)" }}>{row[1]}</span>
          </div>
        ))}
      </div>

      <div
        class="border-t pt-2"
        style={{ borderColor: "var(--color-page-border)" }}
      >
        <div
          class="mb-2 text-[11.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Built from 1,204 source events:
        </div>
        <div class="flex flex-wrap gap-1.5">
          {SOURCE_EVENTS.map((event) => (
            <span
              key={event}
              class="rounded-md border px-2 py-1 text-[11px]"
              style={{
                borderColor: "var(--color-page-border)",
                color: "var(--color-page-text-muted)",
                backgroundColor: "var(--color-page-surface)",
              }}
            >
              {event}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Small labelled arrow: "graph changed → agent acts". Horizontal on desktop,
// vertical (rotated) on mobile so the two cards stack cleanly.
function FlowArrow() {
  return (
    <div class="flex shrink-0 flex-col items-center justify-center gap-1.5 md:px-1">
      <span
        class="font-mono text-[10.5px] uppercase tracking-[0.12em]"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        acts
      </span>
      <svg
        class="rotate-90 md:rotate-0"
        width="40"
        height="12"
        viewBox="0 0 40 12"
        aria-hidden="true"
      >
        <title>flow</title>
        <path
          d="M0 6 H32 M28 2.5 L33 6 L28 9.5"
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

export function ProactiveLoop() {
  return (
    <div class="flex flex-col items-center gap-8">
      <div class="flex flex-col items-center text-center">
        <div
          class="mb-3 font-mono text-[11.5px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--color-tg-accent)" }}
        >
          What it does
        </div>
        <h2
          class="font-display text-[1.85rem] font-bold leading-[1.1] tracking-tight sm:text-[2.25rem]"
          style={{ color: "var(--color-page-text)" }}
        >
          Shared memory updates. The agent acts.
        </h2>
        <p
          class="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Usage, CRM, support, and Slack updates become one account record. When
          renewal risk rises, the revenue agent proposes the next step.
        </p>
      </div>

      <div class="flex w-full flex-col items-center justify-center gap-4 md:flex-row md:items-stretch">
        <GraphCard />
        <FlowArrow />
        <SampleChat useCase={PROACTIVE_SCENARIO} theme={SLACK_THEME} />
      </div>
    </div>
  );
}
