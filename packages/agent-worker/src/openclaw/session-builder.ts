import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";

/**
 * Built-in tool names that Lobu rebuilds itself (via createOpenClawTools).
 * These carry the security-sensitive behavior — most importantly the bash
 * spawnHook that strips SENSITIVE_WORKER_ENV_KEYS and the embedded
 * BashOperations that route MCP/just-bash through the gateway. They must be
 * the instances the agent actually runs.
 */
const OVERRIDABLE_BUILTIN_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

/**
 * Build an agent session and ensure the Lobu-built built-in tools are the ones
 * the agent actually executes.
 *
 * Background: pi's `createAgentSession({ tools })` uses the `tools` option only
 * to derive the active tool NAMES — it rebuilds the underlying built-in tools
 * internally via `createAllTools(cwd, { bash: { commandPrefix } })`, whose bash
 * uses `getShellEnv()` = `{ ...process.env }` with no env strip and no custom
 * BashOperations. That silently discards the worker's hardened bash (the
 * spawnHook that strips WORKER_TOKEN/DISPATCHER_URL and the embedded
 * BashOperations), so the agent's general bash would inherit the worker's real
 * gateway credentials.
 *
 * The session keeps the active tool array on `agent.state.tools`, and tool
 * calls are resolved from that array by name at execution time. We swap the
 * rebuilt built-ins for the caller-provided Lobu instances after construction,
 * preserving every other aspect of `createAgentSession` (model resolution,
 * session restore, image blocking, extension/custom-tool wiring).
 */
export async function buildAgentSession(
  options: CreateAgentSessionOptions
): Promise<CreateAgentSessionResult> {
  const result = await createAgentSession(options);
  const { session } = result;

  const lobuBuiltins = new Map<string, AgentTool<any>>();
  for (const tool of options.tools ?? []) {
    if (OVERRIDABLE_BUILTIN_NAMES.has(tool.name)) {
      lobuBuiltins.set(tool.name, tool as AgentTool<any>);
    }
  }
  if (lobuBuiltins.size === 0) {
    return result;
  }

  const activeTools = session.agent.state.tools;
  const patched = activeTools.map(
    (tool) => lobuBuiltins.get(tool.name) ?? tool
  );
  session.agent.setTools(patched);

  return result;
}
