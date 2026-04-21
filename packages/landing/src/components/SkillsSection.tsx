import { useMemo, useState } from "preact/hooks";
import type { LandingUseCaseId } from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLandingUseCaseShowcase,
  getOwlettoLoginUrl,
  getSkillsPrompt,
  landingUseCaseGroupedOptions,
  type ShowcaseSkillWorkspacePreview,
  type SurfaceHeroCopy,
} from "../use-case-showcases";
import { CommandHero } from "./CommandHero";
import { HighlightedText } from "./HighlightedText";
import { ContentRail } from "./ContentRail";
import { SkillsWorkflowSection } from "./SkillsWorkflowSection";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";
import { ScopedUseCaseTabs } from "./ScopedUseCaseTabs";

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

const registryGroups = [
  {
    title: "MCP Servers",
    items: [
      "GitHub MCP",
      "Gmail MCP",
      "Google Calendar MCP",
      "Linear MCP",
      "Notion MCP",
      "Slack MCP",
      "Stripe MCP",
      "Custom MCP",
    ],
  },
  {
    title: "LLM Providers",
    items: [
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
    ],
  },
];

type EditorFile = {
  path: string;
  label: string;
  depth: number;
  type: "file" | "dir";
};

function getWorkspacePaths(workspace: ShowcaseSkillWorkspacePreview) {
  const agentDir = `agents/${workspace.agentId}`;
  const skillDir = `skills/${workspace.skillId}`;
  return {
    lobuToml: "lobu.toml",
    agentDir: `${agentDir}/`,
    identity: `${agentDir}/IDENTITY.md`,
    soul: `${agentDir}/SOUL.md`,
    user: `${agentDir}/USER.md`,
    skillsDir: "skills/",
    skillDir: `${skillDir}/`,
    skill: `${skillDir}/SKILL.md`,
  };
}

function getEditorFiles(
  workspace: ShowcaseSkillWorkspacePreview
): EditorFile[] {
  const paths = getWorkspacePaths(workspace);
  return [
    { path: paths.lobuToml, label: "lobu.toml", depth: 0, type: "file" },
    { path: "agents/", label: "agents", depth: 0, type: "dir" },
    { path: paths.agentDir, label: workspace.agentId, depth: 1, type: "dir" },
    { path: paths.identity, label: "IDENTITY.md", depth: 2, type: "file" },
    { path: paths.soul, label: "SOUL.md", depth: 2, type: "file" },
    { path: paths.user, label: "USER.md", depth: 2, type: "file" },
    { path: paths.skillsDir, label: "skills", depth: 0, type: "dir" },
    { path: paths.skillDir, label: workspace.skillId, depth: 1, type: "dir" },
    { path: paths.skill, label: "SKILL.md", depth: 2, type: "file" },
  ];
}

function getWorkspaceFileLines(workspace: ShowcaseSkillWorkspacePreview) {
  const paths = getWorkspacePaths(workspace);
  return new Map<string, string[]>([
    [
      paths.lobuToml,
      [
        `# Agent ${workspace.name}`,
        `[agents.${workspace.agentId}]`,
        `name = "${workspace.agentId}"`,
        `dir = "./agents/${workspace.agentId}"`,
        "",
        `[[agents.${workspace.agentId}.providers]]`,
        `id = "${workspace.providerId}"`,
        `model = "${workspace.model}"`,
        `key = "$${workspace.apiKeyEnv}"`,
      ],
    ],
    [paths.identity, ["# Identity", "", ...workspace.identity]],
    [paths.soul, ["# Soul", "", ...workspace.soul]],
    [paths.user, ["# User", "", ...workspace.user]],
    [
      paths.skill,
      [
        "---",
        `name: ${workspace.skillId}`,
        `description: ${workspace.description}`,
        `skills: [${workspace.skills.join(", ")}]`,
        `nixPackages: [${workspace.nixPackages.join(", ")}]`,
        `network: [${workspace.allowedDomains.join(", ")}]`,
        `mcp: ${workspace.mcpServer}`,
        "---",
        "",
        `# ${workspace.name}`,
        "",
        ...workspace.skillInstructions,
      ],
    ],
  ]);
}

function getTerminalLines(workspace: ShowcaseSkillWorkspacePreview) {
  const paths = getWorkspacePaths(workspace);
  return [
    "$ npx @lobu/cli@latest run",
    "> reading lobu.toml",
    `> loading ${paths.skill}`,
    `> installing ${workspace.nixPackages.join(", ")}`,
    `> allowing ${workspace.allowedDomains.join(", ")}`,
    `> registering ${workspace.mcpServer}`,
    "> agent ready",
  ];
}

function CodePreview({ lines }: { lines: string[] }) {
  return (
    <pre class={codeBlockClass} style={codeBlockStyle}>
      <code>{lines.join("\n")}</code>
    </pre>
  );
}

function FileContent({
  workspace,
  path,
}: {
  workspace: ShowcaseSkillWorkspacePreview;
  path: string;
}) {
  const fileLines = getWorkspaceFileLines(workspace).get(path);
  return <CodePreview lines={fileLines ?? []} />;
}

function EditorPreview({
  workspace,
}: {
  workspace: ShowcaseSkillWorkspacePreview;
}) {
  const paths = getWorkspacePaths(workspace);
  const editorFiles = getEditorFiles(workspace);
  const [activePath, setActivePath] = useState(paths.skill);

  return (
    <div
      class="text-left"
      style={{
        backgroundColor: "var(--color-page-bg-elevated)",
        overflow: "hidden",
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

      <div
        class="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]"
        style={{
          height: "min(40rem, 85vh)",
          gridTemplateRows: "minmax(0, 1fr) auto",
        }}
      >
        <aside
          class="p-4 min-w-0 flex flex-col justify-between gap-3 h-full overflow-hidden"
          style={{
            borderRight: "1px solid var(--color-page-border)",
            backgroundColor: "rgba(255,255,255,0.02)",
          }}
        >
          <div class="min-h-0">
            <div
              class="text-[10px] uppercase tracking-[0.18em] mb-3"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Files
            </div>
            <div class="space-y-1">
              {editorFiles.map((item) => {
                const isFile = item.type === "file";
                const isActive = isFile && item.path === activePath;
                const commonStyle = {
                  marginLeft: `${item.depth * 12}px`,
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
                      class="flex items-center gap-2 rounded-md px-2 py-1"
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
                    class="w-full text-left flex items-center gap-2 rounded-md px-2 py-1 cursor-pointer transition-colors hover:bg-white/5"
                    style={commonStyle}
                  >
                    <span class="text-[12px] font-mono">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <div class="min-w-0 flex flex-col min-h-0">
          <div
            class="flex items-stretch"
            style={{
              borderBottom: "1px solid var(--color-page-border)",
              backgroundColor: "rgba(0,0,0,0.16)",
            }}
          >
            <div
              class="text-[11px] font-mono px-3 py-2 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
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

          <div
            style={{
              flex: "1 1 auto",
              minHeight: 0,
            }}
          >
            <FileContent workspace={workspace} path={activePath} />
          </div>
        </div>

        <div
          class="min-w-0 md:col-span-2"
          style={{
            borderTop: "1px solid var(--color-page-border)",
            flex: "0 0 auto",
            backgroundColor: "rgba(0,0,0,0.24)",
          }}
        >
          <div
            class="flex items-stretch"
            style={{
              borderBottom: "1px solid var(--color-page-border)",
              backgroundColor: "rgba(255,255,255,0.02)",
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
            class={codeBlockClass}
            style={{
              ...codeBlockStyle,
              backgroundColor: "rgba(0,0,0,0.24)",
            }}
          >
            <code>{getTerminalLines(workspace).join("\n")}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

const codeBlockClass =
  "px-4 py-3 text-left text-[10px] leading-5 font-mono whitespace-pre-wrap break-words overflow-hidden m-0 max-w-full";
const codeBlockStyle = {
  backgroundColor: "rgba(0,0,0,0.3)",
  color: "#9aa5ce",
  wordBreak: "break-word" as const,
};

function RegistryGroup({ title, items }: { title: string; items: string[] }) {
  return (
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
          {title}
        </h3>
      </div>
      <div class="flex flex-wrap gap-1.5">
        {items.map((name) => (
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
  );
}

export function SkillsSection(props: {
  defaultUseCaseId?: LandingUseCaseId;
  linkTabsToCampaigns?: boolean;
  linkTabsToPages?: boolean;
  heroCopy?: SurfaceHeroCopy;
}) {
  const [activeUseCaseId, setActiveUseCaseId] = useState<LandingUseCaseId>(
    props.defaultUseCaseId ?? DEFAULT_LANDING_USE_CASE_ID
  );
  const activeUseCase = useMemo(
    () => getLandingUseCaseShowcase(activeUseCaseId),
    [activeUseCaseId]
  );
  const activeWorkspace = activeUseCase.skills;

  return (
    <section class="pt-32 pb-24 px-4 sm:px-6 lg:px-8">
      <div class="max-w-[72rem] mx-auto">
        <CommandHero
          title={
            <HighlightedText
              text="Build reliable agents with Lobu skills"
              highlight="Lobu skills"
            />
          }
          description={
            props.heroCopy?.description ??
            "A skill isn't a prompt template, it's a full sandboxed computer. All capabilities bundled into one installable unit."
          }
          prompt={getSkillsPrompt(activeUseCase)}
          promptTriggerLabel="Integrate"
          supportedClients={["chatgpt", "openclaw", "claude", "mcp-client"]}
          supportedClientHrefForId={(clientId) => {
            if (clientId === "mcp-client") {
              return "/getting-started/skills/";
            }

            return `/connect-from/${clientId}/for/${activeUseCase.id}/`;
          }}
          actions={
            <a
              href={getOwlettoLoginUrl()}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
              style={{
                backgroundColor: "var(--color-page-text)",
                color: "var(--color-page-bg)",
              }}
            >
              Build in Cloud
            </a>
          }
        />

        <div class="mb-16 text-center">
          <ScopedUseCaseTabs
            groups={landingUseCaseGroupedOptions}
            activeId={activeUseCaseId}
            onSelect={
              props.linkTabsToCampaigns || props.linkTabsToPages
                ? undefined
                : (id) => setActiveUseCaseId(id as LandingUseCaseId)
            }
            hrefForId={
              props.linkTabsToPages
                ? (id) => `/skills/for/${id}`
                : props.linkTabsToCampaigns
                  ? (id) => `/for/${id}`
                  : undefined
            }
            className="mb-5"
          />

          <ContentRail>
            <div
              class="rounded-xl overflow-hidden"
              style={{ border: "1px solid var(--color-page-border)" }}
            >
              <EditorPreview
                key={activeWorkspace.agentId}
                workspace={activeWorkspace}
              />
            </div>
            <div class="text-center mt-4">
              <a
                href={`${GITHUB_URL}/tree/main/examples/${activeUseCase.examplePath}`}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs font-medium hover:underline inline-flex items-center gap-1.5"
                style={{ color: "var(--color-tg-accent)" }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                See full example on GitHub →
              </a>
            </div>
          </ContentRail>
        </div>

        <div class="mb-16">
          <SkillsWorkflowSection activeUseCase={activeUseCase} />
        </div>

        <ContentRail className="mb-16">
          <h2
            class="text-xl font-bold mb-2 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            What starter skills can bundle
          </h2>
          <p
            class="text-sm text-center mb-8 max-w-lg mx-auto"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Install the Lobu starter skill with{" "}
            <code
              class="text-[11px] px-1 py-0.5 rounded"
              style={{ backgroundColor: "var(--color-page-surface-dim)" }}
            >
              npx @lobu/cli@latest skills add lobu
            </code>{" "}
            and install Owletto separately with{" "}
            <code
              class="text-[11px] px-1 py-0.5 rounded"
              style={{ backgroundColor: "var(--color-page-surface-dim)" }}
            >
              npx owletto@latest skills add owletto
            </code>
            . Local <code>SKILL.md</code> files are still discovered
            automatically. The cards below show the kinds of MCP servers and
            providers those skills can bundle.
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {registryGroups.map((group) => (
              <RegistryGroup
                key={group.title}
                title={group.title}
                items={group.items}
              />
            ))}
          </div>
          <div class="text-center mt-6 flex flex-wrap gap-3 justify-center">
            <a
              href="/getting-started/skills/"
              class="text-xs font-medium hover:underline"
              style={{ color: "var(--color-tg-accent)" }}
            >
              See skills and MCP docs →
            </a>
            <a
              href={`/for/${activeUseCaseId}`}
              class="text-xs font-medium hover:underline"
              style={{ color: "var(--color-tg-accent)" }}
            >
              Browse use-case pages →
            </a>
          </div>
        </ContentRail>

        <ContentRail className="mb-16">
          <h2
            class="text-xl font-bold mb-6 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            An agent is a reproducible environment with capabilities
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
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
        </ContentRail>

        <ContentRail className="text-center">
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
            <ScheduleCallButton
              class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
              style={{
                backgroundColor: "var(--color-tg-accent)",
                color: "var(--color-page-bg)",
              }}
            >
              <ScheduleCallIcon />
              Talk to Founder
            </ScheduleCallButton>
          </div>
        </ContentRail>
      </div>
    </section>
  );
}
