import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  type BashOperations,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { buildDynamicOpenAIModel } from "../runtime/model-resolver";
import { resetSessionForProviderChange } from "../runtime/provider-session";
import {
  buildAgentSession,
  persistBangBashSession,
} from "../runtime/session-runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function durableSession(provider?: string): Promise<{
  directory: string;
  sessionFile: string;
  sessionManager: SessionManager;
  jsonl: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "provider-session-"));
  temporaryDirectories.push(directory);
  const sessionFile = join(directory, ".lobu", "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "durable-session",
      timestamp: "2026-07-14T00:00:00.000Z",
      cwd: directory,
    }),
    ...(provider
      ? [
          JSON.stringify({
            type: "model_change",
            id: "model",
            parentId: null,
            timestamp: "2026-07-14T00:00:01.000Z",
            provider,
            modelId: "model-a",
          }),
        ]
      : []),
    JSON.stringify({
      type: "message",
      id: "user",
      parentId: provider ? "model" : null,
      timestamp: "2026-07-14T00:00:02.000Z",
      message: { role: "user", content: "continue" },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp: "2026-07-14T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        provider: provider ?? "",
        model: "model-a",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    }),
  ];
  const jsonl = `${lines.join("\n")}\n`;
  await mkdir(join(directory, ".lobu"), { recursive: true });
  await writeFile(sessionFile, jsonl, "utf-8");
  return {
    directory,
    sessionFile,
    sessionManager: SessionManager.open(sessionFile),
    jsonl,
  };
}

describe("durable provider isolation", () => {
  test("upgrade snapshot resets on a provider change without a legacy sidecar", async () => {
    const session = await durableSession("anthropic");

    const note = await resetSessionForProviderChange({
      sessionFile: session.sessionFile,
      sessionManager: session.sessionManager,
      provider: "openai",
    });

    expect(note).toContain("changed from anthropic to openai");
    expect(note).toContain("2 messages");
    await expect(stat(session.sessionFile)).rejects.toThrow();
  });

  test("same-provider snapshot remains available across pods", async () => {
    const session = await durableSession("anthropic");

    const note = await resetSessionForProviderChange({
      sessionFile: session.sessionFile,
      sessionManager: session.sessionManager,
      provider: "anthropic",
    });

    expect(note).toBeUndefined();
    expect(await readFile(session.sessionFile, "utf-8")).toBe(session.jsonl);
  });

  test("non-empty snapshot without provider metadata fails closed", async () => {
    const session = await durableSession();

    const note = await resetSessionForProviderChange({
      sessionFile: session.sessionFile,
      sessionManager: session.sessionManager,
      provider: "openai",
    });

    expect(note).toContain("provider metadata was unavailable");
    await expect(stat(session.sessionFile)).rejects.toThrow();
  });

  test("provider reset followed by !-bash keeps model metadata for the next run", async () => {
    const previous = await durableSession("anthropic");
    const summary = await resetSessionForProviderChange({
      sessionFile: previous.sessionFile,
      sessionManager: previous.sessionManager,
      provider: "openai",
    });
    expect(summary).toContain("changed from anthropic to openai");

    const sessionManager = SessionManager.create(
      previous.directory,
      dirname(previous.sessionFile)
    );
    sessionManager.setSessionFile(previous.sessionFile);
    const { session } = await buildAgentSession({
      cwd: previous.directory,
      model: buildDynamicOpenAIModel({
        rawProvider: "openai",
        registryProvider: "openai",
        modelId: "stub-model",
        providerBaseUrl: "http://127.0.0.1:1/v1",
      }) as never,
      sessionManager,
      customTools: [],
      providerChangeSummary: summary,
    });
    const localOps: BashOperations = {
      exec: async (...args) => {
        args[2].onData(Buffer.from("provider-reset-bash\n"));
        return { exitCode: 0 };
      },
    };

    await session.executeBash("echo provider-reset-bash", undefined, {
      operations: localOps,
    });
    await persistBangBashSession(sessionManager, previous.sessionFile);
    session.dispose();

    const branch = SessionManager.open(previous.sessionFile).getBranch();
    expect(branch.map((entry) => entry.type)).toEqual([
      "model_change",
      "thinking_level_change",
      "custom_message",
      "message",
    ]);
    expect(
      branch.find(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "lobu.provider_change"
      )
    ).toBeDefined();

    const nextRunManager = SessionManager.open(previous.sessionFile);
    expect(
      await resetSessionForProviderChange({
        sessionFile: previous.sessionFile,
        sessionManager: nextRunManager,
        provider: "openai",
      })
    ).toBeUndefined();
    expect(await readFile(previous.sessionFile, "utf-8")).toContain(
      "provider-reset-bash"
    );
  });
});
