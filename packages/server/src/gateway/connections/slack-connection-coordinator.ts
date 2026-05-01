import { createLogger } from "@lobu/core";
import type { PlatformAdapterConfig, PlatformConnection } from "./types.js";
import {
  parseSlackTeamJoinEvent,
  postSlackTeamJoinWelcome,
  type ParsedSlackTeamJoinEvent,
} from "./slack-platform-bridge.js";

const logger = createLogger("slack-connection-coordinator");
const SLACK_SYSTEM_AGENT_PREFIX = "system:connection:slack";

type SlackInstallation = {
  botToken: string;
  botUserId?: string;
  teamName?: string;
};

type SlackOAuthAdapter = {
  handleOAuthCallback(request: Request): Promise<{
    teamId: string;
    installation: SlackInstallation;
  }>;
  deleteInstallation(teamId: string): Promise<void>;
  handleWebhook(request: Request): Promise<Response>;
};

type SlackRuntimeConfig = {
  signingSecret?: string;
  clientId?: string;
  clientSecret?: string;
  encryptionKey?: string;
  installationKeyPrefix?: string;
  userName?: string;
  botToken?: string;
};

interface SlackConnectionCoordinatorDeps {
  addConnection(
    platform: string,
    templateAgentId: string | undefined,
    config: PlatformAdapterConfig,
    settings?: { allowGroups?: boolean },
    metadata?: Record<string, unknown>
  ): Promise<PlatformConnection>;
  createStateAdapter(): Promise<any>;
  ensureConnectionRunning(connectionId: string): Promise<boolean>;
  forwardWebhook(connectionId: string, request: Request): Promise<Response>;
  getCurrentSlackConfig(): SlackRuntimeConfig;
  getRunningChat(connectionId: string): any | undefined;
  hasConnection(connectionId: string): boolean;
  listSlackConnections(): Promise<PlatformConnection[]>;
  restartConnection(connectionId: string): Promise<void>;
  updateConnection(
    connectionId: string,
    updates: Partial<PlatformConnection>
  ): Promise<PlatformConnection>;
}

export class SlackConnectionCoordinator {
  constructor(private readonly deps: SlackConnectionCoordinatorDeps) {}

  async findConnectionByTeamId(
    teamId: string
  ): Promise<PlatformConnection | null> {
    const connections = await this.deps.listSlackConnections();
    return (
      connections.find(
        (connection) => connection.metadata?.teamId === teamId
      ) || null
    );
  }

  async getDefaultConnection(): Promise<PlatformConnection | null> {
    const connections = await this.deps.listSlackConnections();
    if (connections.length === 1) {
      return connections[0] || null;
    }

    return (
      connections.find((connection) => !connection.metadata?.teamId) || null
    );
  }

  async ensureWorkspaceConnection(
    teamId: string,
    installation: SlackInstallation
  ): Promise<PlatformConnection> {
    const baseConfig = this.resolveAdapterConfig({
      requireOAuth: true,
    }) as Extract<PlatformAdapterConfig, { platform: "slack" }>;
    const config: PlatformAdapterConfig = {
      ...baseConfig,
      botToken: installation.botToken,
      ...(installation.botUserId ? { botUserId: installation.botUserId } : {}),
    };
    const agentId = `${SLACK_SYSTEM_AGENT_PREFIX}:${teamId}`;
    const metadata = {
      teamId,
      teamName: installation.teamName,
      botUserId: installation.botUserId,
    };

    const existing = await this.findConnectionByTeamId(teamId);
    if (existing) {
      const updated = await this.deps.updateConnection(existing.id, {
        templateAgentId: agentId,
        config,
        metadata,
      });
      if (!this.deps.hasConnection(existing.id)) {
        await this.deps.restartConnection(existing.id);
      }
      return updated;
    }

    return this.deps.addConnection(
      "slack",
      agentId,
      config,
      { allowGroups: true },
      metadata
    );
  }

  async completeOAuthInstall(
    request: Request,
    redirectUri?: string
  ): Promise<{
    teamId: string;
    teamName?: string;
    connectionId: string;
  }> {
    const { chat, adapter } = await this.createOAuthChat({
      requireOAuth: true,
    });

    try {
      const url = new URL(request.url);
      if (redirectUri) {
        url.searchParams.set("redirect_uri", redirectUri);
      }

      const callbackRequest = new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
      });

      const { teamId, installation } =
        await adapter.handleOAuthCallback(callbackRequest);
      let connection: PlatformConnection;
      try {
        connection = await this.ensureWorkspaceConnection(teamId, installation);
      } catch (error) {
        await adapter.deleteInstallation(teamId).catch((err) => {
          logger.warn(
            { teamId, error: String(err) },
            "Failed to delete Slack installation after connection error"
          );
        });
        throw error;
      }

      return {
        teamId,
        teamName: installation.teamName,
        connectionId: connection.id,
      };
    } finally {
      await chat.shutdown().catch((err: unknown) => {
        logger.warn(
          { error: String(err) },
          "Failed to shut down Slack OAuth chat"
        );
      });
    }
  }

  async handleAppWebhook(request: Request): Promise<Response> {
    const body = await request.text();
    const contentType = request.headers.get("content-type") || "";
    const teamJoinEvent = parseSlackTeamJoinEvent(body, contentType);
    const teamId = this.extractTeamId(body, contentType);

    if (teamId) {
      const connection = await this.findConnectionByTeamId(teamId);
      if (connection) {
        if (!(await this.deps.ensureConnectionRunning(connection.id))) {
          return new Response("Slack connection unavailable", { status: 503 });
        }
        const response = await this.deps.forwardWebhook(
          connection.id,
          this.cloneRequestWithBody(request, body)
        );
        if (response.ok && teamJoinEvent) {
          await this.handleTeamJoinWelcome(connection.id, teamJoinEvent);
        }
        return response;
      }
    }

    const fallbackConnection = await this.getDefaultConnection();
    if (fallbackConnection) {
      if (!(await this.deps.ensureConnectionRunning(fallbackConnection.id))) {
        return new Response("Slack connection unavailable", { status: 503 });
      }
      const response = await this.deps.forwardWebhook(
        fallbackConnection.id,
        this.cloneRequestWithBody(request, body)
      );
      if (
        response.ok &&
        teamJoinEvent &&
        (!fallbackConnection.metadata?.teamId ||
          fallbackConnection.metadata.teamId === teamJoinEvent.teamId)
      ) {
        await this.handleTeamJoinWelcome(fallbackConnection.id, teamJoinEvent);
      }
      return response;
    }

    const { chat, adapter } = await this.createOAuthChat();
    try {
      return await adapter.handleWebhook(
        this.cloneRequestWithBody(request, body)
      );
    } finally {
      await chat.shutdown().catch((err) => {
        logger.warn(
          { error: String(err) },
          "Failed to shut down Slack webhook chat"
        );
      });
    }
  }

  resolveAdapterConfig(options?: {
    requireOAuth?: boolean;
  }): PlatformAdapterConfig {
    const currentConfig = this.deps.getCurrentSlackConfig();
    const signingSecret =
      process.env.SLACK_SIGNING_SECRET || currentConfig.signingSecret;
    const clientId = process.env.SLACK_CLIENT_ID || currentConfig.clientId;
    const clientSecret =
      process.env.SLACK_CLIENT_SECRET || currentConfig.clientSecret;
    const encryptionKey =
      process.env.SLACK_ENCRYPTION_KEY || currentConfig.encryptionKey;
    const installationKeyPrefix =
      process.env.SLACK_INSTALLATION_KEY_PREFIX ||
      currentConfig.installationKeyPrefix;
    const userName = process.env.SLACK_BOT_USERNAME || currentConfig.userName;

    if (!signingSecret) {
      throw new Error("Slack signing secret is not configured");
    }

    if (options?.requireOAuth) {
      if (!clientId || !clientSecret) {
        throw new Error(
          "Slack OAuth is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET."
        );
      }

      return {
        platform: "slack",
        signingSecret,
        clientId,
        clientSecret,
        ...(encryptionKey ? { encryptionKey } : {}),
        ...(installationKeyPrefix ? { installationKeyPrefix } : {}),
        ...(userName ? { userName } : {}),
      };
    }

    const botToken = process.env.SLACK_BOT_TOKEN || currentConfig.botToken;
    if (!botToken && (!clientId || !clientSecret)) {
      throw new Error(
        "Slack adapter is not configured. Provide SLACK_BOT_TOKEN or Slack OAuth credentials."
      );
    }

    return {
      platform: "slack",
      signingSecret,
      ...(botToken ? { botToken } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(encryptionKey ? { encryptionKey } : {}),
      ...(installationKeyPrefix ? { installationKeyPrefix } : {}),
      ...(userName ? { userName } : {}),
    };
  }

  extractTeamId(body: string, contentType: string): string | null {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      const directTeamId = params.get("team_id");
      if (directTeamId) {
        return directTeamId;
      }

      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return null;
      }

      try {
        const payload = JSON.parse(payloadStr) as {
          team?: { id?: string };
          team_id?: string;
        };
        return payload.team?.id || payload.team_id || null;
      } catch {
        return null;
      }
    }

    try {
      const payload = JSON.parse(body) as {
        team_id?: string;
        team?: string;
        event?: { team_id?: string; team?: string };
      };
      return (
        payload.team_id ||
        payload.team ||
        payload.event?.team_id ||
        payload.event?.team ||
        null
      );
    } catch {
      return null;
    }
  }

  private async createOAuthChat(options?: { requireOAuth?: boolean }) {
    const { Chat } = await import("chat");
    const { createSlackAdapter } = await import("@chat-adapter/slack");

    const adapter = createSlackAdapter(
      this.resolveAdapterConfig(options) as any
    );
    const state = await this.deps.createStateAdapter();

    const chat = new Chat({
      userName: "lobu-slack-oauth",
      adapters: { slack: adapter },
      state,
      logger: "warn",
    });

    await chat.initialize();
    return { chat, adapter: adapter as SlackOAuthAdapter };
  }

  private cloneRequestWithBody(request: Request, body: string): Request {
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : body,
    });
  }

  private async handleTeamJoinWelcome(
    connectionId: string,
    event: ParsedSlackTeamJoinEvent
  ): Promise<void> {
    const chat = this.deps.getRunningChat(connectionId);
    if (!chat) {
      return;
    }

    try {
      await postSlackTeamJoinWelcome(chat, event);
    } catch (error) {
      logger.warn(
        {
          connectionId,
          teamId: event.teamId,
          userId: event.userId,
          error: String(error),
        },
        "Failed to send Slack team_join welcome message"
      );
    }
  }
}
