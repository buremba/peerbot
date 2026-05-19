import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LobuProvider } from "../provider";

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function createFetchStub(events: string[]) {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/lobu/api/v1/agents") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ agentId: "agent-x", token: "session-token" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/messages")) {
      return new Response(
        JSON.stringify({
          messageId: "msg-1",
          traceparent: "00-traceabcdef-span0-01",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/events")) {
      return new Response(streamFromChunks(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });
}

const originalFetch = globalThis.fetch;

describe("LobuProvider tool_use SSE handling", () => {
  beforeEach(() => {
    process.env.LOBU_TOKEN = "dummy";
    process.env.LOBU_AGENT = "test-agent";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("populates metadata.toolCalls and metadata.retrievedContext from search_memory tool_use events", async () => {
    const events = [
      sseEvent("connected", { agentId: "agent-x" }),
      sseEvent("output", {
        content: "Looking at your records...",
        messageId: "msg-1",
      }),
      sseEvent("tool_use", {
        toolCallId: "tc-1",
        name: "search_memory",
        input: { query: "rent due" },
        isError: false,
        result_summary: {
          event_ids: [42, 43],
          snippets: [
            { id: 42, text: "Tenant Acme pays £1,200 on the 1st" },
            { id: 43, text: "Lease ends Dec 2027" },
          ],
        },
        messageId: "msg-1",
      }),
      sseEvent("output", {
        content: " Acme pays £1,200 monthly.",
        messageId: "msg-1",
      }),
      sseEvent("complete", {
        messageId: "msg-1",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
    ];
    globalThis.fetch = createFetchStub(events) as any;

    const provider = new LobuProvider({
      config: { agent: "test-agent", gateway: "http://gateway", token: "tok" },
    });
    const result = await provider.callApi("when is rent due?");

    expect(result.output).toBe(
      "Looking at your records... Acme pays £1,200 monthly."
    );
    expect(result.metadata.toolCalls).toBeDefined();
    expect(result.metadata.toolCalls).toHaveLength(1);
    expect(result.metadata.toolCalls![0]!.name).toBe("search_memory");
    expect(result.metadata.toolCalls![0]!.result_summary?.event_ids).toEqual([
      42, 43,
    ]);
    expect(result.metadata.retrievedContext).toBe(
      "Tenant Acme pays £1,200 on the 1st\n\nLease ends Dec 2027"
    );
    expect(result.metadata.traceId).toBe("traceabcdef");
    expect(result.tokenUsage?.total).toBe(18);
  });

  test("ignores tool_use events for other messageIds", async () => {
    const events = [
      sseEvent("tool_use", {
        toolCallId: "tc-other",
        name: "search_memory",
        input: { query: "stale" },
        result_summary: {
          event_ids: [1],
          snippets: [{ id: 1, text: "stale" }],
        },
        messageId: "different-message",
      }),
      sseEvent("output", { content: "hi", messageId: "msg-1" }),
      sseEvent("complete", { messageId: "msg-1" }),
    ];
    globalThis.fetch = createFetchStub(events) as any;

    const provider = new LobuProvider({
      config: { agent: "test-agent", gateway: "http://gateway", token: "tok" },
    });
    const result = await provider.callApi("hi");
    expect(result.metadata.toolCalls).toBeUndefined();
    expect(result.metadata.retrievedContext).toBeUndefined();
  });

  test("captures non-retrieval tool calls in metadata.toolCalls without retrievedContext", async () => {
    const events = [
      sseEvent("tool_use", {
        toolCallId: "tc-bash",
        name: "bash",
        input: { command: "ls" },
        messageId: "msg-1",
      }),
      sseEvent("output", { content: "done", messageId: "msg-1" }),
      sseEvent("complete", { messageId: "msg-1" }),
    ];
    globalThis.fetch = createFetchStub(events) as any;

    const provider = new LobuProvider({
      config: { agent: "test-agent", gateway: "http://gateway", token: "tok" },
    });
    const result = await provider.callApi("ls");
    expect(result.metadata.toolCalls).toEqual([
      { toolCallId: "tc-bash", name: "bash", input: { command: "ls" } },
    ]);
    expect(result.metadata.retrievedContext).toBeUndefined();
  });
});
