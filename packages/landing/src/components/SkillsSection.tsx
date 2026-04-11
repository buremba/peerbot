import { useState } from "preact/hooks";
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
      "Declare Nix packages your skill needs (ffmpeg, poppler, gh, ripgrep). Installed once, persisted across sessions.",
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
const h = { color: "#c0caf5" }; // headings
const m = { color: "#9aa5ce" }; // body text

type EditorFile = {
  path: string;
  label: string;
  depth: number;
  type: "file" | "dir";
};

const editorFiles: EditorFile[] = [
  { path: "lobu.toml", label: "lobu.toml", depth: 0, type: "file" },
  { path: "IDENTITY.md", label: "IDENTITY.md", depth: 0, type: "file" },
  { path: "SOUL.md", label: "SOUL.md", depth: 0, type: "file" },
  { path: "USER.md", label: "USER.md", depth: 0, type: "file" },
  { path: "skills/", label: "skills", depth: 0, type: "dir" },
  { path: "skills/ops-triage/", label: "ops-triage", depth: 1, type: "dir" },
  {
    path: "skills/ops-triage/SKILL.md",
    label: "SKILL.md",
    depth: 2,
    type: "file",
  },
];

const AGENT_PROMPT =
  "Set up a new Lobu agent in this directory. Create lobu.toml, IDENTITY.md, SOUL.md, USER.md, and a skill in skills/ops-triage/SKILL.md with nix packages, a network allowlist, tool permissions, and an MCP server. Follow the Lobu skill conventions at https://lobu.ai/getting-started/skills/.";

const INIT_COMMAND = "npx @lobu/cli@latest init";

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Ignore clipboard failures (e.g. insecure context).
      });
  };
  return { copied, handleCopy };
}

function InitCommand() {
  const { copied, handleCopy } = useCopy(INIT_COMMAND);
  return (
    <div
      class="inline-flex items-center gap-3 rounded-xl px-4 py-2"
      style={{
        border: "1px solid var(--color-page-border-active)",
        backgroundColor: "rgba(0,0,0,0.3)",
      }}
    >
      <code
        class="text-[13px] font-mono"
        style={{ color: "var(--color-page-text)" }}
      >
        <span style={{ color: "#7aa2f7" }}>$ </span>
        {INIT_COMMAND}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        class="text-[11px] font-medium px-2 py-1 rounded-md cursor-pointer transition-colors hover:bg-white/5"
        style={{
          color: copied
            ? "var(--color-tg-accent)"
            : "var(--color-page-text-muted)",
          border: "1px solid var(--color-page-border)",
          backgroundColor: "transparent",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function CopyPromptButton() {
  const { copied, handleCopy } = useCopy(AGENT_PROMPT);
  return (
    <button
      type="button"
      onClick={handleCopy}
      class="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium cursor-pointer transition-colors hover:opacity-90"
      style={{
        backgroundColor: copied
          ? "rgba(122,162,247,0.18)"
          : "var(--color-page-surface)",
        color: "var(--color-page-text)",
        border: "1px solid var(--color-page-border-active)",
      }}
    >
      {copied ? "Copied" : "Copy prompt"}
    </button>
  );
}

function EditorPreview() {
  const [activePath, setActivePath] = useState("skills/ops-triage/SKILL.md");

  return (
    <div
      style={{
        backgroundColor: "var(--color-page-bg-elevated)",
      }}
    >
      <div
        class="px-4 py-3 flex items-center justify-between gap-3"
        style={{
          borderBottom: "1px solid var(--color-page-border)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
        }}
      >
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-red-400/80" />
          <span class="w-2.5 h-2.5 rounded-full bg-amber-400/80" />
          <span class="w-2.5 h-2.5 rounded-full bg-green-400/80" />
        </div>
        <div
          class="text-[11px] font-mono"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          agent workspace
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside
          class="p-4"
          style={{
            borderRight: "1px solid var(--color-page-border)",
            backgroundColor: "rgba(255,255,255,0.02)",
          }}
        >
          <div
            class="text-[10px] uppercase tracking-[0.18em] mb-3"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Files
          </div>
          <div class="space-y-1.5">
            {editorFiles.map((item) => {
              const isFile = item.type === "file";
              const isActive = isFile && item.path === activePath;
              const commonStyle = {
                marginLeft: `${item.depth * 14}px`,
                backgroundColor: isActive
                  ? "rgba(122,162,247,0.14)"
                  : "transparent",
                color: isActive
                  ? "var(--color-page-text)"
                  : "var(--color-page-text-muted)",
              };

              if (!isFile) {
                return (
                  <div
                    key={item.path}
                    class="flex items-center gap-2 rounded-md px-2 py-1.5"
                    style={commonStyle}
                  >
                    <span class="text-[12px] font-mono">{item.label}/</span>
                  </div>
                );
              }

              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => setActivePath(item.path)}
                  class="w-full text-left flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors hover:bg-white/5"
                  style={commonStyle}
                >
                  <span class="text-[12px] font-mono">{item.label}</span>
                </button>
              );
            })}
          </div>

          <div
            class="mt-4 rounded-lg p-3 text-[11px] leading-relaxed"
            style={{
              backgroundColor: "rgba(0,0,0,0.18)",
              color: "var(--color-page-text-muted)",
              border: "1px solid var(--color-page-border)",
            }}
          >
            <div
              class="font-medium mb-1"
              style={{ color: "var(--color-page-text)" }}
            >
              One workspace, explicit files
            </div>
            <div>
              <code>lobu.toml</code> wires skills in. Each <code>SKILL.md</code>{" "}
              defines sandbox, tools, MCP, and behavior.
            </div>
          </div>
        </aside>

        <div class="min-w-0">
          <div
            class="flex items-stretch"
            style={{
              borderBottom: "1px solid var(--color-page-border)",
              backgroundColor: "rgba(0,0,0,0.16)",
            }}
          >
            <div
              class="text-[11px] font-mono px-3 py-2"
              style={{
                backgroundColor: "rgba(122,162,247,0.12)",
                color: "var(--color-page-text)",
                borderRight: "1px solid var(--color-page-border)",
                borderTop: "2px solid rgba(122,162,247,0.6)",
              }}
            >
              {activePath}
            </div>
          </div>

          <FileContent path={activePath} />

          <div
            style={{
              borderTop: "1px solid var(--color-page-border)",
            }}
          >
            <div
              class="flex items-stretch"
              style={{
                borderBottom: "1px solid var(--color-page-border)",
                backgroundColor: "rgba(0,0,0,0.16)",
              }}
            >
              <div
                class="text-[11px] font-mono px-3 py-2"
                style={{
                  backgroundColor: "rgba(122,162,247,0.12)",
                  color: "var(--color-page-text)",
                  borderRight: "1px solid var(--color-page-border)",
                  borderTop: "2px solid rgba(122,162,247,0.6)",
                }}
              >
                terminal
              </div>
            </div>
            <pre
              class="m-0 p-4 overflow-x-auto text-[11px] leading-6 font-mono"
              style={codeBlockStyle}
            >
              <code>
                <span style={{ color: "#7aa2f7" }}>$</span> npx @lobu/cli@latest
                run
                {"\n"}
                <span style={{ color: "#9ece6a" }}>{">"}</span> reading
                lobu.toml
                {"\n"}
                <span style={{ color: "#9ece6a" }}>{">"}</span> loading{" "}
                <span style={{ color: "#c0caf5" }}>
                  skills/ops-triage/SKILL.md
                </span>
                {"\n"}
                <span style={{ color: "#9ece6a" }}>{">"}</span> allowing{" "}
                <span style={{ color: "#c0caf5" }}>
                  api.github.com, gmail.googleapis.com, .linear.app
                </span>
                {"\n"}
                <span style={{ color: "#9ece6a" }}>{">"}</span> registering{" "}
                <span style={{ color: "#c0caf5" }}>github-mcp</span>
                {"\n"}
                <span style={{ color: "#9ece6a" }}>{">"}</span> agent ready
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileContent({ path }: { path: string }) {
  switch (path) {
    case "lobu.toml":
      return <LobuToml />;
    case "IDENTITY.md":
      return <IdentityMd />;
    case "SOUL.md":
      return <SoulMd />;
    case "USER.md":
      return <UserMd />;
    default:
      return <SkillYaml />;
  }
}

const codeBlockClass =
  "p-4 text-[11px] leading-relaxed font-mono overflow-x-auto m-0";
const codeBlockStyle = {
  backgroundColor: "rgba(0,0,0,0.3)",
  color: "#9aa5ce",
};

function LobuToml() {
  return (
    <pre class={codeBlockClass} style={codeBlockStyle}>
      <code>
        <span style={d}>[agent]</span>
        {"\n"}
        <span style={k}>name</span> = <span style={s}>"ops-triage"</span>
        {"\n"}
        <span style={k}>model</span> ={" "}
        <span style={s}>"claude/sonnet-4-5"</span>
        {"\n"}
        {"\n"}
        <span style={d}>[agent.skills]</span>
        {"\n"}
        <span style={k}>enabled</span> = <span style={d}>[</span>
        <span style={s}>"ops-triage"</span>
        <span style={d}>]</span>
        {"\n"}
        {"\n"}
        <span style={d}>[providers.anthropic]</span>
        {"\n"}
        <span style={k}>api_key</span> ={" "}
        <span style={s}>"${"{ANTHROPIC_API_KEY}"}"</span>
        {"\n"}
        {"\n"}
        <span style={d}>[connections.slack]</span>
        {"\n"}
        <span style={k}>bot_token</span> ={" "}
        <span style={s}>"${"{SLACK_BOT_TOKEN}"}"</span>
        {"\n"}
        <span style={k}>signing_secret</span> ={" "}
        <span style={s}>"${"{SLACK_SIGNING_SECRET}"}"</span>
        {"\n"}
      </code>
    </pre>
  );
}

function IdentityMd() {
  return (
    <pre class={codeBlockClass} style={codeBlockStyle}>
      <code>
        <span style={h}># Identity</span>
        {"\n"}
        {"\n"}
        <span style={m}>You are an ops triage specialist helping on-call</span>
        {"\n"}
        <span style={m}>
          engineers prioritize incoming signals and escalate
        </span>
        {"\n"}
        <span style={m}>what matters.</span>
        {"\n"}
        {"\n"}
        <span style={h}>## Scope</span>
        {"\n"}
        <span style={m}>- Inbox triage across email, PRs, Linear</span>
        {"\n"}
        <span style={m}>- Surface blockers, not busywork</span>
        {"\n"}
        <span style={m}>- Escalate P0 issues immediately</span>
        {"\n"}
      </code>
    </pre>
  );
}

function SoulMd() {
  return (
    <pre class={codeBlockClass} style={codeBlockStyle}>
      <code>
        <span style={h}># Soul</span>
        {"\n"}
        {"\n"}
        <span style={m}>- Be concise. Engineers are tired.</span>
        {"\n"}
        <span style={m}>- Blockers first, context second.</span>
        {"\n"}
        <span style={m}>
          - Never take destructive actions without approval.
        </span>
        {"\n"}
        <span style={m}>- Link back to source threads for every claim.</span>
        {"\n"}
        {"\n"}
        <span style={h}>## Tone</span>
        {"\n"}
        <span style={m}>Calm, direct, no filler. Ship the summary.</span>
        {"\n"}
      </code>
    </pre>
  );
}

function UserMd() {
  return (
    <pre class={codeBlockClass} style={codeBlockStyle}>
      <code>
        <span style={h}># User</span>
        {"\n"}
        {"\n"}
        <span style={m}>- Name: Alex</span>
        {"\n"}
        <span style={m}>- Role: Staff SRE</span>
        {"\n"}
        <span style={m}>- Timezone: UTC-5</span>
        {"\n"}
        <span style={m}>- On-call: Mon-Wed rotation</span>
        {"\n"}
        {"\n"}
        <span style={h}>## Preferences</span>
        {"\n"}
        <span style={m}>- Linear for issue tracking</span>
        {"\n"}
        <span style={m}>- PagerDuty for incidents</span>
        {"\n"}
        <span style={m}>- Morning standup at 09:30 ET</span>
        {"\n"}
      </code>
    </pre>
  );
}

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

export function SkillsSection() {
  return (
    <section class="pt-32 pb-24 px-4 sm:px-8">
      <div class="max-w-3xl mx-auto">
        {/* Hero */}
        <div class="text-center mb-12">
          <h1
            class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5"
            style={{ color: "var(--color-page-text)" }}
          >
            Build reliable agents with{" "}
            <span style={{ color: "var(--color-tg-accent)" }}>Lobu Skills</span>
          </h1>
          <p
            class="text-lg sm:text-xl leading-8 max-w-[40rem] mx-auto m-0"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            A skill isn't a prompt template — it's a full sandboxed computer.
            System packages, network policies, tool permissions, MCP servers,
            and integrations — all bundled into one installable unit.
          </p>
        </div>

        {/* Agent project structure */}
        <div class="mb-16">
          <h2
            class="text-xl font-bold mb-2 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            Start a new agent in seconds
          </h2>
          <p
            class="text-sm text-center mb-8 max-w-lg mx-auto"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Run the init command locally, or paste a prompt into your coding
            agent and let it scaffold the project for you.
          </p>

          <div class="flex flex-wrap items-center justify-center gap-3 mb-8">
            <InitCommand />
            <CopyPromptButton />
          </div>

          <div
            class="rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--color-page-border)" }}
          >
            <EditorPreview />
          </div>
        </div>

        {/* Anatomy of a skill */}
        <div class="mb-16">
          <h2
            class="text-xl font-bold mb-6 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            An agent is a reproducible environment with capabilities
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
                  {v.skills.map((skill) => (
                    <span
                      key={skill}
                      class="text-[10px] font-mono px-2 py-0.5 rounded"
                      style={{
                        backgroundColor: "var(--color-page-surface-dim)",
                        color: "var(--color-page-text-muted)",
                        border: "1px solid var(--color-page-border)",
                      }}
                    >
                      {skill}
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
                Built-in registry MCPs and your own custom endpoints.
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
