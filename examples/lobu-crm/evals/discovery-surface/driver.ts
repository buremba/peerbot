/**
 * Discovery-surface eval — the single arm (discrete default-cloud MCP surface,
 * driven by real Gemini Flash in-process via pi-ai).
 *
 * The agent gets ONLY the default cloud MCP tools (search_memory, save_memory,
 * search_sdk, query_sdk, query_sql, run_sdk) as first-class pi custom tools,
 * each routed to its real handler via the scenario dispatcher. There is no CRM
 * skill, no per-operation how-to — only a short operator-persona system prompt
 * that names the discovery path. Success requires the model to DISCOVER the
 * right SDK method (via search_sdk / the tool descriptions) and execute it.
 *
 * The model object is built the way the worker's model-resolver treats the
 * "gemini" provider: pi-ai's registry entry for `gemini-2.5-flash` (provider
 * "google", api "google-generative-ai"), with the API key injected at runtime.
 * GEMINI_API_KEY (and optional GEMINI_MODEL_ID) come from the environment.
 */

import { Type } from "@sinclair/typebox";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import { dispatchTool, defaultMcpToolDefs, type ScenarioOrg } from "./scenario";

/** Model id to drive. Defaults to gemini-2.5-flash; override with GEMINI_MODEL_ID. */
export const GEMINI_MODEL_ID =
  process.env.GEMINI_MODEL_ID || "gemini-2.5-flash";

/**
 * Build the Gemini model object. The worker's model-resolver routes the
 * "gemini" gateway slug to the pi-ai registry provider "google" and injects the
 * GEMINI_API_KEY. We do the same: take the registry entry and put the key in
 * AuthStorage under "google". When GEMINI_API_BASE_URL is set (the gateway
 * proxy in prod), override baseUrl to match.
 */
export function buildGeminiModel(): {
  model: unknown;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is required to run the real discovery eval. " +
        "Source it from the repo .env (see run.sh)."
    );
  }

  const base = getModel(
    "google" as never,
    GEMINI_MODEL_ID as never
  ) as unknown as Record<string, unknown> | undefined;
  if (!base) {
    throw new Error(
      `pi-ai has no registry entry for google/${GEMINI_MODEL_ID}. ` +
        "Pick an id from node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts."
    );
  }
  const baseUrl = process.env.GEMINI_API_BASE_URL;
  const model = baseUrl ? { ...base, baseUrl } : base;

  // inMemory() avoids touching ~/.pi on disk; setRuntimeApiKey injects the key
  // under the "google" provider the model resolves to (matching how the worker's
  // model-resolver injects GEMINI_API_KEY for the gemini gateway slug).
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("google", key);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  return { model, authStorage, modelRegistry };
}

const SYSTEM_PROMPT = `You are an operator's agent for a Lobu workspace. You act on the workspace ONLY through the Lobu MCP tools you have been given — you have no other storage, shell, or filesystem.

You are NOT told in advance which method performs a given task. Your job is to DISCOVER the right capability and use it:
- Use \`search_sdk\` to find SDK methods by intent or namespace (e.g. "connections", "feeds", "automations", "schedules", "entities"). It returns method signatures and examples.
- Use \`query_sdk\` (read) or \`run_sdk\` (write) to call the SDK: write a small TypeScript script that does \`export default async (ctx, client) => { ... }\` and use the \`client\` methods you discovered.
- Use \`query_sql\` for read-only SQL over the workspace tables, and \`search_memory\` / \`save_memory\` for workspace knowledge.

Rules:
- When a first attempt fails with a schema/argument error, READ the error, call \`search_sdk\` for the exact method to learn its signature, and retry — do not give up after one failure.
- Complete the FULL task before replying. For read/question tasks, state the concrete answer (names, counts, tables) in your final reply.
- Reply with a one-line confirmation when the task is genuinely done.`;

export interface BuiltSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
}

/** Build the discovery agent: the ~6 default MCP tools, routed to real handlers. */
export async function buildDiscoveryAgent(
  scn: ScenarioOrg
): Promise<BuiltSession> {
  const { model, authStorage, modelRegistry } = buildGeminiModel();
  const defs = defaultMcpToolDefs();

  // Build the MCP tools as pi AgentTools and assign them directly to the agent's
  // tool state. createAgentSession also auto-loads pi's built-in tools (read,
  // bash, edit, write, process, subagent, …); the default cloud discovery
  // surface is ONLY the MCP tools — the whole point is the model must reach every
  // capability through search_sdk/run_sdk, not a local shell — so we REPLACE the
  // tool set with exactly our MCP tools.
  const agentTools = defs.map((d) => ({
    name: d.name,
    label: `lobu/${d.name}`,
    description: d.description,
    parameters: d.inputSchema ? Type.Unsafe(d.inputSchema) : Type.Object({}),
    // AgentTool.execute(toolCallId, params, signal, onUpdate) must return
    // { content: [{type:"text", text}], details }. Mirror the gateway's
    // toToolResult exactly so the model gets real text back (a shape mismatch
    // hands the model `undefined` and it stops after one call).
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        const result = await dispatchTool(
          scn.ctx,
          d.name,
          (params ?? {}) as Record<string, unknown>
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
    customTools: [],
  });

  result.session.agent.state.tools = agentTools as never;
  result.session.agent.state.systemPrompt = SYSTEM_PROMPT;
  return { session: result.session };
}
