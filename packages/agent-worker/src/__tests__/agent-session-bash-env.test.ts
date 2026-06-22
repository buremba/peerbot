/**
 * Reproducer for the WORKER_TOKEN / DISPATCHER_URL leak (Finding #1) and the
 * discarded embeddedBashOps (Finding #10).
 *
 * The worker builds its bash tool via createOpenClawTools() with a spawnHook
 * that strips SENSITIVE_WORKER_ENV_KEYS and (optionally) custom BashOperations.
 * Those instances must be the ones the agent actually runs. We assert that the
 * bash tool the session ends up with both strips the secrets and uses the
 * provided BashOperations — i.e. the Lobu-built bash is not silently discarded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { buildAgentSession } from "../openclaw/session-runner";
import { createOpenClawTools } from "../openclaw/tools";
import { SENSITIVE_WORKER_ENV_KEYS } from "../shared/worker-env-keys";

let tempDir: string;
let originalDispatcherUrl: string | undefined;
let originalWorkerToken: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "agent-session-bash-env-"));
  originalDispatcherUrl = process.env.DISPATCHER_URL;
  originalWorkerToken = process.env.WORKER_TOKEN;
  process.env.DISPATCHER_URL = "http://gateway:8080";
  process.env.WORKER_TOKEN = "super-secret-worker-token";
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
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

function getBashTool(tools: { name: string }[]) {
  const bash = tools.find((t) => t.name === "bash");
  if (!bash) {
    throw new Error("bash tool not present on session");
  }
  return bash as any;
}

describe("agent session bash inherits Lobu-built bash (Findings #1, #10)", () => {
  test("session bash strips SENSITIVE_WORKER_ENV_KEYS from the spawned env", async () => {
    const builtins = createOpenClawTools(tempDir);
    const { session } = await buildAgentSession({
      cwd: tempDir,
      tools: builtins.map((t) => t.name),
      builtinOverrides: builtins,
      customTools: [],
    });

    const bash = getBashTool(session.agent.state.tools);
    const result = await bash.execute(
      "leak-check",
      { command: "printenv WORKER_TOKEN; printenv DISPATCHER_URL; echo END" },
      undefined,
      undefined
    );
    const text = (result.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // The agent's bash must NOT see the worker's gateway credentials.
    expect(text).not.toContain("super-secret-worker-token");
    expect(text).not.toContain("http://gateway:8080");
    // sanity: the command actually ran
    expect(text).toContain("END");

    session.dispose();
  });

  test("session bash routes through the provided BashOperations", async () => {
    let capturedCommand = "";
    const mockBashOps: BashOperations = {
      exec: async (command, _cwd, { onData }) => {
        capturedCommand = command;
        onData(Buffer.from("from-custom-ops\n"));
        return { exitCode: 0 };
      },
    };

    const builtins = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const { session } = await buildAgentSession({
      cwd: tempDir,
      tools: builtins.map((t) => t.name),
      builtinOverrides: builtins,
      customTools: [],
    });

    const bash = getBashTool(session.agent.state.tools);
    const result = await bash.execute(
      "ops-check",
      { command: "echo hello-ops" },
      undefined,
      undefined
    );
    const text = (result.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    expect(capturedCommand).toContain("echo hello-ops");
    expect(text).toContain("from-custom-ops");

    session.dispose();
  });

  test("the agent's active built-ins ARE the Lobu-built instances", async () => {
    const lobuTools = createOpenClawTools(tempDir);
    const lobuByName = new Map(lobuTools.map((t) => [t.name, t]));

    const { session } = await buildAgentSession({
      cwd: tempDir,
      tools: lobuTools.map((t) => t.name),
      builtinOverrides: lobuTools,
      customTools: [],
    });

    // Every built-in the agent can run must be the exact Lobu instance, not
    // pi's rebuilt one — that is what carries the env-strip spawnHook and the
    // embedded BashOperations.
    for (const tool of session.agent.state.tools) {
      const lobuTool = lobuByName.get(tool.name);
      if (lobuTool) {
        expect(tool).toBe(lobuTool);
      }
    }
    // bash specifically must be present and swapped.
    const bash = session.agent.state.tools.find((t) => t.name === "bash");
    expect(bash).toBe(lobuByName.get("bash"));

    session.dispose();
  });

  test("SENSITIVE_WORKER_ENV_KEYS covers the worker gateway creds", () => {
    expect(SENSITIVE_WORKER_ENV_KEYS).toContain("WORKER_TOKEN");
    expect(SENSITIVE_WORKER_ENV_KEYS).toContain("DISPATCHER_URL");
  });
});
