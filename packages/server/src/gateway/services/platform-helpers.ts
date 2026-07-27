/**
 * Shared platform helpers.
 * Extracts common logic duplicated across Slack, Telegram, and WhatsApp message handlers.
 */

import {
  createLogger,
  type MessagePayload,
  type NixConfig,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { composeEffectiveModelRef } from "../auth/settings/model-selection.js";
import { getOrgDefaultModel } from "../../lobu/stores/provider-secrets.js";
import type { BehaviorSubscriptionService } from "../channels/behavior-subscription-service.js";

const logger = createLogger("platform-helpers");

/**
 * Resolve agent options by merging base options with per-agent settings.
 * Priority: agent settings > config defaults.
 */
export async function resolveAgentOptions(
  agentId: string,
  baseOptions: Record<string, any>,
	agentSettingsStore?: AgentSettingsStore,
	organizationId?: string,
): Promise<Record<string, any>> {
  if (!agentSettingsStore) {
    return { ...baseOptions };
  }

  // Scope by org: an agent id can exist in multiple orgs (e.g. a shared
  // system agent like "lobu-builder"), and the worker-dispatch path runs
  // without ambient orgContext, so an unscoped read returns an arbitrary org's
  // row — cross-tenant config bleed that mis-resolved the model to another
  // org's `models` list. Pass the org explicitly so the right row wins.
  const settings = await agentSettingsStore.getSettings(agentId, {
    organizationId,
  });
  if (!settings) {
    return { ...baseOptions };
  }

  const mergedOptions: Record<string, any> = { ...baseOptions };

  // Layered model fallback: behavior override → agent default → org default.
  // A per-behavior override arrives as baseOptions.model (injected at enqueue)
  // and wins; otherwise resolve agent.models[0], then the org default. Only
  // when all three are empty do we leave model unset (worker surfaces an
  // actionable "no model" error).
  //
  // A malformed override (not a `<slug>/<model>` ref — e.g. a legacy "auto"
  // binding, or a bare model id) is IGNORED here and falls through to the
  // agent default, rather than propagating an unroutable/ungated value. `auto`
  // is gone repo-wide, so it never wins as an override. The exact allow-list
  // gate (deployment-manager backstop) still validates the resulting ref.
  const rawOverride =
    typeof baseOptions.model === "string" ? baseOptions.model.trim() : "";
  const overrideSlash = rawOverride.indexOf("/");
  const behaviorOverride =
    overrideSlash > 0 &&
    overrideSlash < rawOverride.length - 1 &&
    rawOverride.slice(overrideSlash + 1) !== "auto"
      ? rawOverride
      : "";
  if (rawOverride && !behaviorOverride) {
    logger.warn(
      { agentId, rejectedOverride: rawOverride },
      "Ignoring malformed model override (not a <provider>/<model> ref); falling back to the agent default",
    );
  }
  const effectiveModelRef =
    behaviorOverride ||
    (await composeEffectiveModelRef(
      settings,
      organizationId,
      getOrgDefaultModel,
    ));
  logger.info(
    { agentId, behaviorOverride: behaviorOverride || undefined, effectiveModel: effectiveModelRef },
		"Applying agent settings",
  );

  if (effectiveModelRef) {
    mergedOptions.model = effectiveModelRef;
  } else {
    delete mergedOptions.model;
  }

  if (settings.networkConfig) {
    mergedOptions.networkConfig = settings.networkConfig;
  }
  if (settings.guardrailsInline?.length) {
    mergedOptions.guardrailsInline = settings.guardrailsInline;
  }
  // Nix packages come from three places and every one of them is a hard
  // requirement of some code that will run in the spawned worker, so union
  // them rather than letting the last writer win:
  //   1. baseOptions.nixConfig  — per-request `nix` (POST /agents supplies it),
  //   2. settings.nixConfig     — the agent's own packages (CLI apply bakes the
  //                               skill union at apply time into this too),
  //   3. enabled skills' nixPackages — skills enabled via the UI/catalog write
  //                               only `skills_config`, so nothing recomputes
  //                               `nixConfig` and their packages never reached
  //                               provisioning before this.
  // Absent stays absent: with no nix anywhere, `nixConfig` is left unset so the
  // worker spawns without a nix-shell wrap.
  const skillNixPackages = (settings.skillsConfig?.skills ?? [])
    .filter((skill) => skill.enabled)
    .flatMap((skill) => skill.nixPackages ?? []);
  const baseNixConfig = mergedOptions.nixConfig as NixConfig | undefined;
  if (baseNixConfig || settings.nixConfig || skillNixPackages.length > 0) {
    const packages = [
      ...new Set([
        ...(baseNixConfig?.packages ?? []),
        ...(settings.nixConfig?.packages ?? []),
        ...skillNixPackages,
      ]),
    ];
    mergedOptions.nixConfig = {
      ...baseNixConfig,
      ...settings.nixConfig,
      ...(packages.length > 0 ? { packages } : {}),
    };
  }
  if (settings.toolsConfig) {
    mergedOptions.toolsConfig = settings.toolsConfig;
  }
  if (settings.preApprovedTools?.length) {
    mergedOptions.preApprovedTools = settings.preApprovedTools;
  }
  if (settings.verboseLogging !== undefined) {
    mergedOptions.verboseLogging = settings.verboseLogging;
  }

  return mergedOptions;
}

/**
 * Build a MessagePayload from common fields.
 * Extracts networkConfig, guardrailsInline, nixConfig, preApprovedTools from
 * agentOptions before constructing the payload.
 */
export function buildMessagePayload(params: {
  platform: string;
  userId: string;
  botId: string;
  conversationId: string;
  // Optional to match the wire `MessagePayload` (the worker reads
  // `payload.teamId ?? platformMetadata.teamId`). Slack always supplies it;
  // teamless platforms (Telegram) and synthetic scheduled wakes omit it
  // rather than stamping a placeholder.
  teamId?: string;
  agentId: string;
  organizationId: string;
  connectionId?: string;
  messageId: string;
  messageText: string;
  ephemeralContext?: string;
  channelId: string;
  platformMetadata: Record<string, any>;
  agentOptions: Record<string, any>;
}): MessagePayload {
  const {
    networkConfig,
    guardrailsInline,
    nixConfig,
    preApprovedTools,
    ...remainingOptions
  } = params.agentOptions;

  return {
    platform: params.platform,
    userId: params.userId,
    botId: params.botId,
    conversationId: params.conversationId,
    teamId: params.teamId,
    agentId: params.agentId,
    organizationId: params.organizationId,
    messageId: params.messageId,
    messageText: params.messageText,
    ephemeralContext: params.ephemeralContext,
    channelId: params.channelId,
    platformMetadata: params.platformMetadata,
    agentOptions: remainingOptions,
    networkConfig,
    guardrailsInline,
    nixConfig,
    preApprovedTools,
  };
}

/**
 * Resolve agent ID for an inbound platform event:
 *   1. an existing channel-subscribed Behavior wins;
 *   2. otherwise fall back to the connection's owning `agentId`.
 *
 * Returns `null` when neither resolves — the caller should drop the message.
 * Pure resolution: never writes a Behavior.
 *
 * `crossOrg` is for hosted preview connections only: the bot lives in one org
 * but `/lobu link <code>` binds agents from OTHER orgs, so the lookup must be
 * org-agnostic and the binding's own `organizationId` is returned for routing.
 * Leave it false for normal bots, where org-scoping is the multi-tenant guard.
 */
export async function resolveAgentId(params: {
  platform: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
	connectionId?: string;
  behaviorSubscriptionService?: BehaviorSubscriptionService;
  crossOrg?: boolean;
}): Promise<{
  agentId: string;
  source: "subscription" | "connection";
  organizationId?: string;
  /** Per-binding model override (Listen behavior), when routed via a binding. */
  model?: string;
} | null> {
  const {
    platform,
    channelId,
    agentId,
    organizationId,
		connectionId,
    behaviorSubscriptionService,
    crossOrg,
  } = params;

  if (behaviorSubscriptionService) {
    // Subscriptions are org-scoped (a channel can be handled independently by
    // multiple tenants), so the read MUST be scoped to the inbound
		// connection's org. Preview connections are the deliberate exception: they
		// fan out across orgs, but still resolve through that concrete connection.
		const subscription =
			connectionId && organizationId
				? await behaviorSubscriptionService.resolveForConnection(
						connectionId,
          channelId,
						organizationId,
						crossOrg === true,
					)
				: null;
    if (subscription) {
      logger.info(
        {
          agentId: subscription.agentId,
          platform,
          channelId,
          subscriptionOrg: subscription.organizationId,
        },
				"Routing via message Behavior",
      );
      return {
        agentId: subscription.agentId,
        source: "subscription",
        organizationId: subscription.organizationId,
        model: subscription.model,
      };
    }
  }

  if (agentId) {
    logger.info(
      { agentId, platform, channelId },
			"Routing to connection's owning agent",
    );
    return { agentId, source: "connection", organizationId };
  }

  return null;
}
