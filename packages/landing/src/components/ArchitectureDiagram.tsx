// biome-ignore-all format: stays compact for the landing-page panel
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * Animated fan-in / fan-out diagram (Notion-/Vercel-style).
 *
 *   ┌──────────┐                    ┌──────────┐
 *   │ trigger1 │─┐               ┌─▶│ action1  │
 *   ├──────────┤  │  ┌────────┐  │  ├──────────┤
 *   │ trigger2 │──┼─▶│ watcher├──┼─▶│ action2  │
 *   ├──────────┤  │  └────────┘  │  ├──────────┤
 *   │ trigger3 │─┘               └─▶│ action3  │
 *   └──────────┘                    └──────────┘
 *
 * A scenario cycles every 2.5s. The active LEFT row, the center watcher
 * label, and the active RIGHT row light up; lines connect them. Inactive
 * rows dim. Honors prefers-reduced-motion (pauses on scenario 0).
 *
 * The watcher slugs (and the trigger events that feed them) are sourced
 * from the real example projects in examples/<id>/models/schema.yaml,
 * so anyone clicking through to the repo finds the same names.
 */

type Brand = { key: string; label: string; color: string; path: string };

/* -------------------------------------------------------------------------- */
/*  Brand glyphs (simpleicons-style paths, MIT)                               */
/* -------------------------------------------------------------------------- */

const BRANDS: Record<string, Brand> = {
  stripe: {
    key: "stripe",
    label: "Stripe",
    color: "var(--color-page-text)",
    path: "M13.479 9.883c-1.626-.604-2.512-1.067-2.512-1.803 0-.622.511-.977 1.422-.977 1.668 0 3.379.642 4.558 1.22l.666-4.111c-.935-.446-2.847-1.177-5.49-1.177-1.87 0-3.425.489-4.536 1.401-1.155.954-1.757 2.334-1.757 4.005 0 3.027 1.847 4.328 4.855 5.42 1.937.696 2.587 1.192 2.587 1.954 0 .74-.629 1.158-1.77 1.158-1.396 0-3.741-.69-5.323-1.585L5.5 19.612c1.305.74 3.722 1.5 6.245 1.5 1.977 0 3.629-.464 4.752-1.358 1.262-.985 1.915-2.432 1.915-4.155 0-3.105-1.89-4.392-4.933-5.516z",
  },
  salesforce: {
    key: "salesforce",
    label: "Salesforce",
    color: "var(--color-page-text)",
    path: "M10.006 5.415a4.195 4.195 0 0 1 3.045-1.306c1.56 0 2.954.9 3.69 2.205.63-.3 1.35-.45 2.1-.45 2.85 0 5.159 2.34 5.159 5.22 0 2.88-2.31 5.22-5.16 5.22-.345 0-.69-.044-1.02-.1-.659 1.185-1.92 1.996-3.355 1.996a3.84 3.84 0 0 1-1.68-.39 4.65 4.65 0 0 1-4.319 2.85c-1.905 0-3.6-1.155-4.29-2.85a3.661 3.661 0 0 1-.84.105c-2.146 0-3.886-1.756-3.886-3.93 0-1.46.78-2.733 1.95-3.42-.24-.555-.375-1.17-.375-1.8 0-2.535 2.07-4.59 4.605-4.59 1.5 0 2.82.72 3.66 1.83",
  },
  linear: {
    key: "linear",
    label: "Linear",
    color: "var(--color-page-text)",
    path: "M.403 13.795A12.131 12.131 0 0 0 10.203 23.6L.403 13.795zM.182 10.103l13.715 13.714a12.18 12.18 0 0 0 3.137-1.21L1.392 6.966a12.18 12.18 0 0 0-1.21 3.137zm3.135-5.836a12.16 12.16 0 0 1 1.51-1.84L21.572 19.17a12.137 12.137 0 0 1-1.84 1.51L3.317 4.267zM6.682 1.43A12.12 12.12 0 0 1 12 0c6.626 0 12 5.374 12 12 0 1.872-.428 3.643-1.193 5.22L6.682 1.43Z",
  },
  discourse: {
    key: "discourse",
    label: "Discourse",
    color: "var(--color-page-text)",
    path: "M12.103 0C5.404 0 0 5.405 0 12.103 0 18.8 5.405 24 12.103 24h11.79V12.103C23.893 5.404 18.802 0 12.103 0zm.105 4.5a7.617 7.617 0 0 1 6.61 11.4l1.092 3.825-4.122-.937a7.617 7.617 0 1 1-3.58-14.288z",
  },
  docusign: {
    key: "docusign",
    label: "DocuSign",
    color: "var(--color-page-text)",
    path: "M4 2h12l4 4v16H4V2zm2 2v16h12V8h-4V4H6zm2 6h8v2H8v-2zm0 4h8v2H8v-2zm0 4h5v2H8v-2z",
  },
  slack: {
    key: "slack",
    label: "Slack",
    color: "var(--color-page-text)",
    path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  },
  lobu: {
    key: "lobu",
    label: "Lobu",
    color: "var(--color-page-text)",
    // Simple "owl eye" glyph — concentric circle + dot. Stand-in for the
    // Lobu mark; visually distinct from the third-party brand circles.
    path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  },
};

function BrandGlyph({ brandKey, size = 22 }: { brandKey: string; size?: number }) {
  const brand = BRANDS[brandKey];
  if (!brand) {
    return (
      <span
        class="inline-block rounded-sm"
        style={{
          width: size,
          height: size,
          backgroundColor: "var(--color-page-surface-dim)",
        }}
        aria-hidden="true"
      />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={brand.label} role="img">
      <title>{brand.label}</title>
      <path d={brand.path} fill={brand.color} />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Scenarios                                                                 */
/* -------------------------------------------------------------------------- */

type Scenario = {
  trigger: { brand: string; event: string };
  // The watcher slug as it appears in examples/<id>/models/schema.yaml.
  // Rendered as `worker.watcher("<slug>")` to mirror the Notion mapping
  // (their center reads `worker.webhook(shipPR)`).
  watcher: string;
  action: { brand: string; label: string };
};

// Sourced from:
//   examples/sales/models/schema.yaml         -> account-health-monitor
//   examples/legal/models/schema.yaml         -> contract-review-tracker
//   examples/finance/models/schema.yaml       -> reconciliation-monitor
//   examples/agent-community/models/schema.yaml -> opportunity-matcher
//   examples/lobu-crm/models/schema.yaml      -> funnel-digest
const SCENARIOS: Scenario[] = [
  {
    trigger: { brand: "stripe", event: "stripe.charge.failed" },
    watcher: "account-health-monitor",
    action: { brand: "lobu", label: 'save_knowledge("Account")' },
  },
  {
    trigger: { brand: "salesforce", event: "salesforce.opp.updated" },
    watcher: "account-health-monitor",
    action: { brand: "slack", label: "slack.post(#sales)" },
  },
  {
    trigger: { brand: "linear", event: "linear.issue.created" },
    watcher: "opportunity-matcher",
    action: { brand: "lobu", label: 'save_knowledge("Match")' },
  },
  {
    trigger: { brand: "discourse", event: "discourse.post.created" },
    watcher: "funnel-digest",
    action: { brand: "slack", label: "slack.post(#funnel)" },
  },
  {
    trigger: { brand: "docusign", event: "docusign.envelope.signed" },
    watcher: "contract-review-tracker",
    action: { brand: "lobu", label: 'save_knowledge("Contract")' },
  },
];

const TRIGGERS = SCENARIOS.map((s) => s.trigger);
const ACTIONS = SCENARIOS.map((s) => s.action);

const CYCLE_MS = 2500;

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduce;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function ArchitectureDiagram() {
  const [active, setActive] = useState(0);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reduceMotion) return;
    const t = window.setInterval(() => {
      setActive((i) => (i + 1) % SCENARIOS.length);
    }, CYCLE_MS);
    return () => window.clearInterval(t);
  }, [reduceMotion]);

  return (
    <div class="flex flex-col gap-6">
      <Header />
      <DiagramBoard active={active} />
    </div>
  );
}

function Header() {
  // Eyebrow + heading + lede styles mirror Eyebrow / SectionHeading from
  // LandingPage.tsx so the architecture block reads as a peer to the other
  // landing sections rather than its own one-off treatment.
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
        Event in. Memory out.
      </h2>
      <p
        class="mt-3 max-w-2xl text-[15px] leading-relaxed"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Connectors stream events. Watchers shape them into memory. Reactions take action.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Board (desktop + mobile)                                                  */
/* -------------------------------------------------------------------------- */

function DiagramBoard({ active }: { active: number }) {
  return (
    <div
      class="relative rounded-lg border p-6 sm:p-8"
      style={{
        borderColor: "var(--color-page-border)",
        backgroundColor: "var(--color-page-surface)",
        boxShadow: "0 1px 0 0 var(--color-page-border)",
      }}
    >
      {/* Mobile: stacked. Desktop: 3 columns with absolutely-positioned line overlay. */}
      <div class="hidden lg:block">
        <DesktopBoard active={active} />
      </div>
      <div class="block lg:hidden">
        <MobileBoard active={active} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Desktop board                                                             */
/* -------------------------------------------------------------------------- */

function DesktopBoard({ active }: { active: number }) {
  const scenario = SCENARIOS[active];
  const boardRef = useRef<HTMLDivElement>(null);
  const leftRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rightRefs = useRef<(HTMLDivElement | null)[]>([]);
  const centerRef = useRef<HTMLDivElement>(null);

  type Line = { x1: number; y1: number; x2: number; y2: number };
  const [lines, setLines] = useState<{ inbound: Line | null; outbound: Line | null }>({
    inbound: null,
    outbound: null,
  });

  useEffect(() => {
    function measure() {
      const board = boardRef.current;
      const center = centerRef.current;
      const left = leftRefs.current[active];
      const right = rightRefs.current[active];
      if (!board || !center || !left || !right) return;
      const boardBox = board.getBoundingClientRect();
      const centerBox = center.getBoundingClientRect();
      const leftBox = left.getBoundingClientRect();
      const rightBox = right.getBoundingClientRect();
      setLines({
        inbound: {
          x1: leftBox.right - boardBox.left,
          y1: leftBox.top + leftBox.height / 2 - boardBox.top,
          x2: centerBox.left - boardBox.left,
          y2: centerBox.top + centerBox.height / 2 - boardBox.top,
        },
        outbound: {
          x1: centerBox.right - boardBox.left,
          y1: centerBox.top + centerBox.height / 2 - boardBox.top,
          x2: rightBox.left - boardBox.left,
          y2: rightBox.top + rightBox.height / 2 - boardBox.top,
        },
      });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active]);

  return (
    <div ref={boardRef} class="relative">
      <div class="grid grid-cols-[1fr_minmax(17rem,22rem)_1fr] items-center gap-x-10">
        {/* TRIGGER column */}
        <div class="flex flex-col gap-2">
          <ColumnLabel text="Trigger" />
          {TRIGGERS.map((t, i) => (
            <div
              key={`t-${t.event}`}
              ref={(el) => {
                leftRefs.current[i] = el;
              }}
            >
              <Row brandKey={t.brand} label={t.event} active={i === active} align="left" />
            </div>
          ))}
        </div>

        {/* CENTER watcher */}
        <div class="flex flex-col items-center gap-2">
          <ColumnLabel text="Watcher" />
          <div ref={centerRef} class="w-full">
            <WatcherCallout slug={scenario.watcher} />
          </div>
          <div
            class="text-center font-mono text-[10.5px]"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            extracts entities · runs reactions
          </div>
        </div>

        {/* ACTION column */}
        <div class="flex flex-col gap-2">
          <ColumnLabel text="Action" align="right" />
          {ACTIONS.map((a, i) => (
            <div
              key={`a-${a.label}`}
              ref={(el) => {
                rightRefs.current[i] = el;
              }}
            >
              <Row brandKey={a.brand} label={a.label} active={i === active} align="right" />
            </div>
          ))}
        </div>
      </div>

      {/* Line overlay */}
      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
        style={{ overflow: "visible" }}
      >
        <title>active flow</title>
        {lines.inbound ? <FlowLine line={lines.inbound} /> : null}
        {lines.outbound ? <FlowLine line={lines.outbound} arrow /> : null}
      </svg>
    </div>
  );
}

function FlowLine({
  line,
  arrow = false,
}: {
  line: { x1: number; y1: number; x2: number; y2: number };
  arrow?: boolean;
}) {
  // Smooth horizontal S-curve between two points.
  const dx = (line.x2 - line.x1) * 0.5;
  const d = `M${line.x1},${line.y1} C${line.x1 + dx},${line.y1} ${line.x2 - dx},${line.y2} ${line.x2},${line.y2}`;
  return (
    <>
      <path
        d={d}
        stroke="var(--color-tg-accent)"
        stroke-width="1.5"
        fill="none"
        stroke-linecap="round"
      />
      {arrow ? (
        <polyline
          points={`${line.x2 - 5},${line.y2 - 4} ${line.x2},${line.y2} ${line.x2 - 5},${line.y2 + 4}`}
          stroke="var(--color-tg-accent)"
          stroke-width="1.5"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Mobile board                                                              */
/* -------------------------------------------------------------------------- */

function MobileBoard({ active }: { active: number }) {
  const scenario = SCENARIOS[active];
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <ColumnLabel text="Trigger" />
        {TRIGGERS.map((t, i) => (
          <Row
            key={`mt-${t.event}`}
            brandKey={t.brand}
            label={t.event}
            active={i === active}
            align="left"
          />
        ))}
      </div>

      <VerticalArrow />

      <div class="flex flex-col gap-2">
        <ColumnLabel text="Watcher" />
        <WatcherCallout slug={scenario.watcher} />
      </div>

      <VerticalArrow />

      <div class="flex flex-col gap-2">
        <ColumnLabel text="Action" />
        {ACTIONS.map((a, i) => (
          <Row
            key={`ma-${a.label}`}
            brandKey={a.brand}
            label={a.label}
            active={i === active}
            align="left"
          />
        ))}
      </div>
    </div>
  );
}

function VerticalArrow() {
  return (
    <div class="flex items-center justify-center" aria-hidden="true">
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

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

function ColumnLabel({ text, align = "left" }: { text: string; align?: "left" | "right" }) {
  return (
    <div
      class={`mb-1 font-mono text-[10.5px] uppercase tracking-[0.18em] ${align === "right" ? "text-right" : "text-left"}`}
      style={{ color: "var(--color-page-text-muted)" }}
    >
      {text}
    </div>
  );
}

function Row({
  brandKey,
  label,
  active,
  align,
}: {
  brandKey: string;
  label: string;
  active: boolean;
  align: "left" | "right";
}) {
  // Active = full opacity + accent border tint. Inactive = ~40% opacity, no border tint.
  return (
    <div
      class={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-opacity duration-300 ${
        align === "right" ? "flex-row-reverse text-right" : "flex-row text-left"
      }`}
      style={{
        borderColor: active ? "var(--color-tg-accent)" : "var(--color-page-border)",
        backgroundColor: active ? "var(--color-page-surface-dim)" : "var(--color-page-bg)",
        opacity: active ? 1 : 0.35,
      }}
    >
      <span class="flex h-6 w-6 flex-shrink-0 items-center justify-center">
        <BrandGlyph brandKey={brandKey} size={22} />
      </span>
      <span
        class="truncate font-mono text-[12px]"
        style={{ color: "var(--color-page-text)" }}
      >
        {label}
      </span>
    </div>
  );
}

function WatcherCallout({ slug }: { slug: string }) {
  // The center label swaps per scenario with a brief opacity transition.
  // Using `key` here would remount and lose any focus state; instead we let
  // text content change in-place. Preact diffs the inner text node only.
  return (
    <div
      class="flex items-center justify-center rounded-lg border px-3 py-3 transition-opacity duration-200"
      style={{
        borderColor: "var(--color-page-border-active)",
        backgroundColor: "var(--color-page-text)",
        color: "var(--color-page-bg)",
      }}
    >
      <span class="truncate font-mono text-[12.5px]">{`worker.watcher("${slug}")`}</span>
    </div>
  );
}
