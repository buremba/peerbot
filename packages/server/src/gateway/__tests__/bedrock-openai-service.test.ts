import { describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import type { Model } from "@mariozechner/pi-ai/dist/types.js";
import { BedrockModelCatalog } from "../services/bedrock-model-catalog.js";
import { BedrockOpenAIService } from "../services/bedrock-openai-service.js";

process.env.ENCRYPTION_KEY ??=
  "0000000000000000000000000000000000000000000000000000000000000000";

function workerAuthHeader(): Record<string, string> {
  const token = generateWorkerToken("user-test", "conv-test", "deploy-test", {
    channelId: "channel-test",
  });
  return { Authorization: `Bearer ${token}` };
}

function createCatalog() {
  return new BedrockModelCatalog({
    cacheTtlMs: 0,
    loadModels: async () => [
      {
        id: "amazon.nova-lite-v1:0",
        label: "Amazon / Nova Lite",
        providerName: "Amazon",
        modelName: "Nova Lite",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
      },
    ],
  });
}

describe("BedrockOpenAIService", () => {
  test("lists models in OpenAI format", async () => {
    const service = new BedrockOpenAIService({
      modelCatalog: createCatalog(),
    });

    const response = await service
      .getApp()
      .request("http://localhost/openai/a/test-agent/v1/models", {
        headers: workerAuthHeader(),
      });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "amazon.nova-lite-v1:0",
          object: "model",
          created: 0,
          owned_by: "amazon-bedrock",
        },
      ],
    });
  });

  test("streams OpenAI chat completion chunks for Bedrock events", async () => {
    process.env.AWS_REGION = "eu-west-1";

    const service = new BedrockOpenAIService({
      modelCatalog: createCatalog(),
      modelResolver: () => undefined,
      bedrockStreamer: (() =>
        (async function* () {
          yield { type: "text_delta", delta: "hello" };
          yield {
            type: "toolcall_start",
            contentIndex: 1,
            toolCall: { id: "call_1", name: "lookup" },
          };
          yield {
            type: "toolcall_delta",
            contentIndex: 1,
            delta: '{"city":"London"}',
          };
          yield {
            type: "done",
            reason: "toolUse",
            message: {
              usage: {
                input: 10,
                output: 4,
                cacheRead: 2,
                totalTokens: 16,
              },
            },
          };
        })()) as any,
    });

    const response = await service
      .getApp()
      .request("http://localhost/openai/a/test-agent/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...workerAuthHeader() },
        body: JSON.stringify({
          model: "amazon.nova-lite-v1:0",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        }),
      });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"content":"hello"');
    expect(body).toContain('"tool_calls":[{"index":0,"id":"call_1"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"prompt_tokens":12');
    expect(body).toContain("[DONE]");
  });

  test("builds a dynamic Bedrock runtime model when not in registry", async () => {
    process.env.AWS_REGION = "eu-west-1";

    let resolvedModel: Model<"bedrock-converse-stream"> | null = null;

    const service = new BedrockOpenAIService({
      modelCatalog: new BedrockModelCatalog({
        cacheTtlMs: 0,
        loadModels: async () => [
          {
            id: "custom.model-v1:0",
            label: "Custom / Model",
            providerName: "Custom",
            modelName: "Model",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
          },
        ],
      }),
      modelResolver: () => undefined,
      bedrockStreamer: ((model: Model<"bedrock-converse-stream">) => {
        resolvedModel = model;
        return (async function* () {
          yield { type: "done", reason: "stop", message: { usage: {} } };
        })();
      }) as any,
    });

    const response = await service
      .getApp()
      .request("http://localhost/openai/a/test-agent/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...workerAuthHeader() },
        body: JSON.stringify({
          model: "custom.model-v1:0",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    expect(response.status).toBe(200);
    await response.text();
    expect(resolvedModel?.id).toBe("custom.model-v1:0");
    expect(resolvedModel?.provider).toBe("amazon-bedrock");
    expect(resolvedModel?.api).toBe("bedrock-converse-stream");
  });

  test("rejects unauthenticated /openai requests with 401", async () => {
    const service = new BedrockOpenAIService({
      modelCatalog: createCatalog(),
    });

    const models = await service
      .getApp()
      .request("http://localhost/openai/a/test-agent/v1/models");
    expect(models.status).toBe(401);

    const completion = await service
      .getApp()
      .request("http://localhost/openai/a/test-agent/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "amazon.nova-lite-v1:0",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    expect(completion.status).toBe(401);

    const badToken = await service
      .getApp()
      .request("http://localhost/openai/a/test-agent/v1/models", {
        headers: { Authorization: "Bearer not-a-real-token" },
      });
    expect(badToken.status).toBe(401);
  });

  test("leaves /health unauthenticated for probes", async () => {
    const service = new BedrockOpenAIService({
      modelCatalog: createCatalog(),
    });

    const response = await service.getApp().request("http://localhost/health");
    expect(response.status).toBe(200);
  });
});
