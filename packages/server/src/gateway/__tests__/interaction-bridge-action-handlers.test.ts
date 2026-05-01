import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { storePendingTool, type PendingToolInvocation } from "../auth/mcp/pending-tool-store.js";
import { registerActionHandlers } from "../connections/interaction-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { ensurePgliteForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

type ActionHandler = (event: any) => Promise<void>;

interface Harness {
  handler: ActionHandler;
  grantStore: {
    grant: ReturnType<typeof mock>;
  };
  executeToolDirect: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  thread: { post: ReturnType<typeof mock> };
  editCard: ReturnType<typeof mock>;
}

function setup(
  options: {
    executeToolResult?:
      | { content: Array<{ type: string; text: string }>; isError: boolean }
      | Error;
    withExecute?: boolean;
    withGrantStore?: boolean;
  } = {}
): Harness {
  const {
    executeToolResult,
    withExecute = true,
    withGrantStore = true,
  } = options;

  let captured: ActionHandler | undefined;
  const chat = {
    onAction: mock((h: ActionHandler) => {
      captured = h;
    }),
  };
  const grantStore = {
    grant: mock(async () => undefined),
  };
  const executeToolDirect = mock(async () => {
    if (executeToolResult instanceof Error) throw executeToolResult;
    return (
      executeToolResult ?? {
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }
    );
  });
  const post = mock(async () => undefined);
  const thread = { post };

  const editCard = mock(async () => undefined);
  const claimApprovalCard = mock((_requestId: string) => ({ edit: editCard }));

  registerActionHandlers(
    chat as any,
    { id: "conn-1", platform: "slack" } as PlatformConnection,
    withGrantStore ? (grantStore as any) : undefined,
    withExecute ? (executeToolDirect as any) : undefined,
    claimApprovalCard as any
  );

  if (!captured) throw new Error("onAction handler not registered");
  return {
    handler: captured,
    grantStore,
    executeToolDirect,
    post,
    thread,
    editCard,
  };
}

const PENDING: PendingToolInvocation = {
  mcpId: "github",
  toolName: "create_issue",
  args: { title: "hi" },
  agentId: "agent-1",
  userId: "user-1",
};

async function seedPending(requestId: string): Promise<void> {
  await storePendingTool(requestId, PENDING, 24 * 60 * 60);
}

describe("registerActionHandlers — tool approval", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("approve with pending + executeToolDirect stores grant, runs tool, posts result, deletes pending", async () => {
    await seedPending("req-1");
    const h = setup({
      executeToolResult: {
        content: [{ type: "text", text: "issue #42" }],
        isError: false,
      },
    });
    const before = Date.now();
    await h.handler({
      actionId: "tool:req-1:1h",
      value: "1h",
      thread: h.thread,
    });

    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    const [agentId, pattern, expiresAt, denial] =
      h.grantStore.grant.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(pattern).toBe("/mcp/github/tools/create_issue");
    expect(denial).toBeUndefined();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 100);

    expect(h.executeToolDirect).toHaveBeenCalledTimes(1);
    expect(h.executeToolDirect.mock.calls[0]).toEqual([
      "agent-1",
      "user-1",
      "github",
      "create_issue",
      { title: "hi" },
    ]);

    expect(h.post).toHaveBeenCalledWith("issue #42");
  });

  test("approve maps duration 'always' to null expiry", async () => {
    await seedPending("req-3");
    const h = setup();
    await h.handler({
      actionId: "tool:req-3:always",
      value: "always",
      thread: h.thread,
    });
    const [, , expiresAt] = h.grantStore.grant.mock.calls[0];
    expect(expiresAt).toBeNull();
  });

  test("approve edits the approval card to strip buttons and show decision summary", async () => {
    await seedPending("req-edit");
    const h = setup();
    await h.handler({
      actionId: "tool:req-edit:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.editCard).toHaveBeenCalledTimes(1);
    const edited = h.editCard.mock.calls[0]?.[0] as string;
    expect(edited).toContain("github → create_issue");
    expect(edited).toContain("Approved (1h)");
  });

  test("approve with no pending but tracked card (late first click) edits card and posts an expired notice — no grant, no execute", async () => {
    const h = setup();
    await h.handler({
      actionId: "tool:req-x:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.executeToolDirect).not.toHaveBeenCalled();
    // Card should be edited to show the expired notice and the user told to retry.
    expect(h.editCard).toHaveBeenCalledTimes(1);
    expect(h.editCard.mock.calls[0]?.[0] as string).toMatch(/expired/i);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[0] as string).toMatch(/expired/i);
  });

  test("approve but tool execution throws posts failure message and still stores grant", async () => {
    await seedPending("req-4");
    const h = setup({
      executeToolResult: new Error("boom"),
    });
    await h.handler({
      actionId: "tool:req-4:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("Failed to execute tool: Error: boom");
  });

  test("approve with isError=true result posts 'Tool error: ...'", async () => {
    await seedPending("req-5");
    const h = setup({
      executeToolResult: {
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      },
    });
    await h.handler({
      actionId: "tool:req-5:1h",
      value: "1h",
      thread: h.thread,
    });
    expect(h.post).toHaveBeenCalledWith("Tool error: permission denied");
  });

  test("deny stores denial grant, takes pending, posts apology", async () => {
    await seedPending("req-6");
    const h = setup();
    await h.handler({
      actionId: "tool:req-6:deny",
      value: "deny",
      thread: h.thread,
    });
    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    const [agentId, pattern, expiresAt, denial] =
      h.grantStore.grant.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(pattern).toBe("/mcp/github/tools/create_issue");
    expect(expiresAt).toBeNull();
    expect(denial).toBe(true);
    expect(h.executeToolDirect).not.toHaveBeenCalled();
    expect(h.post.mock.calls[0]?.[0]).toMatch(/denied/i);
  });

  test("deny with no pending but tracked card (late first click) edits card and posts an expired notice — no grant", async () => {
    const h = setup();
    await h.handler({
      actionId: "tool:req-7:deny",
      value: "deny",
      thread: h.thread,
    });
    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.editCard).toHaveBeenCalledTimes(1);
    expect(h.editCard.mock.calls[0]?.[0] as string).toMatch(/expired/i);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[0] as string).toMatch(/expired/i);
  });

  test("deny edits the approval card to show denial summary", async () => {
    await seedPending("req-editdeny");
    const h = setup();
    await h.handler({
      actionId: "tool:req-editdeny:deny",
      value: "deny",
      thread: h.thread,
    });
    expect(h.editCard).toHaveBeenCalledTimes(1);
    expect(h.editCard.mock.calls[0]?.[0] as string).toContain("Denied");
  });
});

describe("registerActionHandlers — question (no callback)", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("question with value posts the value (legacy fallback path)", async () => {
    const h = setup();
    await h.handler({
      actionId: "question:q-1:2",
      value: "Option C",
      thread: h.thread,
    });
    expect(h.post).toHaveBeenCalledWith("Option C");
  });

  test("question with no value falls back to third actionId segment", async () => {
    const h = setup();
    await h.handler({
      actionId: "question:q-1:fallback-text",
      value: "",
      thread: h.thread,
    });
    expect(h.post).toHaveBeenCalledWith("fallback-text");
  });
});

describe("registerActionHandlers — question (with onQuestionClick)", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  function setupWithCallback(): {
    handler: ActionHandler;
    onQuestionClick: ReturnType<typeof mock>;
    thread: { post: ReturnType<typeof mock> };
  } {
    let captured: ActionHandler | undefined;
    const chat = {
      onAction: mock((h: ActionHandler) => {
        captured = h;
      }),
    };
    const onQuestionClick = mock(async () => undefined);
    const thread = { post: mock(async () => undefined) };

    registerActionHandlers(
      chat as any,
      { id: "conn-1", platform: "slack" } as PlatformConnection,
      undefined,
      undefined,
      undefined,
      onQuestionClick as any
    );
    if (!captured) throw new Error("onAction handler not registered");
    return { handler: captured, onQuestionClick, thread };
  }

  test("dispatches question click to onQuestionClick instead of bare post", async () => {
    const h = setupWithCallback();
    await h.handler({
      actionId: "question:q-42:0",
      value: "Phobos",
      thread: h.thread,
      user: { userId: "U_clicker", userName: "ada", fullName: "Ada Lovelace" },
    });

    expect(h.thread.post).not.toHaveBeenCalled();
    expect(h.onQuestionClick).toHaveBeenCalledTimes(1);
    const [questionId, value, threadArg, author] =
      h.onQuestionClick.mock.calls[0];
    expect(questionId).toBe("q-42");
    expect(value).toBe("Phobos");
    expect(threadArg).toBe(h.thread);
    expect(author).toEqual({
      userId: "U_clicker",
      userName: "ada",
      fullName: "Ada Lovelace",
    });
  });

  test("missing questionId is silently ignored", async () => {
    const h = setupWithCallback();
    await h.handler({
      actionId: "question:",
      value: "X",
      thread: h.thread,
    });
    expect(h.onQuestionClick).not.toHaveBeenCalled();
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  test("callback errors are swallowed (no throw out of handler)", async () => {
    const h = setupWithCallback();
    h.onQuestionClick.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await h.handler({
      actionId: "question:q-99:1",
      value: "second",
      thread: h.thread,
    });
    expect(h.onQuestionClick).toHaveBeenCalledTimes(1);
  });
});

describe("registerActionHandlers — guards", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  let h: Harness;
  beforeEach(async () => {
    await resetTestDatabase();
    h = setup();
  });

  test("no thread → no-op", async () => {
    await h.handler({ actionId: "tool:req:approve", value: "1h" });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.grantStore.grant).not.toHaveBeenCalled();
  });

  test("no actionId → no-op", async () => {
    await h.handler({ actionId: "", value: "1h", thread: h.thread });
    expect(h.post).not.toHaveBeenCalled();
  });

  test("unknown prefix → no-op", async () => {
    await h.handler({
      actionId: "other:foo:bar",
      value: "x",
      thread: h.thread,
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.grantStore.grant).not.toHaveBeenCalled();
  });
});
