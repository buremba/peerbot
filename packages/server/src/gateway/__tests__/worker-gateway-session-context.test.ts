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

  test("syncs configured skills for chat but suppresses them for Behavior runs", async () => {
    // A DECLARED (SDK-embedded) agent has org-agnostic settings, so an orgless
    // token legitimately syncs its skills. (A DB-backed agent with an orgless
    // token would fail closed — covered by the cross-tenant test below.)
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      {
        getWorkerConfig: async () => ({ mcpServers: {} }),
      } as any,
      {
        getSessionContext: async () => ({
          agentLayers: {
            identityMd: "I am Aria.",
            soulMd: "Be concise.",
            userMd: "Acme support.",
            unconfiguredNotice: "",
          },
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
        isDeclaredAgent: () => true,
        getSettings: async () => ({
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

    type SessionContextBody = {
      agentLayers: {
        identityMd: string;
        soulMd: string;
        userMd: string;
        unconfiguredNotice: string;
      };
      skillsConfig: Array<{ name: string; content: string }>;
      skillsInstructions: string;
    };

    const fetchContext = async (source?: string): Promise<SessionContextBody> => {
      const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
        channelId: "channel-1",
        agentId: "agent-1",
        source,
      });
      const response = await gateway.getApp().request("/session-context", {
        headers: {
          authorization: `Bearer ${token}`,
          host: "gateway.example.com",
        },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as SessionContextBody;
    };

    const chat = await fetchContext();
    expect(chat.agentLayers).toEqual({
      identityMd: "I am Aria.",
      soulMd: "Be concise.",
      userMd: "Acme support.",
      unconfiguredNotice: "",
    });
    expect(chat.skillsConfig).toEqual([
      { name: "custom-skill", content: "# Custom Skill\n" },
    ]);
    expect(chat.skillsInstructions).toContain("## Skills");
    expect(chat.skillsInstructions).toContain("owner/custom-skill");
    expect(chat.skillsInstructions).not.toContain("Built-in System Skills");

    const behaviorRun = await fetchContext("watcher-run");
    expect(behaviorRun.skillsConfig).toEqual([]);
    expect(behaviorRun.skillsInstructions).toBe("");

    // Other headless sources do not execute frozen Behavior instructions.
    const connectorRepair = await fetchContext("connector-repair");
    expect(connectorRepair.skillsConfig).toHaveLength(1);
    expect(connectorRepair.skillsInstructions).toContain("## Skills");
  });

  test("ships the PUBLIC web origin, with the embedded /lobu mount stripped", async () => {
    // Prod runs PUBLIC_GATEWAY_URL=https://app.lobu.ai/lobu. The worker reaches
    // this endpoint over the INTERNAL dispatcher address, so the request Host
    // below is deliberately a cluster name: if the handler ever derives the
    // origin from the request instead of the configured public base, the agent
    // starts handing users links to a host they cannot open. Both halves of that
    // — the /lobu strip and the ignore-the-Host rule — are asserted here.
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://app.lobu.ai/lobu",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentLayers: {
            identityMd: "",
            soulMd: "",
            userMd: "",
            unconfiguredNotice: "",
          },
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
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
        host: "lobu-gateway.default.svc.cluster.local:8080",
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { webOrigin?: string };
    expect(body.webOrigin).toBe("https://app.lobu.ai");
    expect(body.webOrigin).not.toContain("/lobu");
    expect(body.webOrigin).not.toContain("cluster.local");
  });
});
