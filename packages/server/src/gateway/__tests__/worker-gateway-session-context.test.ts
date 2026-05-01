import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { WorkerGateway } from "../gateway/index.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

describe("WorkerGateway session context", () => {
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = previousEncryptionKey;
    }
  });

  test("syncs only agent-configured skills into skillsConfig", async () => {
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      {
        getWorkerConfig: async () => ({ mcpServers: {} }),
      } as any,
      {
        getSessionContext: async () => ({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions:
            "## Skills\n\n- **Custom Skill** (`owner/custom-skill`)",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      undefined,
      {
        getEffectiveSettings: async () => ({
          skillsConfig: {
            skills: [
              {
                name: "custom-skill",
                enabled: true,
                content: "# Custom Skill\n",
              },
            ],
          },
        }),
      } as any
    );

    const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
      channelId: "channel-1",
      agentId: "agent-1",
    });

    const response = await gateway.getApp().request("/session-context", {
      headers: {
        authorization: `Bearer ${token}`,
        host: "gateway.example.com",
      },
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      skillsConfig: Array<{ name: string; content: string }>;
      skillsInstructions: string;
    };

    expect(body.skillsConfig).toEqual([
      { name: "custom-skill", content: "# Custom Skill\n" },
    ]);
    expect(body.skillsInstructions).toContain("## Skills");
    expect(body.skillsInstructions).toContain("owner/custom-skill");
    expect(body.skillsInstructions).not.toContain("Built-in System Skills");
  });
});
