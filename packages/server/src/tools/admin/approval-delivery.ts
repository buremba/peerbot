/**
 * Where an approval card should be posted in chat.
 *
 * An approval is a decision exactly ONE human makes, so it must never ride the
 * org-wide notification fan-out (every channel any agent is bound to). This
 * module resolves the one legitimate chat destination, in precedence order:
 *
 *   1. The conversation that ASKED — the turn's `sourceContext`, when the caller
 *      came in through a chat trigger and the acting agent is bound to that
 *      channel. Resolved through `resolveBoundChannelRows`, so a turn can never
 *      name a channel its agent may not reach.
 *   2. The requesting human's DM — handled downstream by the notification
 *      service's `ownerUserId` tier; the trigger passes the user id.
 *   3. Nothing. The durable inbox already targets the org's admins and the run
 *      parks behind its approval URL, so skipping chat costs no reachability.
 *
 * MCP callers (Claude Code, claude.ai) carry no chat coordinates at all, which
 * is why tier 2 exists: those approvals used to fall through to the org-wide
 * broadcast.
 */
import { getDb } from "../../db/client";
import {
	resolveBoundChannelRows,
	stripPlatformPrefix,
} from "../../gateway/channels/bound-channels";
import {
	isDeliverableChatPlatform,
	type ScheduledDeliveryContext,
} from "../../scheduled/scheduled-jobs-service";
import type { ToolContext, ToolSourceContext } from "../registry";
import logger from "../../utils/logger";

/** Chat coordinates a notification can actually be delivered into. */
interface ApprovalDeliveryTarget {
	connectionId: string | null;
	channelId: string | null;
	teamId: string | null;
}

const NO_APPROVAL_DELIVERY_TARGET: ApprovalDeliveryTarget = {
	connectionId: null,
	channelId: null,
	teamId: null,
};

/**
 * The turn's chat origin as a delivery context, or null when there isn't one.
 *
 * Only platforms the delivery path can actually post into; an unsupported or
 * partial source yields null rather than a dead target that silently never
 * posts. Shared with `manage_schedules`, which stores the same shape as a
 * scheduled job's `delivery_context`.
 */
export function sourceToDeliveryContext(
	source: ToolSourceContext | null | undefined,
): ScheduledDeliveryContext | null {
	if (!source?.platform || !isDeliverableChatPlatform(source.platform)) {
		return null;
	}
	if (!source.connectionId || !source.channelId || !source.conversationId) {
		return null;
	}
	return {
		platform: source.platform,
		conversationId: source.conversationId,
		channelId: source.channelId,
		teamId: source.teamId ?? null,
		connectionId: source.connectionId,
		userId: source.userId ?? null,
	};
}

/**
 * Tier 1 of the precedence above: the originating conversation, if the acting
 * agent can actually reach it. Returns all-nulls otherwise — the caller pairs
 * this with `requesterUserId` so tier 2 takes over.
 *
 * Re-checking is NOT optional: `sourceContext` is stamped from a verified worker
 * token, but the binding it names can be revoked between the trigger and the
 * approval, so the live binding rows decide.
 *
 * The check runs through `resolveBoundChannelRows` — THE single source of truth
 * for "which channels can this org/agent reach", and the same resolver the
 * delivery plan itself uses. That matters for a case a connection-scoped check
 * gets wrong: a hosted-preview binding is served by a connection living in a
 * DIFFERENT org, so any lookup scoped to the notifying org's `connections` finds
 * no row and reports the channel unreachable. Every preview-served org would
 * silently lose tier 1 and answer a channel question in a DM instead.
 * `resolveBoundChannelRows` covers the own-connection AND preview branches, and
 * is still scoped to `agentId` so an agent cannot address another agent's
 * channel.
 */
export async function resolveApprovalChatOrigin(
	ctx: ToolContext,
): Promise<ApprovalDeliveryTarget> {
	const delivery = sourceToDeliveryContext(ctx.sourceContext);
	if (!delivery) return NO_APPROVAL_DELIVERY_TARGET;
	// No acting agent means no binding to check against — an agentless turn
	// (a human in the web app) has no channel it "belongs" to.
	if (!ctx.agentId) return NO_APPROVAL_DELIVERY_TARGET;

	const rows = await resolveBoundChannelRows(getDb(), {
		organizationId: ctx.organizationId,
		agentId: ctx.agentId,
		connectionId: delivery.connectionId,
	}).catch((err) => {
		logger.warn(
			{ err, organizationId: ctx.organizationId, agentId: ctx.agentId },
			"[Approvals] Chat-origin binding check failed — falling back to requester DM",
		);
		return [];
	});

	// Bindings store either the bare id or the platform-prefixed one, so compare
	// on the native id — a legacy row must not read as "unreachable".
	const wanted = stripPlatformPrefix(delivery.platform, delivery.channelId);
	const reachable = rows.some(
		(row) =>
			row.platform === delivery.platform &&
			stripPlatformPrefix(row.platform, row.channel_id) === wanted,
	);
	if (!reachable) return NO_APPROVAL_DELIVERY_TARGET;

	return {
		connectionId: delivery.connectionId,
		channelId: delivery.channelId,
		teamId: delivery.teamId ?? null,
	};
}
