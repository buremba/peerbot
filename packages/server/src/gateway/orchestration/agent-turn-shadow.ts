/**
 * Shadow producer for the agent-turn isolate lane.
 *
 * A selected agent's turn is enqueued TWICE: once the ordinary way, to the
 * subprocess worker that answers the conversation, and once as an `agent_turn`
 * row the connector-worker fleet claims and runs inside an isolate. The shadow
 * copy is observational — its reply is written to its own run row by
 * `/api/workers/complete-agent-turn` and never reaches the client — so the two
 * lanes can be compared on live traffic before the isolate lane becomes
 * authoritative.
 *
 * Three things this producer must NOT do, each of which would corrupt the real
 * turn rather than merely observe it:
 *
 *  - Arm a turn-timeout marker. The marker is keyed
 *    `(deploymentName, messageId)` and discharged first-writer-wins, so a
 *    second marker for the same turn would let the shadow's outcome terminate
 *    the client's stream.
 *  - Write an `agent_run_input` journal row. Same key, same collision: a
 *    replay would resume the wrong lane.
 *  - Use a run type inside `LOBU_RUN_TYPES`. `agent_turn` is deliberately
 *    outside it, so `RunsQueue` never claims or completes these rows.
 *
 * Everything here is best-effort. `enqueueAgentTurnShadow` never throws into
 * the enqueue path, and the caller runs it AFTER the real message is on the
 * worker queue, so a shadow that cannot be produced costs the turn nothing.
 *
 * Selection is the operator env var `LOBU_ISOLATE_TURN_SHADOW_AGENTS`
 * (comma-separated agent ids, or `*`). It is an operator switch for a
 * short-lived overlap, not a product surface, so it is deliberately not an
 * agent column.
 */

import {
  createLogger,
  entryToMessage,
  getErrorMessage,
  type MessagePayload,
  parseSessionEntries,
  resolveSdkCompat,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import {
  readSnapshotJsonl,
  transcriptText,
} from "../services/transcript-snapshot.js";

const logger = createLogger("agent-turn-shadow");

const SHADOW_AGENTS_ENV = "LOBU_ISOLATE_TURN_SHADOW_AGENTS";

/**
 * pi-ai's two fetch-native adapters. Every other protocol in
 * `SDK_COMPAT_PROTOCOLS` reaches its upstream through a Node-bound SDK, which
 * cannot be bundled for the isolate — so those agents simply produce no shadow.
 */
const LANE_APIS = new Set(["anthropic-messages", "openai-completions"]);

/** Snapshot suffix read for history. Twelve 16 KB messages fit comfortably. */
const HISTORY_TAIL_CHARS = 256 * 1024;
const HISTORY_MESSAGE_LIMIT = 12;
const HISTORY_MESSAGE_CHARS = 16_000;
const TURN_MESSAGE_CHARS = 32_000;

export interface AgentTurnShadowDeps {
  /** Reads the agent's identity/soul/user layers. Absent → no shadow. */
  agentSettings?: AgentSettingsStore;
  /** Resolves the agent's provider modules. Absent → no shadow. */
  catalog?: ProviderCatalogService;
  /**
   * Externally reachable gateway origin the fleet worker resolves the secret
   * proxy on. Injected rather than read here so the caller owns the lookup: the
   * canonical accessor memoizes `PUBLIC_GATEWAY_URL` for the life of the
   * process, which a caller under test cannot vary without reaching into that
   * cache. Absent → no shadow, because there is no URL to hand the worker.
   */
  publicOrigin?: string;
}

function shadowSelects(agentId: string): boolean {
  const raw = process.env[SHADOW_AGENTS_ENV]?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(agentId);
}

/**
 * The system prompt for the shadow turn.
 *
 * DELIBERATELY REDUCED: the subprocess lane's prompt also carries platform,
 * network, skills and MCP instruction blocks, none of which the isolate lane
 * can act on yet (it has no tools). Composing only the three agent layers keeps
 * the comparison honest about what the lane can currently do, and matches the
 * worker's own section headings (`composeAgentInstructions`) so the identity
 * text itself is byte-identical.
 */
function composeShadowSystemPrompt(layers: {
  identityMd?: string | null;
  soulMd?: string | null;
  userMd?: string | null;
}): string {
  const sections: string[] = [];
  const identity = layers.identityMd?.trim();
  const soul = layers.soulMd?.trim();
  const user = layers.userMd?.trim();
  if (identity) sections.push(`## Agent Identity\n\n${identity}`);
  if (soul) sections.push(`## Agent Instructions\n\n${soul}`);
  if (user) sections.push(`## User Context\n\n${user}`);
  return sections.join("\n\n");
}

/**
 * Rebuild the conversation so far as pi messages.
 *
 * The snapshot stores pi's own entries, but a stored assistant entry carries
 * provider bookkeeping (usage, stop reason, tool calls) that this lane cannot
 * replay faithfully, so history is flattened to text and re-wrapped in the
 * minimal shapes pi's provider adapters read: `role` plus `content`. Tool
 * calls and their results are dropped with the rest — the shadow lane has no
 * tools, so replaying a tool call would produce a transcript the turn could
 * never have made.
 */
function historyMessages(snapshot: string, model: {
  api: string;
  provider: string;
  modelId: string;
}): Record<string, unknown>[] {
  const timestamp = 0;
  return parseSessionEntries(snapshot)
    .entries.flatMap((entry): Record<string, unknown>[] => {
      const message = entryToMessage(entry);
      if (
        message?.type !== "message" ||
        (message.role !== "user" && message.role !== "assistant")
      ) {
        return [];
      }
      const text = transcriptText(message.content).slice(
        0,
        HISTORY_MESSAGE_CHARS
      );
      if (!text) return [];
      if (message.role === "user") {
        return [{ role: "user", content: text, timestamp }];
      }
      return [
        {
          role: "assistant",
          content: [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.modelId,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp,
        },
      ];
    })
    .slice(-HISTORY_MESSAGE_LIMIT);
}

/**
 * Strip the provider prefix Lobu stores model refs under, so the upstream sees
 * its own bare model id.
 *
 * Exactly one prefix comes off, and only the resolved provider's own — its Lobu
 * id (`claude`) or its upstream slug (`anthropic`). A foreign inner namespace
 * (OpenRouter's `anthropic/claude-sonnet-4`) is left intact, the same rule the
 * worker's `resolveModelRef` applies.
 */
function bareModelId(
  ref: string,
  providerId: string,
  upstreamSlug: string | undefined
): string {
  for (const prefix of [providerId, upstreamSlug]) {
    if (prefix && ref.startsWith(`${prefix}/`)) {
      return ref.slice(prefix.length + 1);
    }
  }
  return ref;
}

interface ShadowProvider {
  api: string;
  provider: string;
  modelId: string;
  baseUrl: string;
  credential: string;
  host: string;
}

/**
 * Resolve the provider exactly the way the subprocess lane's session context
 * does: the agent's installed modules, the module that owns the requested
 * model, its agent-scoped secret-proxy URL and its credential placeholder.
 *
 * Returns null (with one log line) whenever the turn is not shadowable, which
 * is a normal outcome, not a failure: an agent on Google or Bedrock, a provider
 * with no proxy route, a credential the gateway cannot placeholder.
 */
async function resolveShadowProvider(
  module: ModelProviderModule,
  args: {
    agentId: string;
    organizationId: string;
    userId: string;
    modelRef: string;
    publicOrigin: string;
  }
): Promise<ShadowProvider | null> {
  const protocol = resolveSdkCompat(module.sdkCompat);
  if (!protocol || !LANE_APIS.has(protocol.api)) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId, api: protocol?.api ?? null },
      "Agent turn shadow skipped: the provider's protocol has no fetch-native adapter on the isolate lane"
    );
    return null;
  }

  const context = {
    organizationId: args.organizationId,
    userId: args.userId,
  };
  const mappings = module.getProxyBaseUrlMappings(
    `${args.publicOrigin}/api/proxy`,
    args.agentId,
    context
  );
  // Every module maps its base URL under one or more env-var names that all
  // carry the SAME URL (openai publishes a second alias). More than one
  // DISTINCT URL would mean the module routes by key, which this producer
  // cannot express in a single `base_url`.
  const routes = [...new Set(Object.values(mappings))];
  if (routes.length !== 1) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId, routes: routes.length },
      "Agent turn shadow skipped: the provider does not publish exactly one proxy base URL"
    );
    return null;
  }
  const baseUrl = routes[0];

  const credential = module.buildCredentialPlaceholder
    ? await module.buildCredentialPlaceholder(args.agentId, context)
    : "lobu-proxy";
  if (!credential) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId },
      "Agent turn shadow skipped: the provider produced no credential placeholder"
    );
    return null;
  }

  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    logger.warn(
      { agentId: args.agentId, provider: module.providerId },
      "Agent turn shadow skipped: the provider's proxy base URL does not parse"
    );
    return null;
  }

  return {
    api: protocol.api,
    provider: protocol.registryAlias,
    modelId: bareModelId(
      args.modelRef,
      module.providerId,
      module.getUpstreamConfig?.()?.slug
    ),
    baseUrl,
    credential,
    host,
  };
}

/**
 * Produce the shadow `agent_turn` run for this message, when one is selected
 * and resolvable. Never throws: the caller has already delivered the real turn.
 */
export async function enqueueAgentTurnShadow(
  data: MessagePayload,
  deps: AgentTurnShadowDeps
): Promise<void> {
  try {
    if (!data.agentId || !shadowSelects(data.agentId)) return;
    if (!data.organizationId) return;

    // An attachment-only message has no text for this lane to send, and both
    // providers reject an empty user turn — so it would enqueue a run that can
    // only fail. The isolate lane carries no attachments yet.
    if (!data.messageText?.trim()) {
      logger.info(
        { agentId: data.agentId, messageId: data.messageId },
        "Agent turn shadow skipped: the message carries no text for the turn to send"
      );
      return;
    }

    const modelRef = data.agentOptions?.model?.trim();
    if (!modelRef) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow skipped: this turn carries no resolved model, and the shadow does not re-run the worker's default resolution"
      );
      return;
    }

    const catalog = deps.catalog;
    const agentSettings = deps.agentSettings;
    if (!catalog || !agentSettings) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow skipped: the provider catalog or the agent settings store is not wired yet"
      );
      return;
    }

    const publicOrigin = deps.publicOrigin;
    if (!publicOrigin) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow skipped: PUBLIC_GATEWAY_URL is not configured, so there is no URL the fleet worker can reach the proxy on"
      );
      return;
    }

    const modules = await catalog.getInstalledModules(
      data.agentId,
      data.organizationId
    );
    const module = await catalog.findProviderForModel(modelRef, modules);
    if (!module) {
      logger.info(
        { agentId: data.agentId, model: modelRef },
        "Agent turn shadow skipped: no installed provider owns this model"
      );
      return;
    }

    const provider = await resolveShadowProvider(module, {
      agentId: data.agentId,
      organizationId: data.organizationId,
      userId: data.userId,
      modelRef,
      publicOrigin,
    });
    if (!provider) return;

    const settings = await agentSettings.getSettings(data.agentId, {
      organizationId: data.organizationId,
    });
    const snapshot = await readSnapshotJsonl({
      organizationId: data.organizationId,
      agentId: data.agentId,
      conversationId: data.conversationId,
      suffixChars: HISTORY_TAIL_CHARS,
    });

    const turn = {
      agent_id: data.agentId,
      conversation_id: data.conversationId,
      message_id: data.messageId,
      message_text: data.messageText.slice(0, TURN_MESSAGE_CHARS),
      system_prompt: composeShadowSystemPrompt(settings ?? {}),
      messages: snapshot ? historyMessages(snapshot, provider) : [],
      provider: {
        api: provider.api,
        provider: provider.provider,
        model_id: provider.modelId,
        base_url: provider.baseUrl,
      },
      // DENY-ALL. A connector's allowlist defaults open; an agent turn's does
      // not. The gateway proxy is the only host this turn has any business
      // reaching, and the provider is behind it.
      allowed_hosts: [provider.host],
      shadow: true,
    };

    const sql = getDb();
    const rows = await sql<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status,
        approval_status, action_input, created_at
      ) VALUES (
        ${data.organizationId}, 'agent_turn', 'pending',
        'auto', ${sql.json({ turn, credential: provider.credential })},
        current_timestamp
      )
      RETURNING id
    `;

    logger.info(
      {
        runId: rows[0]?.id,
        agentId: data.agentId,
        messageId: data.messageId,
        provider: provider.provider,
        model: provider.modelId,
        history: turn.messages.length,
      },
      "Enqueued a shadow agent turn on the isolate lane"
    );
  } catch (err) {
    // A shadow is never worth a real turn. The message is already on the
    // worker queue by the time this runs, so the only correct response to any
    // failure here is a log line.
    logger.warn(
      { agentId: data.agentId, messageId: data.messageId, err: getErrorMessage(err) },
      "Agent turn shadow could not be produced"
    );
  }
}
