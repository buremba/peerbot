import { describe, expect, mock, test } from "bun:test";
import { ChatInstanceManager } from "../chat-instance-manager.js";

describe("ChatInstanceManager message mutations", () => {
  test("resolves the registered adapter for every message mutation", async () => {
    const editMessage = mock(async () => undefined);
    const addReaction = mock(async () => undefined);
    const removeReaction = mock(async () => undefined);
    const deleteMessage = mock(async () => undefined);
    const getAdapter = mock((platform: string) =>
      platform === "gchat"
        ? { addReaction, deleteMessage, editMessage, removeReaction }
        : undefined,
    );
    const manager = new ChatInstanceManager() as any;
    manager.ensureConnectionRunning = mock(async () => undefined);
    manager.instances.set("gchat-1", {
      connection: { id: "gchat-1", platform: "gchat" },
      chat: { getAdapter },
    });

    await manager.editMessageContent("gchat-1", {
      threadId: "gchat:spaces/AAA:dm",
      messageId: "spaces/AAA/messages/poll-1",
      content: { markdown: "Closed" },
    });

    expect(editMessage).toHaveBeenCalledWith(
      "gchat:spaces/AAA:dm",
      "spaces/AAA/messages/poll-1",
      { markdown: "Closed" },
    );

    await manager.reactToMessage("gchat-1", {
      threadId: "gchat:spaces/AAA:dm",
      messageId: "spaces/AAA/messages/poll-1",
      emoji: "✅",
    });
    await manager.reactToMessage("gchat-1", {
      threadId: "gchat:spaces/AAA:dm",
      messageId: "spaces/AAA/messages/poll-1",
      emoji: "✅",
      remove: true,
    });
    await manager.deleteMessage("gchat-1", {
      threadId: "gchat:spaces/AAA:dm",
      messageId: "spaces/AAA/messages/poll-1",
    });
    expect(addReaction).toHaveBeenCalledWith(
      "gchat:spaces/AAA:dm",
      "spaces/AAA/messages/poll-1",
      "✅",
    );
    expect(removeReaction).toHaveBeenCalledWith(
      "gchat:spaces/AAA:dm",
      "spaces/AAA/messages/poll-1",
      "✅",
    );
    expect(deleteMessage).toHaveBeenCalledWith(
      "gchat:spaces/AAA:dm",
      "spaces/AAA/messages/poll-1",
    );
    expect(getAdapter).toHaveBeenCalledTimes(4);
    expect(getAdapter).toHaveBeenCalledWith("gchat");
  });
});
