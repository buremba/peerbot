/**
 * Does the Lobu system prompt actually reach the model?
 *
 * Every earlier prompt test asserted the string the worker *composed*. That is
 * not the same question, and the difference hid a live defect: the worker
 * assigned its composed prompt to `session.agent.state.systemPrompt` once after
 * constructing the session, and `AgentSession.prompt()` reassigns that field on
 * every call — to whatever a `before_agent_start` handler returns, or back to
 * pi's own base prompt when nothing returns one. With no handler registered,
 * the Lobu prompt was overwritten before the first request was ever built, and
 * the model received pi's stock coding-harness prompt instead.
 *
 * So these tests read the outgoing provider request. `session.prompt()` runs
 * for real against a stubbed provider endpoint, and the assertions are made
 * against the system message on the wire — the only artifact that answers the
 * question being asked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { buildDynamicOpenAIModel } from "../runtime/model-resolver";
import { buildAgentSession } from "../runtime/session-runner";
import { createLobuSystemPromptRenderer } from "../runtime/system-prompt";
import { createLobuTools } from "../runtime/tools";

const IDENTITY = "You are Aria, Acme's support agent.";
const GATEWAY_TAIL = [
  "## Platform: Slack",
  "",
  "## MCP Server Instructions",
  "",
  "### lobu-memory",
  "Recall before asking.",
].join("\n");

const PI_OPENER = "expert coding assistant operating inside pi";
const PI_DOCS = "Pi documentation";

/** A minimal OpenAI-compatible stream: one content chunk, then stop. */
const STUB_STREAM = [
  `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "ok" },
        finish_reason: null,
      },
    ],
  })}`,
  "",
  `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const STUB_BASE_URL = "http://127.0.0.1:1/v1";

let tempDir: string;
let realFetch: typeof globalThis.fetch;
let requestBodies: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "prompt-delivery-"));
  requestBodies = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith(STUB_BASE_URL)) {
      requestBodies.push(String(init?.body ?? ""));
      return new Response(STUB_STREAM, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Boot a real session the way `runAISession` does and take one real turn.
 * Returns the base prompt (before any turn) and the system message the provider
 * actually received.
 */
async function runOneTurn(options?: { withTools?: boolean }): Promise<{
  basePrompt: string;
  deliveredSystemPrompt: string;
}> {
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("openai", "stub-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const tools = options?.withTools ? createLobuTools(tempDir) : [];

  const { session } = await buildAgentSession({
    cwd: tempDir,
    model: buildDynamicOpenAIModel({
      rawProvider: "openai",
      registryProvider: "openai",
      modelId: "stub-model",
      providerBaseUrl: STUB_BASE_URL,
    }) as never,
    tools: tools.map((tool) => tool.name),
    builtinOverrides: tools,
    customTools: [],
    authStorage,
    modelRegistry,
    renderSystemPrompt: createLobuSystemPromptRenderer({
      identity: IDENTITY,
      gatewayInstructions: GATEWAY_TAIL,
      cwd: tempDir,
    }),
  });

  const basePrompt = session.systemPrompt;
  try {
    await session.prompt("who are you");
  } finally {
    session.dispose();
  }

  expect(requestBodies).toHaveLength(1);
  const body = JSON.parse(requestBodies[0]) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const system = body.messages.find((message) => message.role === "system");
  const content = system?.content;
  return {
    basePrompt,
    deliveredSystemPrompt:
      typeof content === "string" ? content : JSON.stringify(content),
  };
}

describe("system prompt delivery (real turn, real provider request)", () => {
  test("the agent's identity and the gateway instructions reach the model", async () => {
    const { deliveredSystemPrompt } = await runOneTurn();

    // The regression: before the before_agent_start handler existed, none of
    // these survived pi's per-turn reset.
    expect(deliveredSystemPrompt.startsWith(IDENTITY)).toBe(true);
    expect(deliveredSystemPrompt).toContain("## Platform: Slack");
    expect(deliveredSystemPrompt).toContain("### lobu-memory");
    expect(deliveredSystemPrompt).toContain("Recall before asking.");
  });

  test("no pi harness framing or pi documentation reaches the model", async () => {
    const { deliveredSystemPrompt } = await runOneTurn();

    expect(deliveredSystemPrompt).not.toContain(PI_OPENER);
    // The docs block described pi's own SDK/TUI to a Lobu agent.
    expect(deliveredSystemPrompt).not.toContain(PI_DOCS);
    expect(deliveredSystemPrompt).not.toContain("node_modules");
  });

  test("the base prompt is Lobu's too, so a failed handler cannot fall back to pi's", async () => {
    const { basePrompt } = await runOneTurn();

    expect(basePrompt.startsWith(IDENTITY)).toBe(true);
    expect(basePrompt).not.toContain(PI_OPENER);
    expect(basePrompt).not.toContain(PI_DOCS);
    expect(basePrompt.split("Current date:").length - 1).toBe(1);
    expect(basePrompt.split("Current working directory:").length - 1).toBe(1);
  });

  test("pi's per-tool guidelines survive, described for the tools actually given", async () => {
    const { deliveredSystemPrompt } = await runOneTurn({ withTools: true });

    // Snippets pi registers for its built-ins.
    expect(deliveredSystemPrompt).toContain("Available tools:");
    expect(deliveredSystemPrompt).toContain("- read: Read file contents");
    // Guidelines the edit tool registers — these carry real call semantics, so
    // they are read from pi's live build options rather than copied into Lobu.
    expect(deliveredSystemPrompt).toContain(
      "edits[].oldText must match exactly"
    );
    // Derived from the tools actually active, not asserted blindly.
    expect(deliveredSystemPrompt).toContain(
      "Prefer grep/find/ls tools over bash"
    );
  });

  test("identity precedes the tool section, which precedes the gateway tail", async () => {
    const { deliveredSystemPrompt } = await runOneTurn({ withTools: true });

    const identityAt = deliveredSystemPrompt.indexOf(IDENTITY);
    const toolsAt = deliveredSystemPrompt.indexOf("Available tools:");
    const gatewayAt = deliveredSystemPrompt.indexOf("## Platform: Slack");
    const cwdAt = deliveredSystemPrompt.indexOf("Current working directory:");

    expect(identityAt).toBe(0);
    expect(toolsAt).toBeGreaterThan(identityAt);
    expect(gatewayAt).toBeGreaterThan(toolsAt);
    expect(cwdAt).toBeGreaterThan(gatewayAt);
  });

  test("a session with no tools still delivers identity and gateway instructions", async () => {
    const { deliveredSystemPrompt } = await runOneTurn({ withTools: false });

    expect(deliveredSystemPrompt).not.toContain("Available tools:");
    expect(deliveredSystemPrompt.startsWith(IDENTITY)).toBe(true);
    expect(deliveredSystemPrompt).toContain("### lobu-memory");
  });
});
