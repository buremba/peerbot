import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { PiAiApi } from "@lobu/core";
import { completeSimple, type Context, type Model } from "@mariozechner/pi-ai";
import { buildDynamicOpenAIModel } from "../runtime/model-resolver";

type Protocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "openai-codex-responses";

interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

interface StrictServer {
  origin: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

const servers: StrictServer[] = [];

// Loading the real provider adapters can take several seconds on a cold Bun
// process; the upstream itself is local and still has a short request timeout.
setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function writeSse(
  res: ServerResponse,
  events: unknown[],
  namedEvents = false
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  for (const event of events) {
    if (namedEvents && typeof event === "object" && event !== null) {
      const type = (event as { type?: unknown }).type;
      if (typeof type === "string") res.write(`event: ${type}\n`);
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function openAIResponsesEvents(model: string): unknown[] {
  const textItem = {
    id: "msg_protocol_1",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: "adapter-ok",
        annotations: [],
      },
    ],
    status: "completed",
  };
  const toolItem = {
    id: "fc_protocol_1",
    type: "function_call",
    call_id: "call_protocol_1",
    name: "get_weather",
    arguments: '{"city":"Paris"}',
    status: "completed",
  };
  return [
    {
      type: "response.created",
      response: { id: "resp_protocol_1", model, status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      item: { ...textItem, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", delta: "adapter-ok" },
    { type: "response.output_item.done", item: textItem },
    {
      type: "response.output_item.added",
      item: { ...toolItem, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      delta: '{"city":"Paris"}',
    },
    {
      type: "response.function_call_arguments.done",
      arguments: '{"city":"Paris"}',
    },
    { type: "response.output_item.done", item: toolItem },
    {
      type: "response.completed",
      response: {
        id: "resp_protocol_1",
        model,
        status: "completed",
        output: [textItem, toolItem],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function anthropicEvents(model: string): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_protocol_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "adapter-ok" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_protocol_1",
        name: "get_weather",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
}

function openAICompletionEvents(model: string): unknown[] {
  const base = {
    id: "chatcmpl_protocol_1",
    object: "chat.completion.chunk",
    created: 1,
    model,
  };
  return [
    {
      ...base,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      ...base,
      choices: [
        { index: 0, delta: { content: "adapter-ok" }, finish_reason: null },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_protocol_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
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
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

async function startStrictServer(args: {
  protocol: Protocol;
  expectedPath: string;
  model: string;
}): Promise<StrictServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== args.expectedPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected protocol path" }));
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      });

      const events =
        args.protocol === "anthropic-messages"
          ? anthropicEvents(args.model)
          : args.protocol === "openai-completions"
            ? openAICompletionEvents(args.model)
            : openAIResponsesEvents(args.model);
      writeSse(res, events, args.protocol === "anthropic-messages");
    });
  });

  const strictServer = await new Promise<StrictServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("strict provider server did not expose a TCP port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done, closeReject) => {
            if (!server.listening) {
              done();
              return;
            }
            server.close((error) => (error ? closeReject(error) : done()));
          }),
      });
    });
  });
  servers.push(strictServer);
  return strictServer;
}

function dynamicModel(args: {
  rawProvider: string;
  registryProvider: string;
  model: string;
  api: PiAiApi;
  baseUrl: string;
}): Model<any> {
  return buildDynamicOpenAIModel({
    rawProvider: args.rawProvider,
    registryProvider: args.registryProvider,
    modelId: args.model,
    providerBaseUrl: args.baseUrl,
    api: args.api,
  }) as Model<any>;
}

function fakeCodexToken(): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_protocol_test",
    },
  })}.signature`;
}

const context: Context = {
  systemPrompt: "Protocol conformance test",
  messages: [
    {
      role: "user",
      content: "Use get_weather for Paris.",
      timestamp: 1,
    },
  ],
  tools: [
    {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      } as never,
    },
  ],
};

async function exercise(args: {
  label: string;
  protocol: Protocol;
  rawProvider: string;
  registryProvider: string;
  api: PiAiApi;
  model: string;
  basePath: string;
  endpointPath: string;
  apiKey?: string;
}): Promise<void> {
  const strict = await startStrictServer({
    protocol: args.protocol,
    expectedPath: args.endpointPath,
    model: args.model,
  });
  const baseUrl = `${strict.origin}${args.basePath}`;
  const model = dynamicModel({
    rawProvider: args.rawProvider,
    registryProvider: args.registryProvider,
    model: args.model,
    api: args.api,
    baseUrl,
  });
  const apiKey = args.apiKey ?? "protocol-test-secret";

  const response = await completeSimple(model, context, {
    apiKey,
    cacheRetention: "none",
    maxRetries: 0,
    maxTokens: 128,
    timeoutMs: 10_000,
    ...(args.protocol === "openai-codex-responses"
      ? { transport: "sse" as const }
      : {}),
  });

  expect(response.stopReason, `${args.label}: parsed stop reason`).toBe(
    "toolUse"
  );
  expect(
    response.content.some(
      (block) => block.type === "text" && block.text === "adapter-ok"
    ),
    `${args.label}: streamed text was parsed`
  ).toBe(true);
  expect(
    response.content.find((block) => block.type === "toolCall"),
    `${args.label}: streamed tool call was parsed`
  ).toMatchObject({
    type: "toolCall",
    name: "get_weather",
    arguments: { city: "Paris" },
  });

  expect(
    strict.requests,
    `${args.label}: exactly one upstream request`
  ).toHaveLength(1);
  const request = strict.requests[0]!;
  expect(request.path).toBe(args.endpointPath);
  expect(request.body.model).toBe(args.model);
  expect(request.body.stream).toBe(true);
  expect(Array.isArray(request.body.tools)).toBe(true);

  if (args.protocol === "anthropic-messages") {
    expect(request.headers["x-api-key"]).toBe(apiKey);
    expect(request.body.messages).toBeArray();
  } else {
    expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
  }
  if (
    args.protocol === "openai-responses" ||
    args.protocol === "openai-codex-responses"
  ) {
    expect(request.body.input).toBeArray();
  } else if (args.protocol === "openai-completions") {
    expect(request.body.messages).toBeArray();
    expect(
      request.body.store,
      `${args.label}: third-party compat payload must omit OpenAI-only store`
    ).toBeUndefined();
  }
  if (args.protocol === "openai-codex-responses") {
    expect(request.headers["chatgpt-account-id"]).toBe("acct_protocol_test");
    expect(request.body.instructions).toBe("Protocol conformance test");
  }
}

describe("production provider protocol adapters", () => {
  test("Anthropic uses Messages with x-api-key and parses streamed tools", () =>
    exercise({
      label: "anthropic",
      protocol: "anthropic-messages",
      rawProvider: "claude",
      registryProvider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-5",
      basePath: "",
      endpointPath: "/v1/messages",
    }));

  test("OpenAI API uses Responses and parses streamed tools", () =>
    exercise({
      label: "openai",
      protocol: "openai-responses",
      rawProvider: "openai",
      registryProvider: "openai",
      api: "openai-responses",
      model: "gpt-5.6-sol",
      basePath: "/v1",
      endpointPath: "/v1/responses",
    }));

  test("Gemini uses its OpenAI-compatible Chat Completions base", () =>
    exercise({
      label: "gemini",
      protocol: "openai-completions",
      rawProvider: "gemini",
      registryProvider: "openai",
      api: "openai-completions",
      model: "gemini-2.5-pro",
      basePath: "/v1beta/openai",
      endpointPath: "/v1beta/openai/chat/completions",
    }));

  test("OpenRouter preserves vendor model namespaces over Chat Completions", () =>
    exercise({
      label: "openrouter",
      protocol: "openai-completions",
      rawProvider: "openrouter",
      registryProvider: "openai",
      api: "openai-completions",
      model: "anthropic/claude-sonnet-5",
      basePath: "/api/v1",
      endpointPath: "/api/v1/chat/completions",
    }));

  test("ChatGPT subscription uses Codex Responses with account-bound auth", () =>
    exercise({
      label: "chatgpt",
      protocol: "openai-codex-responses",
      rawProvider: "openai-codex",
      registryProvider: "openai-codex",
      api: "openai-codex-responses",
      model: "gpt-5.1-codex-max",
      basePath: "/backend-api",
      endpointPath: "/backend-api/codex/responses",
      apiKey: fakeCodexToken(),
    }));
});
