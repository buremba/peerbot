type TermLink = { label: string; href: string; selected?: boolean };

type TermLine = {
  text: string;
  color: string;
  links?: TermLink[];
};

const initLines: TermLine[] = [
  { text: "$ lobu init landing-demo-agent", color: "#4ade80" },
  { text: "", color: "" },
  { text: "🤖 Welcome to Lobu!", color: "#facc15" },
  { text: "", color: "" },
  {
    text: "? Deployment type?",
    color: "#c9cdd4",
    links: [
      { label: "Embedded", href: "/deployment/embedding/", selected: true },
      { label: "Docker", href: "/deployment/docker/" },
      { label: "Kubernetes", href: "/deployment/kubernetes/" },
    ],
  },
  {
    text: "? Worker network access?",
    color: "#c9cdd4",
    links: [{ label: "Restricted", href: "/guides/security/", selected: true }],
  },
  {
    text: "? AI provider?",
    color: "#c9cdd4",
    links: [
      {
        label: "Claude Sonnet 4 via Anthropic",
        href: "/reference/providers/",
        selected: true,
      },
    ],
  },
  {
    text: "? Skills / MCPs?",
    color: "#c9cdd4",
    links: [
      { label: "GitHub", href: "/getting-started/skills/", selected: true },
      { label: "my-custom-mcp", href: "/getting-started/skills/" },
    ],
  },
  {
    text: "? Connect a messaging platform?",
    color: "#c9cdd4",
    links: [
      { label: "WhatsApp", href: "/platforms/whatsapp/", selected: true },
      { label: "Slack", href: "/platforms/slack/" },
      { label: "Discord", href: "/platforms/discord/" },
      { label: "Teams", href: "/platforms/teams/" },
      { label: "Google Chat", href: "/platforms/google-chat/" },
      { label: "Telegram", href: "/platforms/telegram/" },
    ],
  },
  {
    text: "? Memory?",
    color: "#c9cdd4",
    links: [
      { label: "Filesystem", href: "https://owletto.com", selected: true },
    ],
  },
  { text: "", color: "" },
  { text: "- Creating Lobu project...", color: "#8f96a3" },
  { text: "✔ Project created successfully!", color: "#4ade80" },
  { text: "", color: "" },
  { text: "✓ Lobu initialized!", color: "#4ade80" },
  { text: "", color: "" },
  { text: "Next steps:", color: "#facc15" },
  { text: "  cd landing-demo-agent", color: "#67e8f9" },
  { text: "  lobu run -d", color: "#67e8f9" },
];

const agentPrompt = [
  "I am building a Lobu agent in this repository.",
  "",
  "Please:",
  "1. Read AGENTS.md, lobu.toml, and agents/landing-demo-agent/{IDENTITY,SOUL,USER}.md first.",
  "2. Help me shape the agent behavior by editing those files directly.",
  "3. Use Lobu skills when they make sense: https://lobu.ai/getting-started/skills/",
  "4. Suggest any provider, skill, or connection changes needed in lobu.toml.",
  "5. Keep the project runnable with `lobu run -d`.",
  "",
  "Explain what you change and why.",
].join("\n");

const embedSnippet = [
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
].join("\n");

const selfHostSnippet = [
  "$ cd landing-demo-agent",
  "$ lobu run -d",
  "# iterate locally",
  "",
  "$ docker compose up -d",
  "# or deploy the same stack on Kubernetes",
].join("\n");

function WindowChrome({ label }: { label: string }) {
  return (
    <div
      class="flex items-center gap-2 px-3.5 py-2.5 min-w-0"
      style={{ backgroundColor: "#0b0c0f" }}
    >
      <div class="flex items-center gap-1.5 mr-3">
        <span
          class="w-3 h-3 rounded-full"
          style={{ backgroundColor: "#ff5f57" }}
        />
        <span
          class="w-3 h-3 rounded-full"
          style={{ backgroundColor: "#febc2e" }}
        />
        <span
          class="w-3 h-3 rounded-full"
          style={{ backgroundColor: "#28c840" }}
        />
      </div>
      <span
        class="px-2.5 py-1 rounded-md text-[11px] min-w-0 max-w-full truncate"
        style={{ backgroundColor: "#23262d", color: "#c9cdd4" }}
      >
        {label}
      </span>
    </div>
  );
}

function TermLinkPill({ link }: { link: TermLink }) {
  return (
    <a
      href={link.href}
      target={link.href.startsWith("http") ? "_blank" : undefined}
      rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
      class="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-70 no-underline"
      style={
        link.selected
          ? {
              backgroundColor: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "var(--color-tg-accent)",
            }
          : {
              backgroundColor: "transparent",
              border: "1px solid rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.3)",
            }
      }
    >
      {link.label}
    </a>
  );
}

function TerminalWindow({
  label,
  lines,
}: {
  label: string;
  lines: TermLine[];
}) {
  return (
    <div
      class="rounded-[18px] overflow-hidden min-w-0"
      style={{
        border: "1px solid #23262d",
        backgroundColor: "#0b0c0f",
      }}
    >
      <WindowChrome label={label} />
      <div
        class="px-3.5 pb-3.5 pt-1 font-mono text-[11px] sm:text-[12px] text-left min-w-0 overflow-x-auto"
        style={{ backgroundColor: "#0b0c0f" }}
      >
        {(() => {
          const lineKeyCounts = new Map<string, number>();
          return lines.map((line) => {
            const baseKey = `${line.text}:${line.links?.map((link) => link.label).join(",") ?? ""}`;
            const occurrence = (lineKeyCounts.get(baseKey) ?? 0) + 1;
            lineKeyCounts.set(baseKey, occurrence);
            const key = `${baseKey}:${occurrence}`;

            return line.text === "" ? (
              <div key={key} class="h-3" />
            ) : (
              <div
                key={key}
                class={`break-words whitespace-pre-wrap flex items-baseline gap-1.5 flex-wrap leading-[1.7] ${line.links ? "mt-2 first:mt-0" : ""}`}
                style={{ color: line.color }}
              >
                <span>{line.text}</span>
                {line.links?.map((link) => (
                  <TermLinkPill key={link.label} link={link} />
                ))}
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

function PromptWindow({ label, prompt }: { label: string; prompt: string }) {
  return (
    <div
      class="rounded-[18px] overflow-hidden min-w-0"
      style={{
        border: "1px solid #23262d",
        backgroundColor: "#0b0c0f",
      }}
    >
      <div
        class="flex items-center justify-between gap-3 px-3.5 py-2.5 min-w-0"
        style={{ backgroundColor: "#0b0c0f" }}
      >
        <span
          class="flex-1 min-w-0 px-2.5 py-1 rounded-md text-[11px] truncate"
          style={{ backgroundColor: "#23262d", color: "#c9cdd4" }}
        >
          {label}
        </span>
        <button
          type="button"
          class="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-opacity hover:opacity-80"
          style={{
            backgroundColor: "#23262d",
            color: "#c9cdd4",
          }}
          onClick={() => {
            navigator.clipboard.writeText(prompt).catch(() => undefined);
          }}
        >
          Copy
        </button>
      </div>
      <pre
        class="px-3.5 pb-3.5 pt-2 m-0 font-mono text-[11px] sm:text-[12px] leading-[1.7] overflow-x-auto whitespace-pre-wrap break-words text-left"
        style={{ color: "#c9cdd4", backgroundColor: "#0b0c0f" }}
      >
        {prompt}
      </pre>
    </div>
  );
}

function SectionIntro({
  step,
  title,
  body,
}: {
  step: string;
  title: string;
  body: string;
}) {
  return (
    <div class="mb-5">
      <div
        class="text-[11px] font-semibold uppercase tracking-[0.24em] mb-2"
        style={{ color: "var(--color-tg-accent)" }}
      >
        {step}
      </div>
      <h3
        class="text-xl sm:text-2xl font-bold tracking-tight mb-2"
        style={{ color: "var(--color-page-text)" }}
      >
        {title}
      </h3>
      <p
        class="text-sm leading-relaxed"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {body}
      </p>
    </div>
  );
}

function ShipCard({
  title,
  description,
  code,
  href,
}: {
  title: string;
  description: string;
  code: string;
  href: string;
}) {
  return (
    <div
      class="rounded-xl p-6 h-full"
      style={{
        backgroundColor: "var(--color-page-bg-elevated)",
        border: "1px solid var(--color-page-border)",
      }}
    >
      <h4
        class="text-lg font-semibold mb-2"
        style={{ color: "var(--color-page-text)" }}
      >
        {title}
      </h4>
      <p
        class="text-sm leading-relaxed mb-4"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {description}
      </p>
      <div
        class="rounded-lg overflow-hidden font-mono text-[12px] leading-[1.7] mb-4"
        style={{
          backgroundColor: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <pre
          class="p-3.5 m-0 overflow-x-auto whitespace-pre-wrap break-words"
          style={{ color: "rgba(255,255,255,0.78)" }}
        >
          {code}
        </pre>
      </div>
      <a
        href={href}
        class="text-xs font-medium transition-opacity hover:opacity-80"
        style={{ color: "var(--color-tg-accent)" }}
      >
        Learn more →
      </a>
    </div>
  );
}

export function DemoSection() {
  return (
    <section id="how-it-works" class="py-14 px-8">
      <div class="w-full max-w-[64rem] mx-auto px-6 lg:px-8 box-border">
        <div class="max-w-3xl mx-auto text-center mb-12">
          <h2
            class="text-2xl sm:text-3xl font-bold tracking-tight mb-3"
            style={{ color: "var(--color-page-text)" }}
          >
            How it works
          </h2>
          <p
            class="text-sm leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Scaffold a Lobu project, hand it to your favorite coding agent, and
            then either embed it in your product or ship it as its own app.
          </p>
        </div>

        <div class="space-y-10">
          <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6 items-start">
            <div class="min-w-0">
              <SectionIntro
                step="01"
                title="Initialize the project"
                body="Start with the CLI and make the key choices once: runtime, network policy, provider, messaging channel, and memory. Embedded is the default local path, but the same project can move to Docker or Kubernetes later."
              />
            </div>
            <TerminalWindow
              label="lobu init landing-demo-agent"
              lines={initLines}
            />
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6 items-start">
            <div class="min-w-0">
              <SectionIntro
                step="02"
                title="Add capabilities to your agent"
                body="Open Claude Code, Codex, OpenCode, or any coding agent, point it at the generated Lobu project, and paste a Lobu-specific prompt. That gives the agent the right files and workflow to iterate on."
              />
              <p
                class="text-sm leading-relaxed"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Start with the{" "}
                <a
                  href="/getting-started/skills/"
                  class="underline decoration-dotted underline-offset-2 hover:opacity-80"
                  style={{ color: "var(--color-tg-accent)" }}
                >
                  Lobu skills docs
                </a>{" "}
                and paste the prompt on the right into your agent.
              </p>
            </div>
            <PromptWindow label="paste into your agent" prompt={agentPrompt} />
          </div>

          <div>
            <SectionIntro
              step="03"
              title="Ship it the way you want"
              body="When the agent is ready, keep the same Lobu project and choose the runtime model that fits your product."
            />
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <ShipCard
                title="Embed with TypeScript"
                description="Mount Lobu inside Next.js, Express, Hono, Fastify, or any Node.js framework. Works anywhere that speaks Web Standard Request/Response."
                code={embedSnippet}
                href="/deployment/embedding/"
              />
              <ShipCard
                title="Run it on your infra"
                description="Use the same project and run the stack on Docker or Kubernetes when Lobu should ship as its own app or service."
                code={selfHostSnippet}
                href="/deployment/docker/"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
