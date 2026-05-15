import { messagingChannels } from "./platforms";

function chatgptIcon(size = 12) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A5.98 5.98 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function claudeIcon(size = 12) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.683 2H13.79L20.034 22h2.91L16.683 2zM7.32 2L1.057 22h2.989l1.276-4.224h6.531L13.13 22h2.989L9.856 2H7.32zm-1.07 13.05L8.59 7.286l2.339 7.764H6.25z" />
    </svg>
  );
}

function cursorIcon(size = 12) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M11.925 24l10.425-6-10.425-6L1.5 18l10.425 6z" />
      <path d="M22.35 18V6L11.925 0v12L22.35 18z" opacity="0.7" />
      <path d="M11.925 0L1.5 6v12l10.425-6V0z" opacity="0.45" />
    </svg>
  );
}

function openClawIcon(size = 12) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="15" r="4" />
      <circle cx="6" cy="10" r="2" />
      <circle cx="18" cy="10" r="2" />
      <circle cx="9" cy="5" r="1.7" />
      <circle cx="15" cy="5" r="1.7" />
    </svg>
  );
}

function ChipRow({ items }: { items: string[] }) {
  return (
    <div class="flex flex-wrap gap-2">
      {items.map((label) => (
        <span
          key={label}
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
          style={{
            background: "var(--color-page-surface-dim)",
            border: "1px solid var(--color-page-border)",
            color: "var(--color-page-text)",
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

const memoryAgents = [
  { name: "ChatGPT", detail: "Agent", icon: "✦" },
  { name: "Claude", detail: "Agent", icon: "◇" },
  { name: "OpenClaw", detail: "Agent", icon: "⌘" },
];

export function SharedMemoryGraphic() {
  return (
    <div
      class="w-full max-w-md"
      role="img"
      aria-label="ChatGPT, Claude, and OpenClaw agents sharing Lobu Memory through MCP"
    >
      <div class="grid grid-cols-3 gap-3">
        {memoryAgents.map((agent) => (
          <MemoryAgentCard key={agent.name} {...agent} />
        ))}
      </div>

      <div class="flex h-14 items-center justify-center" aria-hidden="true">
        <span
          class="inline-flex items-center gap-2 rounded-md px-2.5 py-1 text-[11px] font-medium"
          style={{
            background: "var(--color-page-bg)",
            border: "1px solid var(--color-page-border)",
            color: "var(--color-page-text-muted)",
          }}
        >
          <span
            class="font-mono font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-tg-accent)" }}
          >
            MCP
          </span>
          <span>shared context</span>
        </span>
      </div>

      <div
        class="rounded-xl bg-[var(--color-page-surface)] shadow-sm"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div
          class="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: "1px solid var(--color-page-border)" }}
        >
          <span
            class="inline-flex h-7 w-7 items-center justify-center rounded-md text-[14px]"
            style={{
              background: "rgba(var(--color-tg-accent-rgb), 0.08)",
              border: "1px solid rgba(var(--color-tg-accent-rgb), 0.22)",
            }}
            aria-hidden="true"
          >
            🧠
          </span>
          <span
            class="flex-1 text-[15px] font-semibold"
            style={{ color: "var(--color-page-text)" }}
          >
            Lobu Memory
          </span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
            style={{
              background: "var(--color-page-surface-dim)",
              border: "1px solid var(--color-page-border)",
              color: "var(--color-page-text-muted)",
            }}
          >
            Shared
          </span>
        </div>
        <div class="grid grid-cols-3 gap-2 p-3">
          {[
            { label: "Entities", value: "typed" },
            { label: "Events", value: "append-only" },
            { label: "Recall", value: "semantic" },
          ].map((item) => (
            <div
              key={item.label}
              class="rounded-lg px-3 py-3 text-center"
              style={{
                background: "var(--color-page-surface-dim)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <div
                class="text-[12px] font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                {item.label}
              </div>
              <div
                class="mt-1 text-[10px]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MemoryAgentCard({
  name,
  detail,
  icon,
}: {
  name: string;
  detail: string;
  icon: string;
}) {
  return (
    <div
      class="rounded-xl bg-[var(--color-page-surface)] shadow-sm"
      style={{ border: "1px solid var(--color-page-border)" }}
    >
      <div class="flex flex-col items-center px-2 py-3 text-center">
        <span
          class="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-[13px]"
          style={{
            background: "var(--color-page-surface-dim)",
            border: "1px solid var(--color-page-border)",
            color: "var(--color-page-text)",
          }}
          aria-hidden="true"
        >
          {icon}
        </span>
        <span
          class="text-[12px] font-semibold leading-tight"
          style={{ color: "var(--color-page-text)" }}
        >
          {name}
        </span>
        <span
          class="mt-1 text-[10px] uppercase tracking-wider"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {detail}
        </span>
      </div>
    </div>
  );
}

export function SkillsGraphic() {
  const included = [
    { label: "Instructions", value: "Triage new issues" },
    { label: "Tools", value: "GitHub MCP + gh" },
    { label: "Network", value: "api.github.com" },
    { label: "Policy", value: "Approve comments" },
  ];

  return (
    <div class="w-full max-w-md flex flex-col gap-3">
      <div
        class="rounded-xl bg-[var(--color-page-surface)] shadow-sm overflow-hidden"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div
          class="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--color-page-border)" }}
        >
          <div class="flex items-center gap-3">
            <span
              class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[16px]"
              style={{
                background: "rgba(var(--color-tg-accent-rgb), 0.08)",
                border: "1px solid rgba(var(--color-tg-accent-rgb), 0.22)",
              }}
              aria-hidden="true"
            >
              ⚡
            </span>
            <div>
              <div
                class="text-[14px] font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                GitHub triage skill
              </div>
              <div
                class="text-[11px]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Packaged capability
              </div>
            </div>
          </div>
          <span
            class="rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              background: "var(--color-page-surface-dim)",
              border: "1px solid var(--color-page-border)",
              color: "var(--color-page-text-muted)",
            }}
          >
            Installed
          </span>
        </div>

        <div class="p-4">
          <p
            class="mb-4 text-[13px] leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Give agents issue intake, owner routing, and safe GitHub actions in
            one reusable bundle.
          </p>
          <div class="grid grid-cols-2 gap-2">
            {included.map((item) => (
              <div
                key={item.label}
                class="rounded-lg px-3 py-2"
                style={{
                  background: "var(--color-page-surface-dim)",
                  border: "1px solid var(--color-page-border)",
                }}
              >
                <div
                  class="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {item.label}
                </div>
                <div
                  class="mt-1 text-[12px] font-medium leading-snug"
                  style={{ color: "var(--color-page-text)" }}
                >
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2">
        {[
          { icon: "📄", label: "Contract review" },
          { icon: "💬", label: "Support desk" },
          { icon: "📈", label: "Revenue research" },
        ].map((skill) => (
          <div
            key={skill.label}
            class="rounded-lg px-3 py-3 text-center"
            style={{
              background: "var(--color-page-bg)",
              border: "1px solid var(--color-page-border)",
            }}
          >
            <div class="text-[16px]" aria-hidden="true">
              {skill.icon}
            </div>
            <div
              class="mt-2 text-[11px] font-medium leading-tight"
              style={{ color: "var(--color-page-text)" }}
            >
              {skill.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
