const localDev = {
  id: "dev",
  label: "Local Dev",
  badges: ["CLI scaffold", "Full stack", "Fastest setup"],
  docsHref: "/deployment/docker/",
  steps: [
    { label: "Scaffold a new agent", code: "npx @lobu/cli init my-agent" },
    { label: "Run the stack", code: "cd my-agent && npx @lobu/cli run -d" },
    { label: "Open the docs", code: "open http://localhost:8080/api/docs" },
  ],
};

const embedWithTypescript = {
  id: "embed",
  label: "Embed with TypeScript",
  badges: ["Next.js", "Express", "Hono", "Fastify", "Bun", "Deno"],
  docsHref: "/deployment/embedding/",
  steps: [
    {
      label: "Mount in Next.js App Router (or any framework)",
      code: [
        "// app/api/lobu/[...path]/route.ts",
        'import { Lobu } from "@lobu/gateway";',
        "",
        "const lobu = new Lobu({",
        "  redis: process.env.REDIS_URL!,",
        '  agents: [{ id: "support" }],',
        "});",
        "const ready = lobu.initialize();",
        "",
        "async function handler(req: Request) {",
        "  await ready;",
        "  return lobu.getApp().fetch(req);",
        "}",
        "export const GET = handler;",
        "export const POST = handler;",
      ].join("\n"),
    },
  ],
};

const selfHosted = {
  docker: {
    docsHref: "/deployment/docker/",
    steps: [
      {
        label: "Start the stack",
        code: "cd my-agent && docker compose up -d",
      },
    ],
  },
  kubernetes: {
    docsHref: "/deployment/kubernetes/",
    steps: [
      {
        label: "Install with Helm",
        code: `helm install lobu oci://ghcr.io/lobu-ai/charts/lobu \\
  --namespace lobu \\
  --create-namespace`,
      },
    ],
  },
};

export type Mode = typeof localDev;

export const modes = [localDev, embedWithTypescript];

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

function SelfHostSteps({ variant }: { variant: "docker" | "kubernetes" }) {
  const data = selfHosted[variant];
  return (
    <div class="space-y-3">
      {data.steps.map((step) => (
        <div key={`${variant}-${step.label}`}>
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
      <a
        href={data.docsHref}
        class="inline-block mt-2 text-xs font-medium hover:opacity-80 transition-opacity"
        style={{ color: "var(--color-tg-accent)" }}
      >
        Docs →
      </a>
    </div>
  );
}

function SelfHostCard() {
  return (
    <div
      class="selfhost-card rounded-xl p-6 min-w-0"
      style={{
        backgroundColor: "var(--color-page-bg-elevated)",
        border: "1px solid var(--color-page-border)",
      }}
    >
      <div class="flex items-center gap-3 mb-5">
        <h3
          class="text-lg font-semibold"
          style={{ color: "var(--color-page-text)" }}
        >
          Self-Host
        </h3>
        <div
          class="inline-flex rounded-lg p-0.5"
          style={{
            backgroundColor: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.09)",
          }}
        >
          <button
            type="button"
            class="selfhost-tab px-3 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer"
            style={{
              backgroundColor: "rgba(255,255,255,0.1)",
              color: "var(--color-page-text)",
            }}
            onClick={(e) => {
              const card = (e.target as HTMLElement).closest(".selfhost-card");
              if (!card) return;
              card.querySelectorAll(".selfhost-tab").forEach((t) => {
                (t as HTMLElement).style.backgroundColor = "transparent";
                (t as HTMLElement).style.color = "var(--color-page-text-muted)";
              });
              (e.target as HTMLElement).style.backgroundColor =
                "rgba(255,255,255,0.1)";
              (e.target as HTMLElement).style.color = "var(--color-page-text)";
              card
                .querySelector(".selfhost-docker")
                ?.classList.remove("hidden");
              card.querySelector(".selfhost-k8s")?.classList.add("hidden");
            }}
          >
            Docker
          </button>
          <button
            type="button"
            class="selfhost-tab px-3 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer"
            style={{
              backgroundColor: "transparent",
              color: "var(--color-page-text-muted)",
            }}
            onClick={(e) => {
              const card = (e.target as HTMLElement).closest(".selfhost-card");
              if (!card) return;
              card.querySelectorAll(".selfhost-tab").forEach((t) => {
                (t as HTMLElement).style.backgroundColor = "transparent";
                (t as HTMLElement).style.color = "var(--color-page-text-muted)";
              });
              (e.target as HTMLElement).style.backgroundColor =
                "rgba(255,255,255,0.1)";
              (e.target as HTMLElement).style.color = "var(--color-page-text)";
              card.querySelector(".selfhost-docker")?.classList.add("hidden");
              card.querySelector(".selfhost-k8s")?.classList.remove("hidden");
            }}
          >
            Kubernetes
          </button>
        </div>
      </div>

      <div class="selfhost-docker">
        <SelfHostSteps variant="docker" />
      </div>
      <div class="selfhost-k8s hidden">
        <SelfHostSteps variant="kubernetes" />
      </div>
    </div>
  );
}

export function InstallSection() {
  return (
    <section id="get-started" class="py-12 px-8">
      <div class="max-w-4xl mx-auto">
        <h2
          class="text-2xl sm:text-3xl font-bold text-center mb-3 tracking-tight"
          style={{ color: "var(--color-page-text)" }}
        >
          Choose your production path
        </h2>
        <p
          class="text-sm text-center mb-10 max-w-lg mx-auto"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Start locally, then either run Lobu on your own infrastructure or
          embed it inside your product with TypeScript.
        </p>

        <div class="mb-6">
          <ModeCard mode={localDev} />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SelfHostCard />
          <ModeCard mode={embedWithTypescript} />
        </div>
      </div>
    </section>
  );
}
