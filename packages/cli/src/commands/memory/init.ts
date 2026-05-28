import * as p from "@clack/prompts";
import { DEFAULT_LOBU_MCP_URL } from "../../internal/context.js";
import { healthPing, runInitWizard } from "./_lib/init-wizard.js";
import { normalizeMcpUrl } from "./_lib/openclaw-auth.js";

interface MemoryInitOptions {
  url?: string;
  agent?: string;
  skipAuth?: boolean;
}

async function chooseMcpUrl(urlFlag?: string): Promise<string> {
  if (urlFlag) return normalizeMcpUrl(urlFlag);

  const mode = await p.select({
    message: "Which Lobu memory MCP endpoint should your agents use?",
    options: [
      { value: "cloud", label: "Lobu Cloud", hint: "https://lobu.ai/mcp" },
      {
        value: "local",
        label: "Local runtime",
        hint: "http://localhost:8787/mcp",
      },
      { value: "custom", label: "Custom MCP URL", hint: "enter URL" },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (mode === "cloud") return DEFAULT_LOBU_MCP_URL;
  if (mode === "local") return normalizeMcpUrl("http://localhost:8787");

  const url = await p.text({
    message: "Enter your Lobu memory MCP URL:",
    placeholder: "https://your-server.com/mcp",
    validate(value) {
      if (!value) return "URL is required";
      try {
        new URL(value);
        return undefined;
      } catch {
        return "Please enter a valid URL";
      }
    },
  });

  if (p.isCancel(url)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const s = p.spinner();
  s.start("Checking MCP endpoint...");
  const ok = await healthPing(url);
  s.stop(
    ok
      ? "Endpoint is reachable"
      : "Endpoint did not respond — continuing anyway"
  );

  return normalizeMcpUrl(url);
}

export async function memoryInitCommand(
  options: MemoryInitOptions = {}
): Promise<void> {
  p.intro("Lobu memory");
  p.log.info("Configure agents to use the Lobu memory MCP endpoint.");

  const mcpUrl = await chooseMcpUrl(options.url);
  await runInitWizard(mcpUrl, {
    skipAuth: options.skipAuth,
    agent: options.agent,
  });

  p.outro("Done");
}
