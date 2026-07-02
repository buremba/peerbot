import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenClawCustomTools } from "../openclaw/custom-tools";
import { maybePostApprovalCard } from "../shared/tool-implementations";

const originalFetch = globalThis.fetch;

describe("createOpenClawCustomTools", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("registers every built-in Lobu tool", () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "telegram",
      workspaceDir: "/tmp/test-workspace",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "upload_file",
      "generate_image",
      "generate_audio",
      "list_conversations",
      "read_conversation",
      "send_message",
      "react",
      "edit_message",
      "delete_message",
      "ask_user",
    ]);
  });

  test("upload_file emits a file-uploaded custom event after a successful upload", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-custom-tool-"));
    const filePath = join(tempDir, "proof.txt");
    writeFileSync(filePath, "proof");

    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/internal/files/upload")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Response.json({
        fileId: "file-123",
        name: "proof.txt",
        permalink: "https://files.example/proof.txt",
      });
    }) as unknown as typeof fetch;

    try {
      const uploadTool = createOpenClawCustomTools({
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
        workspaceDir: tempDir,
        onCustomEvent: (name, data) => {
          events.push({ name, data });
        },
      }).find((tool) => tool.name === "upload_file");

      expect(uploadTool).toBeDefined();

      const result = await uploadTool!.execute("tool-call-1", {
        file_path: filePath,
      });

      expect(result.content[0]?.text).toContain(
        "Successfully showed proof.txt to the user"
      );
      expect(events).toEqual([
        {
          name: "file-uploaded",
          data: {
            tool: "upload_file",
            platform: "telegram",
            fileId: "file-123",
            name: "proof.txt",
            permalink: "https://files.example/proof.txt",
            size: 5,
          },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ask_user invokes onAskUserPosted after a successful post", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/internal/interactions/create")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Response.json({ id: "question-1" });
    }) as unknown as typeof fetch;

    let posted = 0;
    const askTool = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "slack",
      workspaceDir: "/tmp/test-workspace",
      onAskUserPosted: () => posted++,
    }).find((tool) => tool.name === "ask_user");

    expect(askTool).toBeDefined();

    const result = await askTool!.execute("tool-call-1", {
      question: "Which one?",
      options: ["a", "b"],
    });

    expect(posted).toBe(1);
    expect(result.content[0]?.text).toContain("Question posted with buttons");
  });
});

// Builder gate: when a manage_agents write returns a `pending_approval` result,
// the worker forwards it as a `tool_approval` interaction card so the SPA chat
// renders the interactive Approve/Reject diff. Same /internal/interactions/create
// emission point ask_user uses → owner-gated thread_response delivery.
describe("maybePostApprovalCard (builder gate)", () => {
  const gw = {
    gatewayUrl: "http://gateway",
    workerToken: "worker-token",
    channelId: "channel-1",
    conversationId: "conversation-1",
    platform: "api",
    workspaceDir: "/tmp/test-workspace",
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("posts a tool_approval card for a manage_agents pending_approval result", async () => {
    const posts: Array<{ url: string; body: any }> = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        posts.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({ id: "appr-1" });
      }
    ) as unknown as typeof fetch;

    const resultText = JSON.stringify({
      action: "update",
      run_id: 99,
      status: "pending_approval",
      message: "needs approval",
      proposal: { action: "update", agent_id: "support-bot", name: "v2" },
      current: { id: "support-bot", name: "v1" },
    });

    const posted = await maybePostApprovalCard(gw, "manage_agents", resultText);

    expect(posted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toEndWith("/internal/interactions/create");
    expect(posts[0]!.body).toMatchObject({
      interactionType: "tool_approval",
      runId: 99,
      action: "update",
      proposal: { agent_id: "support-bot", name: "v2" },
      current: { id: "support-bot", name: "v1" },
    });
  });

  test("does nothing for a non-pending manage_agents result", async () => {
    const posts: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      posts.push(String(input));
      return Response.json({});
    }) as unknown as typeof fetch;

    const posted = await maybePostApprovalCard(
      gw,
      "manage_agents",
      JSON.stringify({ action: "list", agents: [] })
    );

    expect(posted).toBe(false);
    expect(posts).toHaveLength(0);
  });

  test("does nothing for a different tool", async () => {
    const posts: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      posts.push(String(input));
      return Response.json({});
    }) as unknown as typeof fetch;

    const posted = await maybePostApprovalCard(
      gw,
      "manage_operations",
      JSON.stringify({ status: "pending_approval", run_id: 5 })
    );

    expect(posted).toBe(false);
    expect(posts).toHaveLength(0);
  });

  test("does nothing for non-JSON (markdown) result text", async () => {
    const posts: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      posts.push(String(input));
      return Response.json({});
    }) as unknown as typeof fetch;

    const posted = await maybePostApprovalCard(
      gw,
      "manage_agents",
      "**Agent created** — support-bot"
    );

    expect(posted).toBe(false);
    expect(posts).toHaveLength(0);
  });
});
