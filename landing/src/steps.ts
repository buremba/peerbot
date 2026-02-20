import type { FlowStep, PromptOption } from "./types";

export const PROMPT_OPTIONS: PromptOption[] = [
  {
    label: "Summarize my emails",
    prompt: "Summarize my emails from today",
    mcpTarget: "Gmail",
    mcpDomain: "gmail.com",
  },
  {
    label: "Update Jira ticket",
    prompt: "Update PROJ-123 status to done",
    mcpTarget: "Jira",
    mcpDomain: "jira.atlassian.com",
  },
  {
    label: "Check PR reviews",
    prompt: "Show my open PR reviews on GitHub",
    mcpTarget: "GitHub",
    mcpDomain: "github.com",
  },
];

export function buildSteps(prompt: PromptOption): FlowStep[] {
  return [
    {
      id: "user-types",
      title: "User sends message",
      description: `User types "${prompt.prompt}" in Slack`,
      activeNodes: ["slack"],
      slackEvent: {
        type: "user",
        text: prompt.prompt,
      },
      duration: 2000,
    },
    {
      id: "message-to-gateway",
      title: "Message reaches Gateway",
      description: "Slack delivers the event to the Lobu gateway",
      activeNodes: ["slack", "gateway"],
      packet: {
        from: "slack",
        to: "gateway",
        label: "event",
        color: "#4A9EFF",
      },
      duration: 1500,
    },
    {
      id: "check-sandbox",
      title: "Check sandbox status",
      description:
        "Gateway checks if a sandbox is already running for this user",
      activeNodes: ["gateway"],
      callout: {
        node: "gateway",
        text: "Is sandbox running? → No",
        type: "info",
      },
      duration: 1800,
    },
    {
      id: "check-snapshot",
      title: "Look up snapshot",
      description:
        "Gateway checks if a pre-built snapshot exists for the agent",
      activeNodes: ["gateway"],
      callout: {
        node: "gateway",
        text: "Snapshot exists? → No",
        type: "info",
      },
      duration: 1800,
    },
    {
      id: "create-snapshot",
      title: "Create snapshot",
      description:
        "Gateway creates a snapshot with the agent's tools, MCP config, and dependencies",
      activeNodes: ["gateway", "sandbox"],
      packet: {
        from: "gateway",
        to: "sandbox",
        label: "snapshot",
        color: "#F59E0B",
      },
      callout: {
        node: "sandbox",
        text: "Building snapshot...",
        type: "info",
      },
      duration: 2500,
    },
    {
      id: "start-container",
      title: "Start container",
      description:
        "Container launches from snapshot — isolated environment with no direct internet access",
      activeNodes: ["sandbox"],
      callout: {
        node: "sandbox",
        text: "Container running (network isolated)",
        type: "security",
      },
      slackEvent: {
        type: "bot",
        text: "Working on it...",
      },
      duration: 2000,
    },
    {
      id: "deliver-message",
      title: "Deliver prompt to sandbox",
      description: "Gateway sends the user's message to the sandbox runtime",
      activeNodes: ["gateway", "sandbox"],
      packet: {
        from: "gateway",
        to: "sandbox",
        label: "prompt",
        color: "#4A9EFF",
      },
      duration: 1500,
    },
    {
      id: "sandbox-runs",
      title: "Sandbox processes message",
      description:
        "OpenClaw runtime analyzes the prompt and determines it needs to fetch emails via MCP",
      activeNodes: ["sandbox"],
      callout: {
        node: "sandbox",
        text: `Need to call ${prompt.mcpTarget} via MCP`,
        type: "info",
      },
      duration: 2000,
    },
    {
      id: "mcp-call",
      title: "MCP proxy request",
      description:
        "Sandbox calls the gateway's MCP proxy endpoint — it does NOT have OAuth tokens",
      activeNodes: ["sandbox", "gateway"],
      packet: {
        from: "sandbox",
        to: "gateway",
        label: "MCP call",
        color: "#A855F7",
      },
      callout: {
        node: "sandbox",
        text: "No OAuth tokens in sandbox",
        type: "security",
      },
      duration: 2000,
    },
    {
      id: "enrich-token",
      title: "Gateway enriches with credentials",
      description:
        "Gateway attaches the user's OAuth token to the MCP request — sandbox never sees it",
      activeNodes: ["gateway"],
      callout: {
        node: "gateway",
        text: "Injecting OAuth token (hidden from sandbox)",
        type: "security",
      },
      duration: 2000,
    },
    {
      id: "domain-check",
      title: "Domain access check",
      description: `MCP needs to reach ${prompt.mcpDomain} — but it's not in the allowlist`,
      activeNodes: ["gateway", "mcp"],
      packet: {
        from: "gateway",
        to: "mcp",
        label: "blocked",
        color: "#EF4444",
      },
      callout: {
        node: "gateway",
        text: `${prompt.mcpDomain} not in allowlist!`,
        type: "warning",
      },
      duration: 2000,
    },
    {
      id: "permission-prompt",
      title: "User permission prompt",
      description: `User is asked in Slack to approve access to ${prompt.mcpDomain}`,
      activeNodes: ["gateway", "slack"],
      packet: {
        from: "gateway",
        to: "slack",
        label: "permission",
        color: "#F59E0B",
      },
      slackEvent: {
        type: "permission",
        text: `Allow access to ${prompt.mcpDomain} for 1 hour?`,
      },
      duration: 3000,
    },
    {
      id: "user-approves",
      title: "User approves access",
      description: `User clicks "Allow for 1 hour" — domain is temporarily whitelisted`,
      activeNodes: ["slack", "gateway"],
      packet: {
        from: "slack",
        to: "gateway",
        label: "approved",
        color: "#10B981",
      },
      slackEvent: {
        type: "system",
        text: `✓ ${prompt.mcpDomain} allowed for 1 hour`,
      },
      duration: 1800,
    },
    {
      id: "fetch-data",
      title: `Fetch from ${prompt.mcpTarget}`,
      description: `Gateway fetches data from ${prompt.mcpDomain} using the user's OAuth credentials`,
      activeNodes: ["gateway", "mcp"],
      packet: {
        from: "gateway",
        to: "mcp",
        label: "fetch",
        color: "#10B981",
      },
      duration: 2000,
    },
    {
      id: "data-to-sandbox",
      title: "Data returned to sandbox",
      description: `${prompt.mcpTarget} data flows back through gateway to the isolated sandbox`,
      activeNodes: ["mcp", "gateway", "sandbox"],
      packet: {
        from: "mcp",
        to: "sandbox",
        label: "data",
        color: "#10B981",
      },
      duration: 1800,
    },
    {
      id: "llm-request",
      title: "LLM API call",
      description:
        "Sandbox calls the gateway's LLM endpoint — it does NOT have API keys",
      activeNodes: ["sandbox", "gateway"],
      packet: {
        from: "sandbox",
        to: "gateway",
        label: "LLM request",
        color: "#8B5CF6",
      },
      callout: {
        node: "sandbox",
        text: "No LLM API keys in sandbox",
        type: "security",
      },
      duration: 2000,
    },
    {
      id: "llm-process",
      title: "LLM processes request",
      description:
        "Gateway forwards to LLM API with proper credentials, generates the response",
      activeNodes: ["gateway", "llm"],
      packet: {
        from: "gateway",
        to: "llm",
        label: "generate",
        color: "#8B5CF6",
      },
      duration: 2000,
    },
    {
      id: "llm-response",
      title: "LLM response returns",
      description: "Generated response flows back through gateway to sandbox",
      activeNodes: ["llm", "gateway", "sandbox"],
      packet: {
        from: "llm",
        to: "sandbox",
        label: "response",
        color: "#8B5CF6",
      },
      duration: 1500,
    },
    {
      id: "stream-result",
      title: "Stream result to user",
      description:
        "Sandbox sends the final output through gateway back to Slack, streamed in real-time",
      activeNodes: ["sandbox", "gateway", "slack"],
      packet: {
        from: "sandbox",
        to: "slack",
        label: "stream",
        color: "#10B981",
      },
      slackEvent: {
        type: "typing",
        text: getResponseText(prompt),
        streaming: true,
      },
      duration: 4000,
    },
    {
      id: "done",
      title: "Complete",
      description:
        "User sees the response in Slack — all processing happened in an isolated sandbox",
      activeNodes: ["slack"],
      slackEvent: {
        type: "bot",
        text: getResponseText(prompt),
      },
      callout: {
        node: "sandbox",
        text: "Sandbox stays warm for follow-ups",
        type: "info",
      },
      duration: 3000,
    },
  ];
}

function getResponseText(prompt: PromptOption): string {
  switch (prompt.mcpTarget) {
    case "Gmail":
      return "Here's your email summary for today:\n\n• **Design review** from Sarah — needs feedback by EOD\n• **Sprint planning** reminder — tomorrow 10am\n• **AWS billing alert** — usage up 12% this month\n\n3 emails require your attention.";
    case "Jira":
      return "Done! PROJ-123 has been updated:\n\n• Status: **In Progress** → **Done**\n• Resolution: Completed\n• Time logged: 2h 30m\n\nThe ticket is now closed.";
    case "GitHub":
      return "You have 3 open PR reviews:\n\n• **#142** feat: add OAuth flow — 2 comments pending\n• **#138** fix: rate limiting bug — approved, ready to merge\n• **#135** refactor: MCP proxy — 5 files changed\n\nPR #138 can be merged now.";
    default:
      return "Done!";
  }
}
