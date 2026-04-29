const localDev = {
  id: "dev",
  label: "Local Dev",
  badges: ["CLI scaffold", "Single Node process", "Fastest setup"],
  docsHref: "/getting-started/",
  steps: [
    {
      label: "Scaffold a new agent",
      code: "npx @lobu/cli@latest init my-agent",
    },
    {
      label: "Set DATABASE_URL in .env, then boot",
      code: "cd my-agent && npx @lobu/cli@latest run",
    },
    { label: "Open the docs", code: "open http://localhost:8080/api/docs" },
  ],
};

type Mode = typeof localDev;

export const modes = [localDev];

export function ModeCard({ mode }: { mode: Mode }) {
  return (
    <div
      class="rounded-xl p-6 min-w-0"
      style={{
        backgroundColor: "var(--color-page-bg-elevated)",
        border: "1px solid var(--color-page-border)",
      }}
    >
      <div class="flex items-center justify-between mb-4">
        <h3
          class="text-lg font-semibold"
          style={{ color: "var(--color-page-text)" }}
        >
          {mode.label}
        </h3>
        <a
          href={mode.docsHref}
          class="text-xs font-medium hover:opacity-80 transition-opacity"
          style={{ color: "var(--color-tg-accent)" }}
        >
          Docs →
        </a>
      </div>

      <div class="flex flex-wrap gap-1.5 mb-5">
        {mode.badges.map((badge) => (
          <span
            key={badge}
            class="text-[11px] font-medium px-2 py-1 rounded-full"
            style={{
              color: "var(--color-page-text-muted)",
              backgroundColor: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
            }}
          >
            {badge}
          </span>
        ))}
      </div>

      <div class="space-y-3 mb-5">
        {mode.steps.map((step) => (
          <div key={`${mode.id}-${step.label}`}>
            <div
              class="text-[11px] font-medium mb-1.5"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {step.label}
            </div>
            <div
              class="rounded-lg overflow-hidden font-mono text-[12.5px] leading-[1.6] min-w-0"
              style={{
                backgroundColor: "rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <pre
                class="p-3.5 m-0 overflow-x-auto whitespace-pre-wrap break-words"
                style={{ color: "rgba(255,255,255,0.75)" }}
              >
                <span style={{ color: "var(--color-tg-accent)" }}>$</span>{" "}
                {step.code}
              </pre>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
