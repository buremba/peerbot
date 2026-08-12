import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../db/client";
import type { SlackWebApi } from "../../gateway/connections/slack-web";
import type { SecretStore } from "../../gateway/secrets/index";
import { getOrgId } from "../../lobu/stores/org-context";
import type { ProductOpsDigestConfig } from "../product-ops-digest";
import {
  createProductOpsSlackDelivery,
  createProductOpsSlackDeliveryStore,
} from "../product-ops-slack-delivery";

const CONFIG: ProductOpsDigestConfig = {
  lokiUrl: "http://loki.monitoring:3100",
  namespace: "summaries-prod",
  slackOrganizationId: "org_lobucrm",
  slackConnectionSlug: "agentconn-lobu",
  slackTeamId: "T09513HDQ77",
  slackChannelId: "C0BPWNXR0MP",
};

function slackWeb(overrides: Partial<SlackWebApi> = {}): SlackWebApi {
  return {
    openDm: async () => "D1",
    postMessage: async () => {},
    conversationMembers: async () => [],
    conversationInfo: async () => ({
      name: "whats-happening",
      isPrivate: true,
      contextTeamId: CONFIG.slackTeamId,
    }),
    usersInfo: async () => ({ isAdmin: false, isOwner: false }),
    revokeToken: async () => true,
    authTest: async () => ({ teamId: CONFIG.slackTeamId }),
    exchangeOAuthCode: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

describe("product operations Slack delivery", () => {
  test("resolves only the configured active workspace connection in its org context", async () => {
    let queryValues: unknown[] = [];
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      queryValues = values;
      return Promise.resolve([{ bot_token_ref: "secret://slack-bot" }]);
    }) as unknown as DbClient;
    const secretStore = {
      get: async (ref: string) => {
        expect(getOrgId()).toBe(CONFIG.slackOrganizationId);
        expect(ref).toBe("secret://slack-bot");
        return "xoxb-test";
      },
    } as SecretStore;

    const token = await createProductOpsSlackDeliveryStore(
      secretStore,
      sql,
    ).resolveBotToken(CONFIG);

    expect(token).toBe("xoxb-test");
    expect(queryValues).toEqual([
      CONFIG.slackOrganizationId,
      CONFIG.slackConnectionSlug,
      CONFIG.slackTeamId,
    ]);
  });

  test("posts to the exact private channel with a deterministic client id", async () => {
    const posts: unknown[][] = [];
    const deliver = createProductOpsSlackDelivery({
      store: { resolveBotToken: async () => "xoxb-test" },
      slackWeb: slackWeb({
        postMessage: async (...args) => {
          posts.push(args);
        },
      }),
    });

    await deliver({
      config: CONFIG,
      window: {
        start: new Date("2026-08-12T20:00:00.000Z"),
        end: new Date("2026-08-12T20:20:00.000Z"),
      },
      message: "digest",
      clientMessageId: "2963902b-df7b-5f85-b3a6-e09f40685ac9",
    });

    expect(posts).toEqual([
      [
        "xoxb-test",
        "C0BPWNXR0MP",
        "digest",
        "2963902b-df7b-5f85-b3a6-e09f40685ac9",
      ],
    ]);
  });

  test("fails closed when the bot token belongs to another workspace", async () => {
    await expect(
      createProductOpsSlackDelivery({
        store: { resolveBotToken: async () => "xoxb-test" },
        slackWeb: slackWeb({
          authTest: async () => ({ teamId: "T_OTHER" }),
        }),
      })({
        config: CONFIG,
        window: {
          start: new Date("2026-08-12T20:00:00.000Z"),
          end: new Date("2026-08-12T20:20:00.000Z"),
        },
        message: "digest",
        clientMessageId: "2963902b-df7b-5f85-b3a6-e09f40685ac9",
      }),
    ).rejects.toThrow("does not belong to configured workspace");
  });

  test("fails closed when the private channel belongs to another workspace", async () => {
    await expect(
      createProductOpsSlackDelivery({
        store: { resolveBotToken: async () => "xoxb-test" },
        slackWeb: slackWeb({
          conversationInfo: async () => ({
            name: "whats-happening",
            isPrivate: true,
            contextTeamId: "T_OTHER",
          }),
        }),
      })({
        config: CONFIG,
        window: {
          start: new Date("2026-08-12T20:00:00.000Z"),
          end: new Date("2026-08-12T20:20:00.000Z"),
        },
        message: "digest",
        clientMessageId: "2963902b-df7b-5f85-b3a6-e09f40685ac9",
      }),
    ).rejects.toThrow("channel does not belong to configured workspace");
  });
});
