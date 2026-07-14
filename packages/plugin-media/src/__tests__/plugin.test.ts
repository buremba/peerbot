import { describe, expect, test } from "bun:test";
import { createMediaTools } from "../index";

describe("media plugin", () => {
  test("owns file, image, and audio tools", () => {
    const tools = createMediaTools({
      gatewayUrl: "http://gateway",
      workerToken: "token",
      channelId: "channel",
      conversationId: "conversation",
      workspaceDir: "/workspace",
      onFileUploaded: () => undefined,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "upload_file",
      "generate_image",
      "generate_audio",
    ]);
  });
});
