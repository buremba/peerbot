/**
 * Provider-only turn context must reach every model iteration without becoming
 * part of the durable user transcript. This boots a real Pi AgentSession,
 * drives text, tool-loop, image, and context-cleared turns through an
 * OpenAI-compatible stub, and then reads the session.jsonl Pi wrote. A
 * request-only assertion would miss the persistence leak that made private
 * workspace attention render as if the user typed it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { titleFromSessionJsonl } from "@lobu/core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildDynamicOpenAIModel } from "../runtime/model-resolver";
import { buildAgentSession } from "../runtime/session-runner";

const STUB_BASE_URL = "http://127.0.0.1:1/v1";
const USER_PROMPT = "hi";
const IMAGE_PROMPT = "what is in this image?";
const NEXT_PROMPT = "thanks";
const TEST_IMAGE = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};
const PRIVATE_CONTEXT = [
  "## Workspace attention (recent)",
  "- Private signal the model needs for this turn.",
].join("\n");

function completionStream(options?: { callTool?: boolean }): string {
  const base = {
    id: "chatcmpl_turn_context",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
  };
  const events = options?.callTool
    ? [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_context_1",
                    type: "function",
                    function: { name: "echo_context", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]
    : [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "ok" },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];

  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("");
}

let tempDir: string;
let realFetch: typeof globalThis.fetch;
let requestBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "transient-turn-context-"));
  requestBodies = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(STUB_BASE_URL)) {
      return realFetch(input as never, init);
    }
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(
      completionStream({ callTool: requestBodies.length === 1 }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("transient turn context (real Pi session E2E)", () => {
  test("reaches active provider iterations but never durable user messages", async () => {
    const sessionFile = join(tempDir, ".lobu", "session.jsonl");
    const sessionManager = SessionManager.create(tempDir, dirname(sessionFile));
    sessionManager.setSessionFile(sessionFile);

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("openai", "stub-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const echoTool: AgentTool = {
      name: "echo_context",
      label: "echo_context",
      description: "Return a deterministic result for the context test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "tool-ok" }],
        details: {},
      }),
    };

    let transientContext = PRIVATE_CONTEXT;
    const sessionOptions = {
      cwd: tempDir,
      model: buildDynamicOpenAIModel({
        rawProvider: "openai",
        registryProvider: "openai",
        modelId: "stub-model",
        providerBaseUrl: STUB_BASE_URL,
      }) as never,
      tools: [echoTool.name],
      customTools: [echoTool],
      authStorage,
      modelRegistry,
      getTransientTurnContext: () => transientContext,
      sessionManager,
    };
    const { session } = await buildAgentSession(
      sessionOptions as Parameters<typeof buildAgentSession>[0]
    );

    try {
      await session.prompt(USER_PROMPT);
      await session.prompt(IMAGE_PROMPT, { images: [TEST_IMAGE] });
      transientContext = "";
      await session.prompt(NEXT_PROMPT);
    } finally {
      session.dispose();
    }

    expect(requestBodies).toHaveLength(4);
    for (const body of requestBodies.slice(0, 2)) {
      const messages = body.messages as Array<{
        role: string;
        content: unknown;
      }>;
      const user = messages.find((message) => message.role === "user");
      expect(contentText(user?.content)).toBe(
        `${PRIVATE_CONTEXT}\n\n${USER_PROMPT}`
      );
    }
    const imageRequestMessages = requestBodies[2]?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const imageRequestUser = imageRequestMessages.findLast(
      (message) => message.role === "user"
    );
    expect(contentText(imageRequestUser?.content)).toBe(
      `${PRIVATE_CONTEXT}\n\n${IMAGE_PROMPT}`
    );
    expect(imageRequestUser?.content).toContainEqual({
      type: "image_url",
      image_url: {
        url: `data:${TEST_IMAGE.mimeType};base64,${TEST_IMAGE.data}`,
      },
    });

    const nextRequestMessages = requestBodies[3]?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const nextRequestUser = nextRequestMessages.findLast(
      (message) => message.role === "user"
    );
    expect(contentText(nextRequestUser?.content)).toBe(NEXT_PROMPT);

    const jsonl = readFileSync(sessionFile, "utf-8");
    const entries = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const userEntries = entries.filter(
      (entry) =>
        entry.type === "message" &&
        (entry.message as { role?: string } | undefined)?.role === "user"
    );
    expect(
      userEntries.map((entry) =>
        contentText((entry.message as { content?: unknown }).content)
      )
    ).toEqual([USER_PROMPT, IMAGE_PROMPT, NEXT_PROMPT]);
    expect(
      (userEntries[1]?.message as { content?: unknown }).content
    ).toContainEqual(TEST_IMAGE);
    expect(jsonl).not.toContain(PRIVATE_CONTEXT);
    expect(titleFromSessionJsonl(jsonl, "fallback")).toBe(USER_PROMPT);
  });
});
