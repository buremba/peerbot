import { createLogger } from "@lobu/core";
import { Chat } from "chat";
import type { AppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import {
  getSlackInstallByTeamId,
  upsertSlackInstallByTeam,
} from "../../lobu/stores/slack-installations.js";
import type { WritableSecretStore } from "../secrets/index.js";
import {
  getPrimedBundledMethod,
  resolveAppInstallCredentials,
} from "../installation/app-install-credentials.js";
import type { PlatformAdapterConfig, PlatformConnection } from "./types.js";
import {
  parseSlackTeamJoinEvent,
  postSlackTeamJoinWelcome,
  type ParsedSlackTeamJoinEvent,
} from "./slack-platform-bridge.js";

const logger = createLogger("slack-connection-coordinator");

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

/**
 * App-level Slack credentials for the shared (hosted) Lobu Slack app.
 *
 * The three core OAuth/signing keys (clientId, clientSecret, signingSecret)
 * are read via the declared env-var names from the Slack catalog connector
 * (primed at boot by primeAppInstallationMethods). All other keys (botToken,
 * encryptionKey, installationKeyPrefix, userName) remain direct env reads —
 * they are not part of the app_installation auth schema.
 *
 * Reading from env (not from whatever connection happens to be warm on the
 * current pod) makes config resolution deterministic across replicas — every
 * pod sees the same values regardless of which Slack connections it has warmed.
 * Per-workspace connections persist only tenant data (bot token); the Slack
 * adapter falls back to these env vars at runtime, so rotating them does not
 * require reinstalling each workspace.
 *
 * When the env is unset, OAuth/preview is simply unavailable and operators must
 * bring their own Slack credentials on a per-connection basis.
 */
function readSlackAppEnvConfig(): SlackRuntimeConfig {
  // Use the declared env-var names from the Slack connector declaration (primed
  // at boot). Falls back to direct env reads when the bundled method is not
  // primed (e.g. a build without the connector on disk), so startup ordering
  // is never a hard failure.
  const primedMethod = getPrimedBundledMethod("slack", "slack");
  const declared = primedMethod
    ? resolveAppInstallCredentials(primedMethod)
    : null;
  return {
    signingSecret: declared?.webhookSecret ?? process.env.SLACK_SIGNING_SECRET,
    clientId: declared?.clientId ?? process.env.SLACK_CLIENT_ID,
    clientSecret: declared?.clientSecret ?? process.env.SLACK_CLIENT_SECRET,
    encryptionKey: process.env.SLACK_ENCRYPTION_KEY,
    installationKeyPrefix: process.env.SLACK_INSTALLATION_KEY_PREFIX,
    userName: process.env.SLACK_USER_NAME,
    botToken: process.env.SLACK_BOT_TOKEN,
  };
}

interface SlackConnectionCoordinatorDeps {
  createStateAdapter(): Promise<any>;
  ensureConnectionRunning(connectionId: string): Promise<boolean>;
  forwardWebhook(connectionId: string, request: Request): Promise<Response>;
  getRunningChat(connectionId: string): any | undefined;
  listSlackConnections(): Promise<PlatformConnection[]>;
  /**
   * The generic app-installation store. Slack OAuth workspace installs are a
   * thin projection over it (`lobu/stores/slack-installations.ts`) — no bespoke
   * table or store. Resolved lazily so building the coordinator never forces the
   * store to exist; only the install/webhook paths actually need it.
   */
  getAppInstallationStore(): AppInstallationStore;
  /** Secret store for persisting/purging the per-workspace bot token. */
  getSecretStore(): WritableSecretStore;
}

export class SlackConnectionCoordinator {
  constructor(private readonly deps: SlackConnectionCoordinatorDeps) {}

  async findConnectionByTeamId(
    teamId: string
  ): Promise<PlatformConnection | null> {
    const connections = await this.deps.listSlackConnections();
    return (
      connections.find(
        (connection) =>
          connection.metadata?.teamId === teamId &&
          // A stopped BYO connection must not preempt routing — otherwise it
          // shadows an active OAuth install (an `app_installations` row) for the team
          // (matched first → 503, never falling through to the install).
          connection.status !== "stopped"
      ) || null
    );
  }

  /**
   * Resolve the connection that should handle a webhook we could NOT route by
   * team_id (url_verification challenges, events with no extractable team).
   *
   * Only the hosted shared-app / preview connection is a safe default: it is
   * explicitly marked `settings.previewMode === true` and belongs to no
   * specific tenant. Everything else is tenant-owned — a team-scoped row
   * obviously so, but ALSO a plain org-owned row with empty metadata (a BYO
   * connection created without an OAuth install never gets a `metadata.teamId`,
   * yet still carries that org's bot token). Forwarding an unmatched-team
   * webhook to any tenant-owned row would let one tenant's bot act on (and
   * reply with its own bot token to) another tenant's Slack traffic.
   * `listSlackConnections()` is platform-scoped only (the public `/api/v1/app-webhooks/slack`
   * route carries no org context, so the store's per-tenant predicate doesn't
   * apply) — so we must require the explicit preview marker and otherwise fail
   * closed (return null → handled-by-OAuth-fallback / 503) rather than pick a
   * foreign tenant.
   */
  async getDefaultConnection(): Promise<PlatformConnection | null> {
    const connections = await this.deps.listSlackConnections();
    return (
      connections.find(
        (connection) =>
          connection.settings?.previewMode === true &&
          !connection.metadata?.teamId
      ) || null
    );
  }

  /**
   * Persist a per-workspace OAuth install: the workspace's bot token + tenant
   * metadata, keyed on (org, team), as an `app_installations` row (provider=slack).
   * This is NOT an `agent_connections` row — an installed workspace has no owning agent;
   * it routes to many agents via `/lobu link` channel bindings. The token goes
   * to the secret store (the store handles that); app-level creds
   * (signingSecret/clientId/clientSecret) stay env-sourced at runtime. Idempotent
   * per (org, team) — a re-install refreshes the token on the same row id, so the
   * instance memo, secret prefix, and any existing bindings are unaffected.
   */
  async ensureWorkspaceInstallation(
    organizationId: string,
    teamId: string,
    installation: SlackInstallation
  ): Promise<{ installationId: string }> {
    const row = await upsertSlackInstallByTeam(
      this.deps.getAppInstallationStore(),
      this.deps.getSecretStore(),
      organizationId,
      teamId,
      {
        teamName: installation.teamName,
        botUserId: installation.botUserId,
        botToken: installation.botToken,
      }
    );
    return { installationId: row.id };
  }

  async completeOAuthInstall(
    request: Request,
    redirectUri: string | undefined,
    organizationId: string
  ): Promise<{
    teamId: string;
    teamName?: string;
    installationId: string;
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
      let installationId: string;
      try {
        ({ installationId } = await this.ensureWorkspaceInstallation(
          organizationId,
          teamId,
          installation
        ));
      } catch (error) {
        await adapter.deleteInstallation(teamId).catch((err) => {
          logger.warn(
            { teamId, error: String(err) },
            "Failed to delete Slack installation after persistence error"
          );
        });
        throw error;
      }

      return {
        teamId,
        teamName: installation.teamName,
        installationId,
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
      // 1) A BYO agent-owned Slack connection for this workspace (created via
      //    the UI with its own bot token) — unchanged legacy path.
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

      // 2) An OAuth-installed workspace (the "Add to Slack" path). The install
      //    is an `app_installations` row (provider=slack), not `agent_connections`;
      //    the manager hydrates an agentless Slack instance from it (the
      //    `slackinst-` id is namespaced, so `ensureConnectionRunning`/
      //    `forwardWebhook` resolve it via the Slack install projection). Per-message
      //    routing is via `/lobu link` bindings.
      const installation = await getSlackInstallByTeamId(
        this.deps.getAppInstallationStore(),
        teamId
      );
      if (installation && installation.status !== "stopped") {
        if (!(await this.deps.ensureConnectionRunning(installation.id))) {
          return new Response("Slack connection unavailable", { status: 503 });
        }
        const response = await this.deps.forwardWebhook(
          installation.id,
          this.cloneRequestWithBody(request, body)
        );
        if (response.ok && teamJoinEvent) {
          await this.handleTeamJoinWelcome(installation.id, teamJoinEvent);
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
    const currentConfig = readSlackAppEnvConfig();
    const {
      signingSecret,
      clientId,
      clientSecret,
      encryptionKey,
      installationKeyPrefix,
      userName,
    } = currentConfig;

    if (!signingSecret) {
      throw new Error("Slack signing secret is not configured. Set SLACK_SIGNING_SECRET.");
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

    const botToken = currentConfig.botToken;
    if (!botToken && (!clientId || !clientSecret)) {
      throw new Error(
        "Slack adapter is not configured. Set SLACK_BOT_TOKEN, or SLACK_CLIENT_ID and SLACK_CLIENT_SECRET."
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
