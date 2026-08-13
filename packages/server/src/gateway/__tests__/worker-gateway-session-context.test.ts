import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import type { DbClient } from "../../db/client.js";
import { resolveBehaviorRunSkills } from "../behavior-run-session.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";

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

  test("syncs live skills for chat and pinned snapshots for Behavior runs", async () => {
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
      } as any,
      async () => [
        {
          name: "pinned-behavior-skill",
          content: "# Pinned Behavior Skill\n",
        },
      ]
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

    const fetchContext = async (
      source?: string,
      conversationId = "conv-1"
    ): Promise<SessionContextBody> => {
      const token = generateWorkerToken("user-1", conversationId, "worker-a", {
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

    const behaviorRun = await fetchContext(
      "watcher-run",
      "agent-1_watcher_42_run_99"
    );
    expect(behaviorRun.skillsConfig).toEqual([
      {
        name: "pinned-behavior-skill",
        content: "# Pinned Behavior Skill\n",
      },
    ]);
    expect(behaviorRun.skillsInstructions).toContain("pinned-behavior-skill");
    expect(behaviorRun.skillsInstructions).not.toContain("custom-skill");

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

  test("resolves pinned skills through the signed Behavior run correlation", async () => {
    let queryValues: unknown[] = [];
    const db = (async (
      _strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      queryValues = values;
      return [
        {
          skills: JSON.stringify([
            { name: "pinned", content: "Frozen instructions." },
          ]),
        },
      ];
    }) as unknown as DbClient;

    const skills = await resolveBehaviorRunSkills(
      {
        conversationId: "agent-1_watcher_42_run_99",
        organizationId: "org-1",
        agentId: "agent-1",
      },
      db
    );

    expect(skills).toEqual([
      { name: "pinned", content: "Frozen instructions." },
    ]);
    expect(queryValues).toContain("agent-1");
    expect(queryValues).toContain(42);
    expect(queryValues).toContain(99);
    expect(queryValues).toContain("org-1");
  });
});
