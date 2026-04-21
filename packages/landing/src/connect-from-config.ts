import type { LandingUseCaseShowcase } from "./use-case-showcases";

export type ConnectFromClientId = "chatgpt" | "claude" | "openclaw";

type ConnectFromDocLink = {
  label: string;
  href: string;
};

type ConnectFromDocSection = {
  title: string;
  paragraphs: string[];
};

export type ConnectFromNpmPackage = {
  name: string;
  registryUrl: string;
  sourceUrl: string;
  installCommand: string;
};

type ConnectFromClientConfig = {
  id: ConnectFromClientId;
  label: string;
  docsHref: string;
  docsLabel: string;
  /**
   * One-liner shown directly under the page title that explains what Owletto
   * adds to this agent.
   */
  valueProp: string;
  /**
   * The text the user copies into their agent (or assistant) so it can install
   * Owletto for them.
   */
  installPrompt: string;
  /**
   * Optional npm package to surface as the canonical install path.
   */
  npmPackage?: ConnectFromNpmPackage;
  describe: (showcase: LandingUseCaseShowcase) => string;
  docsSetupTitle: string;
  docsSetupSteps: string[];
  docsSetupNote?: string;
  docsExtraSection?: ConnectFromDocSection;
  docsRelated: ConnectFromDocLink[];
};

const mcpClientDescribe =
  (label: string) => (showcase: LandingUseCaseShowcase) =>
    `Use ${label} on top of the ${showcase.label.toLowerCase()} workspace so it can read and write the same shared memory shown in this example.`;

export const connectFromClientConfigs: Record<
  ConnectFromClientId,
  ConnectFromClientConfig
> = {
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    docsHref: "/connect-from/chatgpt/",
    docsLabel: "ChatGPT setup docs",
    valueProp:
      "Add structured, queryable long-term memory to ChatGPT — the same graph other agents share, recalled and updated through one MCP endpoint.",
    installPrompt:
      "Connect ChatGPT to Owletto: open Settings → Integrations → Model Context Protocol → Add Server, name it `Owletto`, and paste the MCP URL https://app.lobu.ai/mcp. Sign in with your Lobu account when prompted, then point ChatGPT at the workspace I want it to use.",
    describe: mcpClientDescribe("ChatGPT"),
    docsSetupTitle: "Connect ChatGPT",
    docsSetupSteps: [
      "Open Settings → Integrations → Model Context Protocol → Add Server in ChatGPT.",
      "Name the server `Owletto` and paste https://app.lobu.ai/mcp as the URL.",
      "Complete the Lobu sign-in flow in the popup.",
      "Pick the workspace ChatGPT should read and write.",
    ],
    docsSetupNote:
      "ChatGPT discovers the available memory tools automatically once the MCP connection is approved.",
    docsRelated: [
      { label: "Memory", href: "/getting-started/memory/" },
      { label: "Owletto CLI Reference", href: "/reference/owletto-cli/" },
    ],
  },
  claude: {
    id: "claude",
    label: "Claude",
    docsHref: "/connect-from/claude/",
    docsLabel: "Claude setup docs",
    valueProp:
      "Give Claude durable, structured memory it can search and append to — so the same recall is available across Claude, ChatGPT, and your own agents.",
    installPrompt:
      "Connect Claude to Owletto: open Settings → Connectors → Add Custom Connector, paste the MCP URL https://app.lobu.ai/mcp, complete the Lobu sign-in, then enable the connector. Pick the workspace I want Claude to read and write.",
    describe: mcpClientDescribe("Claude"),
    docsSetupTitle: "Connect Claude",
    docsSetupSteps: [
      "Open Settings → Connectors → Add Custom Connector in Claude Desktop or claude.ai.",
      "Paste https://app.lobu.ai/mcp as the MCP URL.",
      "Complete the Lobu sign-in flow.",
      "Enable the connector and choose the workspace Claude should use.",
    ],
    docsSetupNote:
      "For Claude Code, run `claude mcp add --transport http owletto https://app.lobu.ai/mcp` instead and complete the OAuth flow when prompted.",
    docsExtraSection: {
      title: "Claude Code and Claude Desktop",
      paragraphs: [
        "Claude Code uses the same MCP endpoint, registered through `claude mcp add`. The OAuth flow is handled in your browser the first time you call a memory tool.",
        "Pair the connector with a project-level instruction file (or a small skill) that tells Claude when to search memory before answering and when to save what it just learned.",
      ],
    },
    docsRelated: [
      { label: "Memory", href: "/getting-started/memory/" },
      { label: "Skills", href: "/getting-started/skills/" },
      { label: "Owletto CLI Reference", href: "/reference/owletto-cli/" },
    ],
  },
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    docsHref: "/connect-from/openclaw/",
    docsLabel: "OpenClaw setup docs",
    valueProp:
      "Layer structured, shareable Owletto memory on top of OpenClaw's built-in filesystem memory — the plugin extends OpenClaw's filesystem plugin and can optionally take over its memory slot, so different OpenClaw agents can talk to each other through the same Owletto graph.",
    installPrompt:
      "Install Owletto in OpenClaw. Run:\n\n  openclaw plugins install owletto-openclaw-plugin\n  owletto login https://app.lobu.ai/mcp\n  owletto configure\n  owletto health\n\nThe plugin extends OpenClaw's filesystem plugin and can replace its memory slot. After install, point me at the Owletto workspace I should use as shared memory across my OpenClaw agents.",
    npmPackage: {
      name: "@lobu/owletto-openclaw",
      registryUrl: "https://www.npmjs.com/package/@lobu/owletto-openclaw",
      sourceUrl:
        "https://github.com/lobu-ai/owletto/tree/main/packages/openclaw-plugin",
      installCommand: "openclaw plugins install owletto-openclaw-plugin",
    },
    describe: (showcase) =>
      `Install Owletto into OpenClaw and point it at the ${showcase.label.toLowerCase()} workspace so multiple OpenClaw agents share the same memory shown in this example.`,
    docsSetupTitle: "Install in OpenClaw",
    docsSetupSteps: [
      "Install the plugin: `openclaw plugins install owletto-openclaw-plugin`.",
      "Log in to Lobu: `owletto login https://app.lobu.ai/mcp`.",
      "Wire it into OpenClaw: `owletto configure` (writes the plugin config and, if you opt in, takes over the filesystem memory slot).",
      "Verify: `owletto health`.",
    ],
    docsSetupNote:
      "The plugin extends OpenClaw's filesystem plugin. Leave that plugin enabled if you want both, or let `owletto configure` swap Owletto in as the memory slot.",
    docsExtraSection: {
      title: "Cross-agent memory",
      paragraphs: [
        "Once two OpenClaw agents point at the same Owletto workspace, they read and write the same entities, observations, and decisions — that is how a team of OpenClaw agents stays coherent without copy-pasting context.",
      ],
    },
    docsRelated: [
      { label: "Memory", href: "/getting-started/memory/" },
      { label: "Owletto CLI Reference", href: "/reference/owletto-cli/" },
    ],
  },
};

export const connectFromClientIds = Object.keys(
  connectFromClientConfigs
) as ConnectFromClientId[];

export function getConnectFromClientConfig(clientId: ConnectFromClientId) {
  return connectFromClientConfigs[clientId];
}
