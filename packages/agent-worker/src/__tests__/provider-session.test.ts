import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resetSessionForProviderChange } from "../runtime/provider-session";

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
});
