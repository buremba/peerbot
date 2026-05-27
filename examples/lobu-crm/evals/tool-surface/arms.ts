/**
 * Tool-surface eval — the two arms.
 *
 * Arm A (discrete MCP): every Lobu MCP tool is a first-class pi tool. This is
 *   the default cloud surface (`mcpExposure: "tools"`). Built via the same
 *   `createMcpToolDefinitions` shape the worker uses (name/label/desc/schema/
 *   execute), with execute routed to the real handler dispatcher.
 *
 * Arm B (just-bash / MCP-as-CLI): one `bash` tool, and the MCP tools are
 *   reachable as `lobu <tool> <<<'{json}'`, discoverable via `lobu --help` and
 *   `lobu <tool> --schema`. Built with the REAL worker code —
 *   `createEmbeddedBashOps({ mcpExposure: "cli", mcpRuntimeRef, gw })` +
 *   `buildMcpCliCommands` — with the gateway `callTool` dep swapped for the
 *   in-process dispatcher so it hits the same handlers as Arm A.
 *
 * Both arms run on glm-4.7 via the z-ai provider, with the model object
 * constructed exactly as the worker's model-resolver does.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bash, ReadWriteFs, defineCommand } from "just-bash";
import { Type } from "@sinclair/typebox";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { McpStatus, McpToolDef } from "@lobu/core";
import type { GatewayParams } from "../../../../packages/agent-worker/src/shared/tool-implementations";
import {
  buildMcpCliCommands,
  type McpRuntimeRef,
} from "../../../../packages/agent-worker/src/embedded/mcp-cli-commands";
import { createOpenClawTools } from "../../../../packages/agent-worker/src/openclaw/tools";
import { dispatchTool, discreteToolDefs, type ScenarioOrg } from "./scenario";

/**
 * Verbatim copy of the worker's `buildMcpCliInstructions` (not exported from
 * session-context.ts). Kept in sync with
 * packages/agent-worker/src/openclaw/session-context.ts so Arm B sees the exact
 * MCP-as-CLI prompt the real embedded worker injects.
 */
function buildMcpCliInstructions(mcpStatus: McpStatus[]): string {
  if (!mcpStatus || mcpStatus.length === 0) return "";
  const servers = mcpStatus.map((m) => `- \`${m.id}\` — ${m.name}`).join("\n");
  return `## Available MCP CLIs

MCP servers are exposed as Bash commands. One command per server. Invoke tools by piping JSON on stdin:

\`\`\`bash
<server> <tool> <<'EOF'
{ ...json args... }
EOF
\`\`\`

Discovery:
- \`<server> --help\` — list a server's tools
- \`<server> <tool> --schema\` — print the JSON Schema for a tool
- \`<server> auth login|check|logout\` — manage OAuth where required

Servers:
${servers}`;
}

const Z_AI_BASE_URL =
  process.env.Z_AI_API_BASE_URL || "https://api.z.ai/api/coding/paas/v4";

/** Build the glm-4.7 model object the way the worker model-resolver does. */
export function buildGlm47Model(): {
  model: unknown;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const key = process.env.Z_AI_API_KEY;
  if (!key)
    throw new Error("Z_AI_API_KEY is required to run real glm-4.7 evals.");

  let baseModel = getModel("zai" as never, "glm-4.7" as never) as never as
    | Record<string, unknown>
    | undefined;
  if (!baseModel) {
    baseModel = {
      id: "glm-4.7",
      name: "glm-4.7",
      api: "openai-completions",
      provider: "zai",
      baseUrl: Z_AI_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
  }
  // Third-party openai-compat endpoint: force supportsStore off (matches worker).
  const model = {
    ...baseModel,
    baseUrl: Z_AI_BASE_URL,
    compat: {
      ...((baseModel as { compat?: object }).compat ?? {}),
      supportsStore: false,
    },
  };

  const authStorage = new AuthStorage();
  authStorage.setRuntimeApiKey("zai", key);
  const modelRegistry = new ModelRegistry(authStorage);
  return { model, authStorage, modelRegistry };
}

/** The MCP tool definitions, packaged as a single "lobu" MCP server. */
function lobuMcpTools(): {
  mcpTools: Record<string, McpToolDef[]>;
  mcpStatus: McpStatus[];
} {
  const defs = discreteToolDefs();
  const tools: McpToolDef[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
  return {
    mcpTools: { lobu: tools },
    mcpStatus: [
      {
        id: "lobu",
        name: "Lobu",
        requiresAuth: false,
        requiresInput: false,
        authenticated: true,
        configured: true,
      },
    ],
  };
}

const SYSTEM_PROMPT_BASE = `You are the Lobu funnel CRM agent. The CRM lives in Lobu memory.

Two entity types hold current state: \`lead\` and \`pilot\`. Events of type \`lead:*\` / \`pilot:*\` are the append-only history. The \`converted-to\` relationship links a lead to the pilot it became.

Funnel stages (the \`stage\` field on a lead's metadata):
signal -> trial -> conversation -> pilot -> customer, plus \`cold\`.

You operate the CRM ONLY through the provided Lobu tools — never invent your own
storage (no local files, no sqlite). The tools that matter:
- \`manage_entity\` — create/update/list/get/link lead & pilot entities (action + entity_type + metadata).
- \`save_memory\` — append a memory event (content + semantic_type + entity_ids).

To FIND an existing lead: use \`search_memory\` (matches by name) or
\`manage_entity\` action="list" entity_type="lead", then read the returned entity's
\`id\` — that id is the entity_id you pass to save_memory / manage_entity update.
If a lookup returns nothing useful, fall back to a plain
\`manage_entity\` action="list" (no filter), which always returns every lead.

Rules:
- CREATE/ENRICH A LEAD: \`manage_entity\` action="create", entity_type="lead", metadata {name, company, source, stage, github_handle, email, notes}.
- ADVANCING A STAGE requires BOTH: (1) find the lead's id via \`manage_entity\` action="list", (2) \`save_memory\` with semantic_type "lead:stage_changed" and entity_ids=[<lead id>], AND (3) \`manage_entity\` action="update" with entity_id=<lead id> setting metadata.stage. Never change stage without the matching event.
- LOGGING AN INTERACTION: find the lead id (list), then \`save_memory\` with semantic_type "lead:interaction" and entity_ids=[<lead id>].
- OPENING A PILOT: \`manage_entity\` action="create" entity_type="pilot" {company, status:"active", lead_id, ...}; then a \`converted-to\` relationship from the lead to the pilot (manage_entity action="link"); \`save_memory\` semantic_type "pilot:created"; and move the lead's stage to "pilot".
- READ THE PIPELINE: list lead entities (\`manage_entity\` action="list" entity_type="lead"), then group by metadata.stage.

Complete the FULL task before replying — do not stop after a single lookup. When
the task is genuinely done, reply with a one-line confirmation.`;

export interface BuiltSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  arm: "A-discrete" | "B-bash-cli";
  /** Arm B only: tear down the out-of-process dispatcher. */
  dispose?: () => void;
}

/**
 * Spawn the out-of-process dispatcher (Arm B backing) and return its base URL.
 * See dispatcher-server.ts for why the DB work must live in a separate process.
 */
async function startDispatcher(): Promise<{
  url: string;
  dispose: () => void;
}> {
  const script = fileURLToPath(
    new URL("./dispatcher-server.ts", import.meta.url)
  );
  const proc = spawn("bun", [script], {
    env: { ...process.env, DISPATCHER_PORT: "0" },
    // Own process group so we can signal the whole tree; SIGTERM alone doesn't
    // reliably stop the http-server event loop, leaving orphaned children that
    // each hold a Postgres pool.
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  // SIGKILL the whole process group on dispose, with a SIGTERM first chance.
  const dispose = () => {
    try {
      process.kill(-proc.pid!, "SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }, 500).unref();
  };
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("dispatcher did not become ready within 30s"));
    }, 30_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = buf.match(/DISPATCHER_READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ url: `http://localhost:${m[1]}`, dispose });
      }
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("dispatcher exited before becoming ready"));
    });
  });
}

/** Arm A: discrete MCP tools as first-class pi custom tools. */
export async function buildArmA(scn: ScenarioOrg): Promise<BuiltSession> {
  const { model, authStorage, modelRegistry } = buildGlm47Model();
  const defs = discreteToolDefs();
  const customTools = defs.map((d) => ({
    name: d.name,
    label: `lobu/${d.name}`,
    description: d.description,
    parameters: d.inputSchema ? Type.Unsafe(d.inputSchema) : Type.Object({}),
    // pi's AgentTool.execute must return { content: [{type:"text", text}],
    // details }. Returning {output,isError} hands the model `undefined`, which
    // makes it stop after one call — the shape mismatch that invalidated the
    // first runs. Mirror createMcpToolDefinitions' `toToolResult` exactly.
    execute: async (_id: string, args: unknown) => {
      try {
        const result = await dispatchTool(
          scn.ctx,
          d.name,
          (args ?? {}) as Record<string, unknown>
        );
        const text =
          typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  }));

  const result = await createAgentSession({
    cwd: process.cwd(),
    model: model as never,
    authStorage,
    modelRegistry,
    tools: [],
    customTools: customTools as never,
  });
  // createAgentSession auto-activates pi's built-in custom tools (process,
  // subagent, ask_user, telegram_attach, …) alongside ours. The real cloud
  // "discrete MCP" surface is the MCP tools, not pi's process/subagent/bash —
  // those let the model wander off into shell exploration. Restrict the active
  // set to exactly our 23 MCP tools so Arm A measures the MCP surface.
  const mcpNames = new Set(defs.map((d) => d.name));
  const active = result.session.agent.state.tools as Array<{ name: string }>;
  result.session.agent.setTools(
    active.filter((t) => mcpNames.has(t.name)) as never
  );
  result.session.agent.setSystemPrompt(SYSTEM_PROMPT_BASE);
  return { session: result.session, arm: "A-discrete" };
}

/**
 * Arm B: one bash tool, MCP tools reachable as `lobu <tool> <<<'{json}'`.
 * Uses the REAL createEmbeddedBashOps + buildMcpCliCommands with the gateway
 * callTool dep swapped for the in-process dispatcher.
 */
export async function buildArmB(
  scn: ScenarioOrg,
  workspaceDir: string
): Promise<BuiltSession> {
  const { model, authStorage, modelRegistry } = buildGlm47Model();
  const { mcpTools, mcpStatus } = lobuMcpTools();

  const ref: McpRuntimeRef = {
    current: { mcpTools, mcpStatus, mcpContext: {} },
  };
  const gw: GatewayParams = {
    gatewayUrl: "",
    workerToken: "",
    channelId: "eval",
    conversationId: "eval",
    workspaceDir,
  };

  const dispatcher = await startDispatcher();

  // Everything after the dispatcher is spawned must tear it down on failure, or
  // a construction error (bad bashOps, session-build throw) leaks the child
  // process (each holds a Postgres pool).
  try {
    // Swap the gateway HTTP callTool for an HTTP call to the out-of-process
    // dispatcher. This mirrors production's `callMcpTool` exactly: the just-bash
    // command issues a fetch and the DB work runs in another process, so it
    // never touches the `Error.stackTraceLimit` that just-bash hardens during
    // command execution (the in-process dead-end in dispatcher-server.ts).
    const cliCommands = buildMcpCliCommands(ref, gw, {
      callTool: async (_gw, _mcpId, toolName, args) => {
        const res = await fetch(dispatcher.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ctx: scn.ctx,
            tool: toolName,
            args: args ?? {},
          }),
        });
        const j = (await res.json()) as {
          ok: boolean;
          out?: unknown;
          err?: string;
        };
        if (!j.ok) throw new Error(j.err || "dispatch failed");
        const text = typeof j.out === "string" ? j.out : JSON.stringify(j.out);
        return { content: [{ type: "text" as const, text }] };
      },
    });

    // We can't call createEmbeddedBashOps directly: it builds buildMcpCliCommands
    // from the real gateway HTTP `callTool` (no override hook), so it would try
    // to reach a gateway that isn't running. Instead we drive the SAME just-bash
    // primitives (Bash + ReadWriteFs + defineCommand + the identical exec limits)
    // with the CLI commands we built above (dispatcher-backed). The model-facing
    // surface — heredoc/quoting/`lobu <tool>` parsing — is byte-for-byte the
    // worker's.
    const bashOps = await buildEmbeddedBashWithCliCommands(
      workspaceDir,
      cliCommands,
      dispatcher.url
    );

    // Build the worker's real tool set (read/write/edit/bash/grep/find/ls) with
    // our embedded bashOps wired into bash, then keep only the bash tool — Arm
    // B's whole point is "one bash tool". createAgentSession rebuilds built-ins
    // from the active-name list, so we swap our hardened bash back in afterward.
    const openClawTools = createOpenClawTools(workspaceDir, {
      bashOperations: bashOps,
    });
    const bashTool = openClawTools.find((t) => t.name === "bash");
    if (!bashTool) throw new Error("bash tool not built");

    const result = await createAgentSession({
      cwd: workspaceDir,
      model: model as never,
      authStorage,
      modelRegistry,
      tools: [bashTool as never],
      customTools: [],
    });
    // Arm B's whole point is "ONE bash tool" (MCP reachable as `lobu <tool>`).
    // createAgentSession also auto-activates pi's process/subagent/read/write/
    // edit built-ins; drop them all and keep only our embedded bash, so the
    // agent's only path to the CRM is the MCP-as-CLI surface.
    result.session.agent.setTools([bashTool as never]);

    const cliInstructions = buildMcpCliInstructions(mcpStatus);
    result.session.agent.setSystemPrompt(
      `${SYSTEM_PROMPT_BASE}\n\n${cliInstructions}`
    );
    return {
      session: result.session,
      arm: "B-bash-cli",
      dispose: dispatcher.dispose,
    };
  } catch (err) {
    dispatcher.dispose();
    throw err;
  }
}

/**
 * Build a just-bash BashOperations with the given MCP CLI commands registered.
 * Mirrors createEmbeddedBashOps' wiring (ReadWriteFs root = workspace, exec
 * limits) but injects pre-built CLI commands so we control the callTool dep.
 * Reuses the same just-bash primitives the worker uses, so the parsing /
 * heredoc / quoting behaviour the model has to navigate is identical.
 */
async function buildEmbeddedBashWithCliCommands(
  workspaceDir: string,
  cliCommands: Array<{
    name: string;
    execute: (
      args: string[],
      ctx: { stdin?: string; signal?: AbortSignal }
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  }>,
  dispatcherUrl: string
): Promise<import("@mariozechner/pi-coding-agent").BashOperations> {
  mkdirSync(workspaceDir, { recursive: true });
  const bashFs = new ReadWriteFs({ root: workspaceDir });

  const customCommands = cliCommands.map((cmd) =>
    defineCommand(
      cmd.name,
      async (args: string[], ctx: { stdin?: string; signal?: AbortSignal }) => {
        const stdin = typeof ctx.stdin === "string" ? ctx.stdin : "";
        return cmd.execute(args, { stdin, signal: ctx.signal });
      }
    )
  );

  const bashInstance = new Bash({
    fs: bashFs,
    cwd: "/",
    env: {},
    executionLimits: {
      maxCommandCount: 50_000,
      maxLoopIterations: 50_000,
      maxCallDepth: 50,
    },
    // The CLI commands fetch the out-of-process dispatcher; allow that origin so
    // just-bash's network gate doesn't block the MCP round-trip.
    network: {
      allowedUrlPrefixes: [`${dispatcherUrl}/`],
      allowedMethods: ["POST"],
    },
    customCommands,
  });

  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const timeoutMs =
        timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
      const result = await bashInstance.exec(command, {
        cwd,
        signal,
        env: { TIMEOUT_MS: timeoutMs ? String(timeoutMs) : "" },
      });
      if (result.stdout) onData(Buffer.from(result.stdout));
      if (result.stderr) onData(Buffer.from(result.stderr));
      return { exitCode: result.exitCode };
    },
  };
}
