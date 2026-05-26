/**
 * End-to-end reproducer for Finding #1 (security): the agent's general bash
 * must NOT inherit the worker's gateway credentials.
 *
 * This drives the SAME wiring production uses: the worker captures
 * WORKER_TOKEN / DISPATCHER_URL from process.env for its OWN gateway calls,
 * builds the agent's built-in tools via createOpenClawTools (carrying the
 * env-strip spawnHook), and hands them to buildAgentSession. We then invoke
 * the resulting agent bash tool DIRECTLY with `printenv WORKER_TOKEN` /
 * `printenv DISPATCHER_URL` and assert both come back EMPTY — using a real
 * subprocess (no mocked BashOperations) so the assertion is about the actual
 * spawned environment.
 *
 * It also confirms the worker's own gateway call still authenticates with the
 * real token (read from its in-memory captured value, not the bash env).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawWorker } from "../openclaw/worker";
import { buildAgentSession } from "../openclaw/session-builder";
import { createOpenClawTools } from "../openclaw/tools";
import {
  callMcpTool,
  type GatewayParams,
} from "../shared/tool-implementations";
import { mockWorkerConfig } from "./setup";

const SECRET_TOKEN = "e2e-super-secret-worker-token";
const GATEWAY_URL = "http://gateway.internal:8080";

let tempDir: string;
let originalDispatcherUrl: string | undefined;
let originalWorkerToken: string | undefined;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "worker-bash-e2e-"));
  originalDispatcherUrl = process.env.DISPATCHER_URL;
  originalWorkerToken = process.env.WORKER_TOKEN;
  originalFetch = globalThis.fetch;
  process.env.DISPATCHER_URL = GATEWAY_URL;
  process.env.WORKER_TOKEN = SECRET_TOKEN;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  if (originalDispatcherUrl === undefined) {
    delete process.env.DISPATCHER_URL;
  } else {
    process.env.DISPATCHER_URL = originalDispatcherUrl;
  }
  if (originalWorkerToken === undefined) {
    delete process.env.WORKER_TOKEN;
  } else {
    process.env.WORKER_TOKEN = originalWorkerToken;
  }
});

function bashText(result: { content: unknown }): string {
  return (result.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("worker agent bash secret leak (E2E, Finding #1)", () => {
  test("agent bash sees NEITHER WORKER_TOKEN NOR DISPATCHER_URL", async () => {
    // Constructing the worker mirrors production startup: the constructor reads
    // the gateway credentials from process.env (and throws if absent).
    const worker = new OpenClawWorker(mockWorkerConfig);
    expect(worker).toBeDefined();

    // The agent's built-in tools the worker hands to the session.
    const tools = createOpenClawTools(tempDir);
    const { session } = await buildAgentSession({
      cwd: tempDir,
      tools,
      customTools: [],
    });

    const bash = session.agent.state.tools.find((t) => t.name === "bash");
    expect(bash).toBeDefined();

    // Use printenv (no `$VAR` literals) so the command isn't blocked by the
    // direct-gateway-access guard, which trips on literal $WORKER_TOKEN refs.
    // `printenv NAME` exits non-zero and prints nothing when NAME is unset.
    const result = await bash!.execute(
      "e2e-printenv",
      {
        command:
          "printenv WORKER_TOKEN || true; printenv DISPATCHER_URL || true; echo ---END---",
      },
      undefined,
      undefined
    );
    const text = bashText(result);

    // The secrets must be entirely absent from the spawned subprocess env.
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(GATEWAY_URL);
    expect(text).toContain("---END---");
    // Everything before the END marker (the printenv output) must be blank.
    const beforeMarker = text.slice(0, text.indexOf("---END---")).trim();
    expect(beforeMarker).toBe("");

    session.dispose();
  });

  test("worker's OWN gateway call still authenticates with the real token", async () => {
    // Build gwParams exactly as worker.runAISession does — from env. This is
    // the in-process captured value the worker uses; the bash env strip does
    // not touch it.
    const gwParams: GatewayParams = {
      gatewayUrl: process.env.DISPATCHER_URL ?? "",
      workerToken: process.env.WORKER_TOKEN ?? "",
      channelId: "ch",
      conversationId: "conv",
      platform: "telegram",
      workspaceDir: tempDir,
    };

    let capturedAuth = "";
    let capturedUrl = "";
    globalThis.fetch = (async (url: unknown, opts: any) => {
      capturedUrl = typeof url === "string" ? url : String(url);
      capturedAuth = opts?.headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof globalThis.fetch;

    const result = await callMcpTool(gwParams, "lobu", "list_connections", {});

    expect(capturedAuth).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(capturedUrl).toBe(`${GATEWAY_URL}/mcp/lobu/tools/list_connections`);
    expect(bashText(result)).toContain("ok");
  });
});
