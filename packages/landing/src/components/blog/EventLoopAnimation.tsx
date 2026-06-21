/**
 * Animated "operating loop" for the blog post, shown as a full closed loop:
 *
 *   batch of events stream in  →  written to the append-only log (entities
 *   derived)  →  a watcher fires and the agent acts, and every action emits a
 *   NEW event  →  which flows back into the stream. The loop.
 *
 * The incoming events are a live marquee (a stack streaming past), including a
 * couple the agent generated itself, so the loop visibly closes. Pure CSS
 * keyframes, no hydration. Same tokens/approach as ProactiveLoop.tsx.
 */

const ACCENT = "var(--color-tg-accent)";
const OK = "#36c5ab";
const RISK = "#f5a524";

type Ev = { src: string; name: string; ent?: string; gen?: boolean };

// The batch flowing in: real-looking source events, plus two the agent emitted
// last pass (gen: true), so you can see the loop feeding itself.
const EVENTS: Ev[] = [
  { src: "stripe", name: "payment_failed", ent: "Acme" },
  { src: "typeform", name: "lead.created" },
  { src: "agent", name: "note.created", ent: "Acme", gen: true },
  { src: "sentry", name: "error.spike" },
  { src: "gmail", name: "reply", ent: "Globex" },
  { src: "agent", name: "ticket.opened", gen: true },
  { src: "hubspot", name: "deal.won" },
  { src: "slack", name: "mention" },
];

function EventRow({ ev }: { ev: Ev }) {
  const srcColor = ev.gen ? ACCENT : "var(--color-page-text-muted)";
  return (
    <div class="mb-1.5 flex items-center gap-1.5 whitespace-nowrap">
      <span
        class="rounded border px-1 py-px font-mono text-[8.5px]"
        style={{
          color: srcColor,
          borderColor: ev.gen ? `${ACCENT}66` : "var(--color-page-border)",
          backgroundColor: ev.gen ? `${ACCENT}14` : "var(--color-page-surface)",
        }}
      >
        {ev.src}
      </span>
      <span
        class="font-mono text-[10px]"
        style={{ color: "var(--color-page-text)" }}
      >
        {ev.name}
      </span>
      {ev.ent ? (
        <span
          class="font-mono text-[9px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          · {ev.ent}
        </span>
      ) : null}
    </div>
  );
}

function Card({
  title,
  sub,
  grow = 1,
  children,
}: {
  title: string;
  sub: string;
  grow?: number;
  children: preact.ComponentChildren;
}) {
  return (
    <div
      class="relative flex min-w-0 flex-col gap-1.5 rounded-xl border p-3.5"
      style={{
        flex: `${grow} 1 0%`,
        borderColor: "var(--color-page-border)",
        backgroundImage:
          "linear-gradient(to bottom, var(--color-page-bg-elevated), var(--color-page-bg))",
      }}
    >
      <div class="flex items-center gap-1.5">
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: ACCENT }}
        />
        <span
          class="text-[12.5px] font-bold leading-tight"
          style={{ color: "var(--color-page-text)" }}
        >
          {title}
        </span>
      </div>
      <span
        class="text-[10px] leading-snug"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {sub}
      </span>
      {children}
    </div>
  );
}

function Chip({
  label,
  tone = "ok",
}: {
  label: string;
  tone?: "ok" | "risk" | "accent";
}) {
  const color = tone === "risk" ? RISK : tone === "accent" ? ACCENT : OK;
  return (
    <span
      class="rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
      style={{
        color,
        borderColor: `${color}55`,
        backgroundColor: `${color}14`,
      }}
    >
      {label}
    </span>
  );
}

function Connector() {
  return (
    <div
      class="relative hidden h-px flex-[0_0_26px] self-center sm:block"
      style={{ backgroundColor: "var(--color-page-border)" }}
    >
      <span
        class="flow-pip absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
        style={{ backgroundColor: ACCENT }}
      />
    </div>
  );
}

export function EventLoopAnimation() {
  const stream = [...EVENTS, ...EVENTS];
  return (
    <div class="not-prose my-7 flex flex-col gap-2.5">
      <div
        class="flex flex-col gap-2.5 rounded-2xl border p-4 sm:flex-row sm:items-stretch sm:gap-0"
        style={{
          borderColor: "var(--color-page-border)",
          backgroundColor: "var(--color-page-surface)",
        }}
      >
        {/* 1. batch of events streaming in */}
        <Card
          title="Events stream in"
          sub="webhooks + connectors, batched"
          grow={1.25}
        >
          <div
            class="ev-stream relative mt-1 overflow-hidden"
            style={{
              height: "104px",
              maskImage:
                "linear-gradient(to bottom, transparent, #000 16%, #000 84%, transparent)",
              WebkitMaskImage:
                "linear-gradient(to bottom, transparent, #000 16%, #000 84%, transparent)",
            }}
          >
            <div class="ev-track">
              {stream.map((ev, i) => (
                <EventRow key={`${ev.src}-${ev.name}-${i}`} ev={ev} />
              ))}
            </div>
          </div>
        </Card>

        <Connector />

        {/* 2. written to the append-only log, entities derived */}
        <Card title="Written to the log" sub="append-only · every event a row">
          <div
            class="mt-0.5 rounded-md border px-2 py-1.5 font-mono text-[9.5px]"
            style={{
              borderColor: "var(--color-page-border)",
              backgroundColor: "var(--color-page-surface)",
              color: "var(--color-page-text-muted)",
            }}
          >
            <div class="flex justify-between">
              <span>event_id</span>
              <span>source</span>
            </div>
            {[
              ["a1f9…", "stripe"],
              ["b2c4…", "sentry"],
              ["c3d7…", "agent"],
            ].map(([id, src]) => (
              <div
                key={id}
                class="flex justify-between"
                style={{ color: "var(--color-page-text)" }}
              >
                <span>{id}</span>
                <span>{src}</span>
              </div>
            ))}
          </div>
          <div class="mt-1 flex items-center gap-1.5">
            <span
              class="text-[9.5px]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              entity
            </span>
            <Chip label="Acme → at risk" tone="risk" />
          </div>
        </Card>

        <Connector />

        {/* 3. watcher fires, agent acts, each action emits a new event */}
        <Card
          title="Watcher fires, agent acts"
          sub="sandbox · your model · MCP tools"
        >
          <span class="font-mono text-[11px]" style={{ color: ACCENT }}>
            enterprise-churn-watch
          </span>
          <div class="flex flex-wrap gap-1">
            {["Stripe", "HubSpot", "Slack"].map((t) => (
              <span
                key={t}
                class="rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]"
                style={{
                  borderColor: "var(--color-page-border)",
                  color: "var(--color-page-text-muted)",
                  backgroundColor: "var(--color-page-surface)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
          <span
            class="mt-1 text-[9.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            each action emits an event:
          </span>
          <div class="flex flex-wrap gap-1">
            <Chip label="note.created" tone="accent" />
            <Chip label="ticket.opened" tone="accent" />
            <Chip label="message.sent" tone="accent" />
          </div>
        </Card>
      </div>

      {/* loop-back rail: emitted events flow back into the stream */}
      <div class="flex items-center gap-2 px-1">
        <span
          class="font-mono text-[12px]"
          style={{ color: ACCENT }}
          aria-hidden="true"
        >
          ↩
        </span>
        <div
          class="relative h-px flex-1"
          style={{ backgroundColor: "var(--color-page-border)" }}
        >
          <span
            class="flow-pip-rev absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
            style={{ backgroundColor: ACCENT }}
          />
        </div>
        <span
          class="font-mono text-[10.5px]"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          every action is a new event, back into the stream
        </span>
      </div>

      <style>{`
        @keyframes lobu-ev-scroll {
          from { transform: translateY(0); }
          to { transform: translateY(-50%); }
        }
        .ev-track { animation: lobu-ev-scroll 11s linear infinite; }
        @keyframes lobu-flow-x {
          0% { left: -4px; opacity: 0; }
          12% { opacity: 1; }
          88% { opacity: 1; }
          100% { left: calc(100% + 4px); opacity: 0; }
        }
        @keyframes lobu-flow-x-rev {
          0% { left: calc(100% + 4px); opacity: 0; }
          12% { opacity: 1; }
          88% { opacity: 1; }
          100% { left: -4px; opacity: 0; }
        }
        .flow-pip {
          animation: lobu-flow-x 2.4s linear infinite;
          box-shadow: 0 0 8px 1px var(--color-tg-accent);
        }
        .flow-pip-rev {
          animation: lobu-flow-x-rev 3s linear infinite;
          box-shadow: 0 0 8px 1px var(--color-tg-accent);
        }
        @media (prefers-reduced-motion: reduce) {
          .ev-track { animation: none; }
          .flow-pip, .flow-pip-rev { animation: none; opacity: 0.6; left: 50%; }
        }
      `}</style>
    </div>
  );
}
