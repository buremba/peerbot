import * as p from "@clack/prompts";
import { DEFAULT_LOBU_MCP_URL } from "../internal/context.js";
import { detectAgents } from "./connect/agent-detect.js";
import {
  buildConnectPlan,
  CONNECT_TARGET_IDS,
  type ConnectTargetId,
  configureTarget,
  isConnectTargetId,
} from "./connect/install-targets.js";
import { normalizeMcpUrl } from "./memory/_lib/memory-auth.js";

export interface ConnectOptions {
  url?: string;
  dryRun?: boolean;
}

// `url` is always the output of `normalizeMcpUrl`, so it parses. `new URL()`
// keeps IPv6 hosts bracketed, so `::1` only ever arrives here as `[::1]`.
function isLocalUrl(url: string): boolean {
  const hostname = new URL(url).hostname;
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

async function chooseTarget(target?: string): Promise<ConnectTargetId | null> {
  if (target) {
    if (!isConnectTargetId(target)) {
      throw new Error(
        `Unknown agent "${target}". Choose one of: ${CONNECT_TARGET_IDS.join(", ")}.`
      );
    }
    return target;
  }

  const spinner = p.spinner();
  spinner.start("Finding agents on this machine...");
  const agents = detectAgents();
  spinner.stop("Agent detection complete");

  const selected = await p.select({
    message: "Which agent do you want to connect?",
    options: agents.map((agent) => ({
      value: agent.id,
      label: agent.name,
      hint: agent.detected
        ? agent.path || "installed"
        : agent.kind === "manual"
          ? "manual setup"
          : "not detected",
    })),
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    return null;
  }
  return selected;
}

export async function connectCommand(
  targetArg?: string,
  options: ConnectOptions = {}
): Promise<void> {
  p.intro("Connect an agent to Lobu");
  const target = await chooseTarget(targetArg);
  if (!target) return;
  const mcpUrl = normalizeMcpUrl(options.url || DEFAULT_LOBU_MCP_URL);

  if (isLocalUrl(mcpUrl)) {
    p.note(
      "This endpoint is only reachable from this machine. Use a public URL or tunnel for a remote agent.",
      "Local MCP endpoint"
    );
  }

  const plan = buildConnectPlan(target, mcpUrl);
  const result = await configureTarget(plan, { dryRun: options.dryRun });
  if (result.status === "failed") {
    if (result.instructions) p.note(result.instructions, "Try manually");
    throw new Error(result.message);
  }

  if (result.instructions) {
    p.note(
      result.instructions,
      result.status === "manual" ? "Finish setup" : "Next step"
    );
  }

  if (result.status === "configured") p.log.success(result.message);
  else p.log.info(result.message);
  p.outro(
    "OAuth happens in the agent on first Lobu use. Local Automation delivery remains separate."
  );
}
