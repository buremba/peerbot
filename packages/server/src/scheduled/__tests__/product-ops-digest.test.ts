import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../db/client";
import {
  createProductOpsDigestStore,
  type ProductOpsActivity,
  type ProductOpsDigestStore,
  type ProductOpsDigestWindow,
  productOpsDigestConfigFromEnv,
  runProductOpsDigest,
} from "../product-ops-digest";

const WINDOW = {
  start: new Date("2026-08-12T11:40:00.000Z"),
  end: new Date("2026-08-12T12:00:00.000Z"),
};

const EMPTY_ACTIVITY: ProductOpsActivity = {
  signups: [],
  logins: [],
  connections: [],
  mcpConversations: [],
};

function store(
  activity: ProductOpsActivity = EMPTY_ACTIVITY,
): ProductOpsDigestStore {
  return {
    resolveWindow: async () => WINDOW,
    collectActivity: async () => activity,
  };
}

function lokiResponse(levels: Record<string, number>): Response {
  return Response.json({
    status: "success",
    data: {
      resultType: "vector",
      result: Object.entries(levels).map(([level, count]) => ({
        metric: { level },
        value: [String(WINDOW.end.getTime() / 1000), String(count)],
      })),
    },
  });
}

const CONFIG = {
  lokiUrl: "http://loki.monitoring:3100",
  namespace: "summaries-prod",
  grafanaUrl: "https://grafana.example.test/explore",
  slackOrganizationId: "org_lobucrm",
  slackConnectionSlug: "agentconn-lobu",
  slackTeamId: "T09513HDQ77",
  slackChannelId: "C0BPWNXR0MP",
};

describe("product operations digest", () => {
  test("uses the prior successful scheduled tick as the durable cursor", async () => {
    const responses = [
      [{ scheduled_tick: "2026-08-12T12:02:00.000Z" }],
      [{ scheduled_tick: "2026-08-12T11:22:00.000Z" }],
    ];
    const sql = (() =>
      Promise.resolve(responses.shift() ?? [])) as unknown as DbClient;

    expect(await createProductOpsDigestStore(sql).resolveWindow(101)).toEqual({
      start: new Date("2026-08-12T11:20:00.000Z"),
      end: new Date("2026-08-12T12:00:00.000Z"),
    });
  });

  test("defaults the first run to exactly one 20-minute interval", async () => {
    const responses = [[{ scheduled_tick: "2026-08-12T12:02:00.000Z" }], []];
    const sql = (() =>
      Promise.resolve(responses.shift() ?? [])) as unknown as DbClient;

    expect(await createProductOpsDigestStore(sql).resolveWindow(102)).toEqual(
      WINDOW,
    );
  });

  test("requires complete production endpoints when explicitly enabled", () => {
    expect(
      productOpsDigestConfigFromEnv({ ENVIRONMENT: "production" }),
    ).toBeNull();
    expect(() =>
      productOpsDigestConfigFromEnv({
        ENVIRONMENT: "production",
        LOBU_PRODUCT_OPS_DIGEST_ENABLED: "1",
        LOBU_PRODUCT_OPS_LOKI_URL: CONFIG.lokiUrl,
      }),
    ).toThrow("requires LOBU_PRODUCT_OPS_LOKI_URL");
  });

  test("checks production logs but stays silent when there is no activity", async () => {
    const requests: string[] = [];
    const result = await runProductOpsDigest({
      taskRunId: 42,
      config: CONFIG,
      store: store(),
      fetchImpl: async (input) => {
        requests.push(String(input));
        return lokiResponse({ info: 999 });
      },
      deliverDigest: async () => {
        throw new Error("empty windows must not be delivered");
      },
    });

    expect(result).toEqual({
      posted: false,
      window: WINDOW,
      activity: EMPTY_ACTIVITY,
      logs: { errors: 0, warnings: 0 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toStartWith(`${CONFIG.lokiUrl}/loki/api/v1/query?`);
  });

  test("posts one idempotent digest for product activity and warning/error logs", async () => {
    const activity: ProductOpsActivity = {
      signups: [{ userId: "user-1", name: "Ada", email: "ada@example.test" }],
      logins: [
        { userId: "user-1", name: "Ada", email: "ada@example.test" },
        { userId: "user-1", name: "Ada", email: "ada@example.test" },
      ],
      connections: [
        {
          connectorKey: "slack",
          displayName: "Acme Slack",
          organizationName: "Acme",
        },
      ],
      mcpConversations: [
        {
          userId: "user-1",
          clientSoftwareId: "codex",
          organizationName: "Acme",
        },
      ],
    };
    const requests: string[] = [];
    const deliveries: Array<{ message: string; clientMessageId: string }> = [];

    const result = await runProductOpsDigest({
      taskRunId: 43,
      config: CONFIG,
      store: store(activity),
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        return lokiResponse({ error: 2, warning: 3, info: 999 });
      },
      deliverDigest: async ({ message, clientMessageId }) => {
        deliveries.push({ message, clientMessageId });
      },
    });

    expect(result.posted).toBe(true);
    expect(result.logs).toEqual({ errors: 2, warnings: 3 });
    expect(requests).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.clientMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deliveries[0]?.message).toStartWith(
      "*Lobu production activity digest*\n",
    );
    expect(deliveries[0]?.message).toContain(
      "Signups: 1 — Ada (ada@example.test)",
    );
    expect(deliveries[0]?.message).toContain(
      "Logins: 2 sessions / 1 user",
    );
    expect(deliveries[0]?.message).toContain(
      "New connections: 1 — slack: Acme Slack (Acme)",
    );
    expect(deliveries[0]?.message).toContain(
      "MCP activity: 1 new conversation / 1 authenticated user / 1 client — codex (Acme)",
    );
    expect(deliveries[0]?.message).toContain(
      "Kubernetes logs: 2 errors / 3 warnings",
    );
    expect(deliveries[0]?.message).toContain(CONFIG.grafanaUrl);
  });

  test("splits catch-up work into independently deduplicated 20-minute digests", async () => {
    const collected: ProductOpsDigestWindow[] = [];
    const clientMessageIds: string[] = [];
    await runProductOpsDigest({
      taskRunId: 46,
      config: CONFIG,
      store: {
        resolveWindow: async () => ({
          start: new Date("2026-08-12T11:20:00.000Z"),
          end: WINDOW.end,
        }),
        collectActivity: async (window) => {
          collected.push(window);
          return {
            ...EMPTY_ACTIVITY,
            signups: [
              {
                userId: window.end.toISOString(),
                name: "Catch-up user",
                email: "catch-up@example.test",
              },
            ],
          };
        },
      },
      fetchImpl: async () => lokiResponse({}),
      deliverDigest: async ({ clientMessageId }) => {
        clientMessageIds.push(clientMessageId);
      },
    });

    expect(collected).toEqual([
      {
        start: new Date("2026-08-12T11:20:00.000Z"),
        end: new Date("2026-08-12T11:40:00.000Z"),
      },
      WINDOW,
    ]);
    expect(clientMessageIds).toHaveLength(2);
    expect(new Set(clientMessageIds).size).toBe(2);
  });

  test("fails closed when Loki cannot be checked", async () => {
    await expect(
      runProductOpsDigest({
        taskRunId: 44,
        config: CONFIG,
        store: store(),
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
        deliverDigest: async () => {},
      }),
    ).rejects.toThrow("Loki query failed with 503");
  });

  test("fails closed when Slack delivery rejects the digest", async () => {
    await expect(
      runProductOpsDigest({
        taskRunId: 45,
        config: CONFIG,
        store: store({
          ...EMPTY_ACTIVITY,
          signups: [
            { userId: "user-2", name: null, email: "new@example.test" },
          ],
        }),
        fetchImpl: async () => lokiResponse({}),
        deliverDigest: async () => {
          throw new Error("Slack chat.postMessage failed: not_in_channel");
        },
      }),
    ).rejects.toThrow("Slack chat.postMessage failed: not_in_channel");
  });
});
