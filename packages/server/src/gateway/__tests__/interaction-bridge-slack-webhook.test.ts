import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { getDb } from "../../db/client.js";
import { storePendingTool, type PendingToolInvocation } from "../auth/mcp/pending-tool-store.js";
import { registerActionHandlers } from "../connections/interaction-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { ensurePgliteForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import {
  blockActionsPayload,
  buildSignedBlockActionsRequest,
} from "./fixtures/slack-signing.js";

const SIGNING_SECRET = "test-signing-secret-0123456789ab";
const BOT_TOKEN = "xoxb-test-token";
const BOT_USER_ID = "U_BOT";

function createHarness(options: {
  executeToolResult?: {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
}) {
  const { executeToolResult } = options;

  const adapter = createSlackAdapter({
    signingSecret: SIGNING_SECRET,
    botToken: BOT_TOKEN,
    botUserId: BOT_USER_ID,
  });
  // Stub Slack Web API calls so `thread.post` resolves synchronously without
  // hitting slack.com. We only care about the dispatch seam, not Slack I/O.
  const postMessage = mock(async () => ({ ts: "1700000000.000999" }) as any);
  (adapter as any).postMessage = postMessage;

  const state = new InMemoryStateAdapter();
  const chat = new Chat({
    userName: "lobu",
    adapters: { slack: adapter },
    state,
  });

  const grantStore = { grant: mock(async () => undefined) };
  const executeToolDirect = mock(
    async () =>
      executeToolResult ?? {
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }
  );

  registerActionHandlers(
    chat as any,
    { id: "conn-1", platform: "slack" } as PlatformConnection,
    grantStore as any,
    executeToolDirect as any
  );

  return {
    adapter,
    chat,
    state,
    grantStore,
    executeToolDirect,
    postMessage,
  };
}

/** Wait for an expectation to pass, polling briefly. */
async function waitFor(
  check: () => void,
  { timeoutMs = 1000, intervalMs = 10 } = {}
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      check();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

describe("Slack block_actions → registerActionHandlers (Tier B integration)", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("signed tool-approval button triggers grant, executes tool, deletes pending", async () => {
    const pending: PendingToolInvocation = {
      mcpId: "github",
      toolName: "create_issue",
      args: { title: "from slack" },
      agentId: "agent-1",
      userId: "user-1",
    };
    await storePendingTool("req-slack-1", pending, 24 * 60 * 60);

    const h = createHarness({
      executeToolResult: {
        content: [{ type: "text", text: "issue created: #7" }],
        isError: false,
      },
    });

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: "T123",
        userId: "U_ACTOR",
        channelId: "C_CHAN",
        messageTs: "1700000000.000100",
        actionId: "tool:req-slack-1:1h",
        value: "1h",
      })
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    // Wait on the tail of the handler (executeToolDirect) so earlier steps
    // (claim, grant) have all completed by the time we assert on them.
    await waitFor(() => expect(h.executeToolDirect).toHaveBeenCalled());

    // The pending row was deleted by the take-on-claim path.
    const sql = getDb();
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'req-slack-1' AND scope = 'pending-tool'
    `;
    expect(remaining.length).toBe(0);

    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    const [agentId, pattern] = h.grantStore.grant.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(pattern).toBe("/mcp/github/tools/create_issue");
    expect(h.executeToolDirect).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalled();
  });

  test("signed question button invokes onAction with button value", async () => {
    const h = createHarness({});

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: "T123",
        userId: "U_ACTOR",
        channelId: "C_CHAN",
        messageTs: "1700000000.000200",
        actionId: "question:q-42:1",
        value: "Option Two",
      })
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    await waitFor(() => expect(h.postMessage).toHaveBeenCalled());

    // The response posted back to the thread should be the button's value.
    const postedArg = h.postMessage.mock.calls[0]?.[1];
    const postedText =
      typeof postedArg === "string" ? postedArg : postedArg?.markdown;
    expect(postedText).toBe("Option Two");

    // No grant for questions; executeToolDirect never called.
    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.executeToolDirect).not.toHaveBeenCalled();
  });

  test("tampered signature is rejected before handler runs", async () => {
    const pending: PendingToolInvocation = {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "a",
      userId: "u",
    };
    await storePendingTool("req-bad", pending, 24 * 60 * 60);

    const h = createHarness({});

    const payload = blockActionsPayload({
      teamId: "T123",
      userId: "U_ACTOR",
      channelId: "C_CHAN",
      messageTs: "1700000000.000300",
      actionId: "tool:req-bad:1h",
      value: "1h",
    });
    const request = buildSignedBlockActionsRequest(SIGNING_SECRET, payload);
    const tampered = new Request(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=deadbeef",
        "x-slack-request-timestamp":
          request.headers.get("x-slack-request-timestamp") ?? "0",
      },
      body: await request.text(),
    });

    const response = await h.chat.webhooks.slack(tampered);
    expect(response.status).not.toBe(200);
    // Give any stray async work a tick — nothing downstream should have run.
    await new Promise((r) => setTimeout(r, 20));

    // Pending row still present because no claim happened.
    const sql = getDb();
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'req-bad' AND scope = 'pending-tool'
    `;
    expect(remaining.length).toBe(1);

    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.executeToolDirect).not.toHaveBeenCalled();
    expect(h.postMessage).not.toHaveBeenCalled();
  });
});
