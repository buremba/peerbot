import { messagingChannels } from "./platforms";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

const chipIcons: Record<string, JSX.Element> = {
  "GitHub MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=github.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Gmail MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=mail.google.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Google Calendar MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=calendar.google.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Linear MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=linear.app&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Notion MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=notion.so&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Slack MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=slack.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Stripe MCP": (
    <img
      src="https://www.google.com/s2/favicons?domain=stripe.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Custom MCP": (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M3 5.75A2.75 2.75 0 0 1 5.75 3h12.5A2.75 2.75 0 0 1 21 5.75v12.5A2.75 2.75 0 0 1 18.25 21H5.75A2.75 2.75 0 0 1 3 18.25zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v12.5c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25V5.75c0-.69-.56-1.25-1.25-1.25zm1.5 6.75a.75.75 0 0 1 .75-.75h2.25V8.25a.75.75 0 0 1 1.5 0v2.25h2.25a.75.75 0 0 1 0 1.5h-2.25v2.25a.75.75 0 0 1-1.5 0V12H8a.75.75 0 0 1-.75-.75z" />
    </svg>
  ),
  OpenAI: (
    <img
      src="https://www.google.com/s2/favicons?domain=openai.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  Groq: (
    <img
      src="https://www.google.com/s2/favicons?domain=groq.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  Gemini: (
    <img
      src="https://www.google.com/s2/favicons?domain=ai.google.dev&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Together AI": (
    <img
      src="https://www.google.com/s2/favicons?domain=together.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "NVIDIA NIM": (
    <img
      src="https://www.google.com/s2/favicons?domain=nvidia.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "z.ai": (
    <img
      src="https://www.google.com/s2/favicons?domain=z.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "Fireworks AI": (
    <img
      src="https://www.google.com/s2/favicons?domain=fireworks.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  Mistral: (
    <img
      src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  DeepSeek: (
    <img
      src="https://www.google.com/s2/favicons?domain=deepseek.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  OpenRouter: (
    <img
      src="https://www.google.com/s2/favicons?domain=openrouter.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  Cerebras: (
    <img
      src="https://www.google.com/s2/favicons?domain=cerebras.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  "OpenCode Zen": (
    <img
      src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  xAI: (
    <img
      src="https://www.google.com/s2/favicons?domain=x.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  Perplexity: (
    <img
      src="https://www.google.com/s2/favicons?domain=perplexity.ai&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  Cohere: (
    <img
      src="https://www.google.com/s2/favicons?domain=cohere.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
  ElevenLabs: (
    <img
      src="https://www.google.com/s2/favicons?domain=elevenlabs.io&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  ),
};

const verticals = [
  {
    name: "Legal",
    description: "Draft contracts, search case law, review clauses",
    skills: ["westlaw-mcp", "contract-drafter", "case-search"],
  },
  {
    name: "DevOps",
    description: "Triage PRs, manage incidents, deploy services",
    skills: ["github-mcp", "pagerduty-mcp", "k8s-tools"],
  },
  {
    name: "Support",
    description: "Route tickets, draft responses, escalate issues",
    skills: ["zendesk-mcp", "knowledge-base", "sentiment"],
  },
  {
    name: "Finance",
    description: "Reconcile accounts, generate reports, flag anomalies",
    skills: ["quickbooks-mcp", "stripe-mcp", "csv-tools"],
  },
];

const anatomy = [
  {
    label: "System Packages",
    description:
      "Declare Nix packages your skill needs (ffmpeg, poppler, gh, ripgrep). Installed once, persisted across sessions. Your agent gets a real Linux environment.",
    badge: "nix",
    color: "bg-cyan-900/40 text-cyan-400 border-cyan-800/50",
  },
  {
    label: "Network Policy",
    description:
      "Agents start with zero internet access. Skills declare exactly which domains are allowed — nothing else gets through.",
    badge: "network",
    color: "bg-red-900/40 text-red-400 border-red-800/50",
  },
  {
    label: "Tool Permissions",
    description:
      "Allowlist and denylist which tools the agent can use. Bash commands, file operations, MCP tools — all scoped per skill.",
    badge: "permissions",
    color: "bg-purple-900/40 text-purple-400 border-purple-800/50",
  },
  {
    label: "MCP Servers",
    description:
      "Connect to external APIs via MCP. Auth is handled by the gateway — workers never see real credentials.",
    badge: "mcp",
    color: "bg-blue-900/40 text-blue-400 border-blue-800/50",
  },
  {
    label: "Integrations",
    description:
      "OAuth and API-key authenticated services. Users connect their own accounts via the settings page.",
    badge: "api",
    color: "bg-amber-900/40 text-amber-400 border-amber-800/50",
  },
  {
    label: "Instructions",
    description:
      "System prompt, behavioral rules, and domain knowledge. The markdown body of SKILL.md becomes the agent's persona.",
    badge: "prompt",
    color: "bg-green-900/40 text-green-400 border-green-800/50",
  },
];

const k = { color: "#7dcfff" }; // keys
const s = { color: "#9ece6a" }; // strings
const d = { color: "#565f89" }; // delimiters / muted
const o = { color: "#ff9e64" }; // booleans / special
const h = { color: "#c0caf5" }; // headings
const m = { color: "#9aa5ce" }; // body text

function SkillYaml() {
  return (
    <pre
      class="p-4 text-[11px] leading-relaxed font-mono overflow-x-auto m-0"
      style={{ backgroundColor: "rgba(0,0,0,0.3)", color: "#9aa5ce" }}
    >
      <code>
        <span style={d}>---</span>
        {"\n"}
        <span style={k}>name</span>: <span style={s}>ops-triage</span>
        {"\n"}
        <span style={k}>description</span>:{" "}
        <span style={s}>Triage inbox, PRs, and issues</span>
        {"\n"}
        <span style={k}>nixPackages</span>: <span style={d}>[</span>
        <span style={s}>jq</span>, <span style={s}>gh</span>,{" "}
        <span style={s}>ripgrep</span>
        <span style={d}>]</span>
        {"\n"}
        {"\n"}
        <span style={k}>network</span>:{"\n"}
        {"  "}
        <span style={k}>allow</span>:{"\n"}
        {"    "}- <span style={s}>api.github.com</span>
        {"\n"}
        {"    "}- <span style={s}>gmail.googleapis.com</span>
        {"\n"}
        {"    "}- <span style={s}>.linear.app</span>
        {"\n"}
        {"\n"}
        <span style={k}>permissions</span>:{"\n"}
        {"  "}
        <span style={k}>allow</span>:{"\n"}
        {"    "}- <span style={s}>Read</span>
        {"\n"}
        {"    "}- <span style={s}>Bash(git:*)</span>
        {"\n"}
        {"    "}- <span style={s}>mcp__github__*</span>
        {"\n"}
        {"  "}
        <span style={k}>deny</span>:{"\n"}
        {"    "}- <span style={s}>Bash(rm:*)</span>
        {"\n"}
        {"    "}- <span style={s}>DeleteFile</span>
        {"\n"}
        {"\n"}
        <span style={k}>mcpServers</span>:{"\n"}
        {"  "}
        <span style={k}>github-mcp</span>:{"\n"}
        {"    "}
        <span style={k}>url</span>:{" "}
        <span style={s}>https://github-mcp.example.com</span>
        {"\n"}
        {"    "}
        <span style={k}>type</span>: <span style={s}>sse</span>
        {"\n"}
        <span style={d}>---</span>
        {"\n"}
        {"\n"}
        <span style={h}># Ops Triage</span>
        {"\n"}
        {"\n"}
        <span style={m}>Prioritize by severity. Summarize blockers</span>
        {"\n"}
        <span style={m}>first, then open reviews.</span>
        {"\n"}
        {"\n"}
        <span style={h}>## Behavior</span>
        {"\n"}
        <span style={m}>- Check inbox for urgent emails</span>
        {"\n"}
        <span style={m}>- Review open PRs and flag blockers</span>
        {"\n"}
        <span style={m}>- Summarize Linear issues by priority</span>
        {"\n"}
        {"\n"}
        <span style={h}>## Rules</span>
        {"\n"}
        <span style={m}>- Never auto-close issues without approval</span>
        {"\n"}
        <span style={m}>- Always include links to source threads</span>
        {"\n"}
        <span style={m}>- Escalate P0 issues immediately</span>
      </code>
    </pre>
  );
}

function LobuTomlExample() {
  return (
    <pre
      class="p-4 text-[11px] leading-relaxed font-mono overflow-x-auto m-0"
      style={{ backgroundColor: "rgba(0,0,0,0.3)", color: "#9aa5ce" }}
    >
      <code>
        <span style={d}>[</span>
        <span style={k}>agents.acme-support</span>
        <span style={d}>]</span>
        {"\n"}
        <span style={k}>name</span>
        {" = "}
        <span style={s}>"acme-support"</span>
        {"\n"}
        <span style={k}>description</span>
        {" = "}
        <span style={s}>"Customer support agent for Acme Corp"</span>
        {"\n"}
        <span style={k}>dir</span>
        {" = "}
        <span style={s}>"./agents/acme-support"</span>
        {"\n\n"}
        <span style={d}>{"# LLM providers (order = priority)"}</span>
        {"\n"}
        <span style={d}>[[</span>
        <span style={k}>agents.acme-support.providers</span>
        <span style={d}>]]</span>
        {"\n"}
        <span style={k}>id</span>
        {" = "}
        <span style={s}>"groq"</span>
        {"\n"}
        <span style={k}>key</span>
        {" = "}
        <span style={s}>"$GROQ_API_KEY"</span>
        {"\n\n"}
        <span style={d}>[[</span>
        <span style={k}>agents.acme-support.providers</span>
        <span style={d}>]]</span>
        {"\n"}
        <span style={k}>id</span>
        {" = "}
        <span style={s}>"gemini"</span>
        {"\n"}
        <span style={k}>key</span>
        {" = "}
        <span style={s}>"$GEMINI_API_KEY"</span>
        {"\n\n"}
        <span style={d}>{"# Platform connection"}</span>
        {"\n"}
        <span style={d}>[[</span>
        <span style={k}>agents.acme-support.connections</span>
        <span style={d}>]]</span>
        {"\n"}
        <span style={k}>type</span>
        {" = "}
        <span style={s}>"telegram"</span>
        {"\n"}
        <span style={d}>[</span>
        <span style={k}>agents.acme-support.connections.config</span>
        <span style={d}>]</span>
        {"\n"}
        <span style={k}>botToken</span>
        {" = "}
        <span style={s}>"$TELEGRAM_BOT_TOKEN"</span>
        {"\n\n"}
        <span style={d}>{"# Skills from the registry"}</span>
        {"\n"}
        <span style={d}>[</span>
        <span style={k}>agents.acme-support.skills</span>
        <span style={d}>]</span>
        {"\n"}
        <span style={k}>enabled</span>
        {" = "}
        <span style={d}>[</span>
        <span style={s}>"github"</span>
        <span style={d}>,</span> <span style={s}>"google-workspace"</span>
        <span style={d}>]</span>
        {"\n\n"}
        <span style={d}>{"# Custom MCP server"}</span>
        {"\n"}
        <span style={d}>[</span>
        <span style={k}>agents.acme-support.skills.mcp.my-kb</span>
        <span style={d}>]</span>
        {"\n"}
        <span style={k}>url</span>
        {" = "}
        <span style={s}>"https://mcp.acme.com/sse"</span>
        {"\n\n"}
        <span style={d}>{"# Network sandbox"}</span>
        {"\n"}
        <span style={d}>[</span>
        <span style={k}>agents.acme-support.network</span>
        <span style={d}>]</span>
        {"\n"}
        <span style={k}>allowed</span>
        {" = "}
        <span style={d}>[</span>
        <span style={s}>"api.github.com"</span>
        <span style={d}>,</span> <span style={s}>"registry.npmjs.org"</span>
        <span style={d}>]</span>
      </code>
    </pre>
  );
}

export function SkillsSection() {
  return (
    <section class="pt-28 pb-16 px-8">
      <div class="max-w-3xl mx-auto">
        {/* Hero */}
        <div class="text-center mb-16">
          <h1
            class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5"
            style={{ color: "var(--color-page-text)" }}
          >
            Build reproducible{" "}
            <span style={{ color: "var(--color-tg-accent)" }}>Lobu skills</span>
          </h1>
          <p
            class="text-lg max-w-xl mx-auto mb-8 leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            A skill isn't a prompt template — it's a full sandboxed computer.
            System packages, network policies, tool permissions, MCP servers,
            and integrations, all bundled into one installable unit.
          </p>
        </div>

        {/* Agent project structure */}
        <div class="mb-16">
          <h2
            class="text-xl font-bold mb-2 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            Define your agent in files
          </h2>
          <p
            class="text-sm text-center mb-8 max-w-lg mx-auto"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Each skill declares its own packages, network access, tool
            permissions, and auth — the platform provisions a matching sandbox
            automatically.
          </p>

          {/* Unified block */}
          <div
            class="rounded-xl overflow-hidden mb-6"
            style={{ border: "1px solid var(--color-page-border)" }}
          >
            {/* Top: IDENTITY.md, SOUL.md, USER.md cards */}
            <div
              class="grid grid-cols-1 sm:grid-cols-3"
              style={{ borderBottom: "1px solid var(--color-page-border)" }}
            >
              {[
                {
                  file: "IDENTITY.md",
                  desc: "Who the agent is — persona, name, tone.",
                  badge: "identity",
                  color: "bg-cyan-900/40 text-cyan-400 border-cyan-800/50",
                },
                {
                  file: "SOUL.md",
                  desc: "Behavior rules. What the agent should always or never do.",
                  badge: "rules",
                  color:
                    "bg-purple-900/40 text-purple-400 border-purple-800/50",
                },
                {
                  file: "USER.md",
                  desc: "User-specific context — timezone, preferences.",
                  badge: "context",
                  color: "bg-green-900/40 text-green-400 border-green-800/50",
                },
              ].map((item, i) => (
                <div
                  key={item.file}
                  class="p-5"
                  style={{
                    backgroundColor: "var(--color-page-bg-elevated)",
                    borderRight:
                      i < 2 ? "1px solid var(--color-page-border)" : undefined,
                  }}
                >
                  <div class="flex items-center gap-2 mb-2">
                    <span
                      class={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${item.color}`}
                    >
                      {item.badge}
                    </span>
                    <h3
                      class="text-sm font-semibold font-mono"
                      style={{ color: "var(--color-page-text)" }}
                    >
                      {item.file}
                    </h3>
                  </div>
                  <p
                    class="text-xs leading-relaxed"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>

            {/* Bottom: lobu.toml (left) + skills/*.md (right) */}
            <div class="grid grid-cols-1 md:grid-cols-2">
              {/* lobu.toml */}
              <div
                style={{
                  borderRight: "1px solid var(--color-page-border)",
                }}
              >
                <div
                  class="p-5"
                  style={{
                    backgroundColor: "var(--color-page-bg-elevated)",
                    borderBottom: "1px solid var(--color-page-border)",
                  }}
                >
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-[10px] font-medium px-2 py-0.5 rounded-full border bg-amber-900/40 text-amber-400 border-amber-800/50">
                      config
                    </span>
                    <h3
                      class="text-sm font-semibold font-mono"
                      style={{ color: "var(--color-page-text)" }}
                    >
                      lobu.toml
                    </h3>
                  </div>
                  <p
                    class="text-xs leading-relaxed"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    Providers, skills, network policy, platforms.
                  </p>
                </div>
                <LobuTomlExample />
              </div>

              {/* skills/*.md */}
              <div>
                <div
                  class="p-5"
                  style={{
                    backgroundColor: "var(--color-page-bg-elevated)",
                    borderBottom: "1px solid var(--color-page-border)",
                  }}
                >
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-[10px] font-medium px-2 py-0.5 rounded-full border bg-blue-900/40 text-blue-400 border-blue-800/50">
                      skills
                    </span>
                    <h3
                      class="text-sm font-semibold font-mono"
                      style={{ color: "var(--color-page-text)" }}
                    >
                      skills/ops-triage/SKILL.md
                    </h3>
                  </div>
                  <p
                    class="text-xs leading-relaxed"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    Third-party app integrations, MCP, and sandbox config.
                  </p>
                </div>
                <SkillYaml />
              </div>
            </div>
          </div>

          <div class="text-center">
            <div
              class="inline-flex flex-wrap items-center gap-4 text-xs"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              <code
                class="text-[11px] px-2 py-1 rounded"
                style={{ backgroundColor: "var(--color-page-surface-dim)" }}
              >
                npx @lobu/cli run
              </code>
              <span>Run locally</span>
            </div>
          </div>
        </div>

        {/* Anatomy of a skill */}
        <div class="mb-16">
          <h2
            class="text-xl font-bold mb-6 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            A skill is a full computer
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {anatomy.map((item) => (
              <div
                key={item.label}
                class="rounded-xl p-5"
                style={{
                  backgroundColor: "var(--color-page-bg-elevated)",
                  border: "1px solid var(--color-page-border)",
                }}
              >
                <div class="flex items-center gap-2 mb-2">
                  <span
                    class={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${item.color}`}
                  >
                    {item.badge}
                  </span>
                  <h3
                    class="text-sm font-semibold"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    {item.label}
                  </h3>
                </div>
                <p
                  class="text-xs leading-relaxed"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Verticals */}
        <div class="mb-16">
          <h2
            class="text-xl font-bold mb-2 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            Any vertical, one platform
          </h2>
          <p
            class="text-sm text-center mb-8 max-w-lg mx-auto"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Build skills for your domain and ship them on Lobu. Users get a
            ready-made agent without touching infrastructure.
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {verticals.map((v) => (
              <div
                key={v.name}
                class="rounded-xl p-5"
                style={{
                  backgroundColor: "var(--color-page-bg-elevated)",
                  border: "1px solid var(--color-page-border)",
                }}
              >
                <h3
                  class="text-sm font-semibold mb-1"
                  style={{ color: "var(--color-page-text)" }}
                >
                  {v.name}
                </h3>
                <p
                  class="text-xs mb-3 leading-relaxed"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {v.description}
                </p>
                <div class="flex flex-wrap gap-1.5">
                  {v.skills.map((s) => (
                    <span
                      key={s}
                      class="text-[10px] font-mono px-2 py-0.5 rounded"
                      style={{
                        backgroundColor: "var(--color-page-surface-dim)",
                        color: "var(--color-page-text-muted)",
                        border: "1px solid var(--color-page-border)",
                      }}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Built-in Registry */}
        <div class="mb-16">
          <h2
            class="text-xl font-bold mb-2 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            Built-in registry
          </h2>
          <p
            class="text-sm text-center mb-8 max-w-lg mx-auto"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            System skills ship with every agent. Additional skills are
            configured via{" "}
            <code
              class="text-[11px] px-1 py-0.5 rounded"
              style={{ backgroundColor: "var(--color-page-surface-dim)" }}
            >
              lobu.toml
            </code>
            .
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div
              class="rounded-xl p-5"
              style={{
                backgroundColor: "var(--color-page-bg-elevated)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <div class="flex items-center gap-2 mb-3">
                <h3
                  class="text-sm font-semibold"
                  style={{ color: "var(--color-page-text)" }}
                >
                  MCP Servers
                </h3>
              </div>
              <p
                class="text-xs mb-3 leading-relaxed"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Use any MCP server. Lobu works with built-in registry MCPs and
                your own custom MCP endpoints.
              </p>
              <div class="flex flex-wrap gap-1.5">
                {[
                  "GitHub MCP",
                  "Gmail MCP",
                  "Google Calendar MCP",
                  "Linear MCP",
                  "Notion MCP",
                  "Slack MCP",
                  "Stripe MCP",
                  "Custom MCP",
                ].map((name) => (
                  <span
                    key={name}
                    class="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded"
                    style={{
                      backgroundColor: "var(--color-page-surface-dim)",
                      color: "var(--color-page-text-muted)",
                      border: "1px solid var(--color-page-border)",
                    }}
                  >
                    <span class="shrink-0" aria-hidden="true">
                      {chipIcons[name]}
                    </span>
                    {name}
                  </span>
                ))}
              </div>
            </div>
            <div
              class="rounded-xl p-5"
              style={{
                backgroundColor: "var(--color-page-bg-elevated)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <div class="flex items-center gap-2 mb-3">
                <h3
                  class="text-sm font-semibold"
                  style={{ color: "var(--color-page-text)" }}
                >
                  Memory
                </h3>
              </div>
              <div class="flex flex-wrap gap-1.5">
                {["Filesystem", "Owletto"].map((name) => (
                  <span
                    key={name}
                    class="text-[10px] font-mono px-2 py-0.5 rounded"
                    style={{
                      backgroundColor: "var(--color-page-surface-dim)",
                      color: "var(--color-page-text-muted)",
                      border: "1px solid var(--color-page-border)",
                    }}
                  >
                    {name}
                  </span>
                ))}
              </div>
              <div class="mt-4">
                <h3
                  class="text-sm font-semibold mb-4"
                  style={{ color: "var(--color-page-text)" }}
                >
                  Messaging platforms
                </h3>
                <div class="flex flex-wrap gap-1.5">
                  {messagingChannels.map((channel) => (
                    <span
                      key={channel.id}
                      class="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded"
                      style={{
                        backgroundColor: "var(--color-page-surface-dim)",
                        color: "var(--color-page-text-muted)",
                        border: "1px solid var(--color-page-border)",
                      }}
                    >
                      <span class="shrink-0" aria-hidden="true">
                        {channel.renderIcon(12)}
                      </span>
                      {channel.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div
              class="rounded-xl p-5"
              style={{
                backgroundColor: "var(--color-page-bg-elevated)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              <div class="flex items-center gap-2 mb-3">
                <h3
                  class="text-sm font-semibold"
                  style={{ color: "var(--color-page-text)" }}
                >
                  LLM Providers
                </h3>
              </div>
              <div class="flex flex-wrap gap-1.5">
                {[
                  "OpenAI",
                  "Groq",
                  "Gemini",
                  "Together AI",
                  "NVIDIA NIM",
                  "z.ai",
                  "Fireworks AI",
                  "Mistral",
                  "DeepSeek",
                  "OpenRouter",
                  "Cerebras",
                  "OpenCode Zen",
                  "xAI",
                  "Perplexity",
                  "Cohere",
                  "ElevenLabs",
                ].map((name) => (
                  <span
                    key={name}
                    class="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded"
                    style={{
                      backgroundColor: "var(--color-page-surface-dim)",
                      color: "var(--color-page-text-muted)",
                      border: "1px solid var(--color-page-border)",
                    }}
                  >
                    <span class="shrink-0" aria-hidden="true">
                      {chipIcons[name]}
                    </span>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div class="text-center mt-6">
            <a
              href="/getting-started/skills/"
              class="text-xs font-medium hover:underline"
              style={{ color: "var(--color-tg-accent)" }}
            >
              See skills and MCP docs →
            </a>
          </div>
        </div>

        {/* CTA */}
        <div class="text-center">
          <h2
            class="text-2xl font-bold mb-3"
            style={{ color: "var(--color-page-text)" }}
          >
            Start building skills
          </h2>
          <p
            class="text-sm mb-6 max-w-md mx-auto leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Define your vertical. Bundle your integrations. Ship it on Lobu.
          </p>
          <div class="flex flex-wrap gap-3 justify-center">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
              style={{
                backgroundColor: "var(--color-page-surface)",
                color: "var(--color-page-text)",
                border: "1px solid var(--color-page-border-active)",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              View on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
