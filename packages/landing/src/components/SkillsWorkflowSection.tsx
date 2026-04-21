import { SectionHeader } from "./SectionHeader";
import {
  deliverySurfaces,
  messagingChannels,
  type DeliverySurface,
} from "./platforms";
import { ContentRail } from "./ContentRail";
import type {
  LandingUseCaseId,
  LandingUseCaseShowcase,
} from "../use-case-showcases";

type TermLink = { label: string; href: string; selected?: boolean };

type TermLine = {
  text: string;
  color: string;
  links?: TermLink[];
};

type UseCaseInitConfig = {
  selectedPlatform:
    | "slack"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "teams"
    | "google-chat";
  memory: "filesystem" | "owletto";
};

const useCaseInitOverrides: Partial<
  Record<LandingUseCaseId, Partial<UseCaseInitConfig>>
> = {
  sales: { memory: "owletto" },
  "agent-community": { memory: "owletto" },
  ecommerce: { memory: "owletto" },
};

const defaultInitConfig: UseCaseInitConfig = {
  selectedPlatform: "slack",
  memory: "filesystem",
};

function getInitConfig(
  useCase: LandingUseCaseShowcase
): UseCaseInitConfig & { agentName: string; skills: string[] } {
  const overrides = useCaseInitOverrides[useCase.id] ?? {};
  return {
    agentName: useCase.skills.agentId,
    skills: useCase.skills.skills,
    ...defaultInitConfig,
    ...overrides,
  };
}

function getInitLinesForUseCase(useCase: LandingUseCaseShowcase): TermLine[] {
  const config = getInitConfig(useCase);
  return [
    {
      text: `$ npx @lobu/cli@latest init ${config.agentName}`,
      color: "#4ade80",
    },
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
      links: [
        { label: "Restricted", href: "/guides/security/", selected: true },
      ],
    },
    {
      text: "? AI provider?",
      color: "#c9cdd4",
      links: [
        {
          label: "Claude Sonnet 4 via OpenRouter",
          href: "/reference/providers/",
          selected: true,
        },
      ],
    },
    {
      text: "? Skills / MCPs?",
      color: "#c9cdd4",
      links: config.skills.map((label, i) => ({
        label,
        href: "/getting-started/skills/",
        selected: i === 0,
      })),
    },
    {
      text: "? Connect a messaging platform?",
      color: "#c9cdd4",
      links: messagingChannels.map((channel) => ({
        label: channel.label,
        href: channel.href,
        selected: channel.id === config.selectedPlatform,
      })),
    },
    {
      text: "? Memory?",
      color: "#c9cdd4",
      links: [
        {
          label: "Filesystem",
          href: "/guides/agent-settings/#filesystem-memory-openclawnative-memory",
          selected: config.memory === "filesystem",
        },
        {
          label: "Owletto",
          href: `/memory/for/${useCase.id}`,
          selected: config.memory === "owletto",
        },
      ],
    },
    { text: "", color: "" },
    { text: "- Creating Lobu project...", color: "#8f96a3" },
    { text: "✔ Project created successfully!", color: "#4ade80" },
    { text: "", color: "" },
    { text: "✓ Lobu initialized!", color: "#4ade80" },
    { text: "", color: "" },
    { text: "Next steps:", color: "#facc15" },
    { text: `  cd ${config.agentName}`, color: "#67e8f9" },
    { text: "  npx @lobu/cli@latest run -d", color: "#67e8f9" },
  ];
}

const agentPrompt = [
  "I am building a Lobu agent in this repository.",
  "",
  "Please:",
  "1. Read AGENTS.md, lobu.toml, and agents/landing-demo-agent/{IDENTITY,SOUL,USER}.md first.",
  "2. Help me shape the agent behavior by editing those files directly.",
  "3. Use Lobu skills when they make sense: https://lobu.ai/getting-started/skills/",
  "4. Suggest any provider, skill, or connection changes needed in lobu.toml.",
  "5. Keep the project runnable with `npx @lobu/cli@latest run -d`.",
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

const testEvalLines: TermLine[] = [
  {
    text: '$ npx @lobu/cli@latest chat "Hello, what can you do?"',
    color: "#4ade80",
  },
  { text: "I can help with code reviews, manage GitHub", color: "#c9cdd4" },
  { text: "issues, and answer questions about your...", color: "#c9cdd4" },
  { text: "", color: "" },
  { text: "$ npx @lobu/cli@latest eval", color: "#4ade80" },
  { text: "", color: "" },
  { text: "Running 3 evals (9 trials)...", color: "#8f96a3" },
  { text: "", color: "" },
  { text: "  ping               3/3 passed  avg 0.95", color: "#4ade80" },
  { text: "  context-retention  3/3 passed  avg 0.88", color: "#4ade80" },
  { text: "  follows-instr.     2/3 passed  avg 0.76", color: "#facc15" },
  { text: "", color: "" },
  { text: "Overall: 89% pass rate", color: "#4ade80" },
  { text: "Report: evals/evals-report.md", color: "#8f96a3" },
];

const selfHostSnippet = [
  "$ cd landing-demo-agent",
  "$ npx @lobu/cli@latest run -d",
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
          style={{ backgroundColor: "#23262d", color: "#c9cdd4" }}
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

function DeliverySurfacePill({ surface }: { surface: DeliverySurface }) {
  return (
    <a
      href={surface.href}
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
      style={{
        color: "var(--color-page-text)",
        backgroundColor: "var(--color-page-surface-dim)",
        border: "1px solid var(--color-page-border)",
      }}
    >
      <span style={{ color: "var(--color-page-text-muted)" }}>
        {surface.renderIcon(12)}
      </span>
      <span>{surface.label}</span>
    </a>
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

export function SkillsWorkflowSection({
  activeUseCase,
}: {
  activeUseCase: LandingUseCaseShowcase;
}) {
  const initLines = getInitLinesForUseCase(activeUseCase);

  return (
    <section class="py-14">
      <ContentRail>
        <ContentRail variant="compact">
          <SectionHeader
            title="How it works"
            body="Scaffold a project, iterate with your coding agent, test it, and ship it."
            className="mb-12"
          />

          <div class="space-y-10">
            <div class="grid grid-cols-1 lg:grid-cols-[minmax(16rem,0.78fr)_minmax(24rem,1fr)] gap-6 items-start">
              <div class="min-w-0">
                <SectionIntro
                  step="01"
                  title="Initialize the project"
                  body="Start with the CLI and make the key choices once: runtime, network policy, provider, messaging channel, and memory. Embedded is the default local path, but the same project can move to Docker or Kubernetes later."
                />
              </div>
              <TerminalWindow
                label={`npx @lobu/cli@latest init ${activeUseCase.skills.agentId}`}
                lines={initLines}
              />
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-[minmax(16rem,0.78fr)_minmax(24rem,1fr)] gap-6 items-start">
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
              <PromptWindow
                label="paste into your agent"
                prompt={agentPrompt}
              />
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-[minmax(16rem,0.78fr)_minmax(24rem,1fr)] gap-6 items-start">
              <div class="min-w-0">
                <SectionIntro
                  step="03"
                  title="Test and evaluate"
                  body="Chat with your agent from the terminal, route test messages through supported chat platforms, and run automated evals to measure quality across models."
                />
                <p
                  class="text-sm leading-relaxed"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  See the{" "}
                  <a
                    href="/guides/testing/"
                    class="underline decoration-dotted underline-offset-2 hover:opacity-80"
                    style={{ color: "var(--color-tg-accent)" }}
                  >
                    Testing guide
                  </a>{" "}
                  and{" "}
                  <a
                    href="/guides/evals/"
                    class="underline decoration-dotted underline-offset-2 hover:opacity-80"
                    style={{ color: "var(--color-tg-accent)" }}
                  >
                    Evaluations guide
                  </a>
                  .
                </p>
              </div>
              <TerminalWindow label="test and evaluate" lines={testEvalLines} />
            </div>

            <div>
              <SectionIntro
                step="04"
                title="Ship it the way you want"
                body="When the agent is ready, keep the same Lobu project, choose the runtime model that fits your product, and deliver it over the channel your users already use."
              />
              <div class="flex flex-wrap gap-2 mb-5">
                {deliverySurfaces.map((surface) => (
                  <DeliverySurfacePill key={surface.label} surface={surface} />
                ))}
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ShipCard
                  title="Embed in your app"
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
        </ContentRail>
      </ContentRail>
    </section>
  );
}
