import { type DbClient, getDb } from "../db/client";
import {
  createSlackWebApi,
  type SlackWebApi,
} from "../gateway/connections/slack-web";
import { orgContext } from "../lobu/stores/org-context";
import {
  resolveSecretValue,
  type SecretStore,
} from "../gateway/secrets/index";
import type {
  ProductOpsDigestConfig,
  ProductOpsDigestDelivery,
} from "./product-ops-digest";

export interface ProductOpsSlackDeliveryStore {
  resolveBotToken(config: ProductOpsDigestConfig): Promise<string>;
}

interface ProductOpsSlackDeliveryDeps {
  store: ProductOpsSlackDeliveryStore;
  slackWeb?: SlackWebApi;
}

export function createProductOpsSlackDeliveryStore(
  secretStore: SecretStore,
  sql: DbClient = getDb(),
): ProductOpsSlackDeliveryStore {
  return {
    async resolveBotToken(config) {
      const rows = await sql<{ bot_token_ref: string | null }>`
        SELECT COALESCE(
          config->>'botToken',
          config->'chatMetadata'->>'botToken'
        ) AS bot_token_ref
        FROM public.connections
        WHERE organization_id = ${config.slackOrganizationId}
          AND slug = ${config.slackConnectionSlug}
          AND connector_key = 'slack'
          AND status = 'active'
          AND deleted_at IS NULL
          AND external_tenant_id = ${config.slackTeamId}
        LIMIT 1
      `;
      const tokenRef = rows[0]?.bot_token_ref;
      if (!tokenRef) {
        throw new Error(
          "Product operations Slack connection is missing, inactive, or belongs to another workspace",
        );
      }
      const botToken = await orgContext.run(
        { organizationId: config.slackOrganizationId },
        () => resolveSecretValue(secretStore, tokenRef),
      );
      if (!botToken) {
        throw new Error(
          "Product operations Slack connection has no resolvable bot token",
        );
      }
      return botToken;
    },
  };
}

export function createProductOpsSlackDelivery({
  store,
  slackWeb = createSlackWebApi(),
}: ProductOpsSlackDeliveryDeps): ProductOpsDigestDelivery {
  return async ({ config, message, clientMessageId }) => {
    const botToken = await store.resolveBotToken(config);
    const identity = await slackWeb.authTest(botToken);
    if (identity.teamId !== config.slackTeamId) {
      throw new Error(
        "Product operations Slack bot does not belong to configured workspace",
      );
    }
    const channel = await slackWeb.conversationInfo(
      botToken,
      config.slackChannelId,
    );
    if (!channel.isPrivate) {
      throw new Error(
        "Product operations Slack channel is not the configured private channel",
      );
    }
    if (channel.contextTeamId !== config.slackTeamId) {
      throw new Error(
        "Product operations Slack channel does not belong to configured workspace",
      );
    }
    await slackWeb.postMessage(
      botToken,
      config.slackChannelId,
      message,
      clientMessageId,
    );
  };
}
