/**
 * Where an approval card should be posted in chat.
 *
 * An approval is a decision exactly ONE human makes, so it must never ride the
 * org-wide notification fan-out (every channel any agent is bound to). This
 * module resolves the one legitimate chat destination, in precedence order:
 *
 *   1. The conversation that ASKED — the turn's `sourceContext`, when the caller
 *      came in through a chat trigger and the acting agent is authorized to post
 *      there. Same trust check the scheduled-delivery path uses, so a turn can
 *      never name a channel its agent may not reach.
 *   2. The requesting human's DM — handled downstream by the notification
 *      service's `ownerUserId` tier; the trigger passes the user id.
 *   3. Nothing. The durable inbox already targets the org's admins and the run
 *      parks behind its approval URL, so skipping chat costs no reachability.
 *
 * MCP callers (Claude Code, claude.ai) carry no chat coordinates at all, which
 * is why tier 2 exists: those approvals used to fall through to the org-wide
 * broadcast.
 */
import {
	isDeliverableChatPlatform,
	type ScheduledDeliveryContext,
	validateDeliveryAuthorization,
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
 * agent is authorized to deliver there. Returns all-nulls otherwise — the
 * caller pairs this with `requesterUserId` so tier 2 takes over.
 *
 * Authorization is NOT optional: `sourceContext` is stamped from a verified
 * worker token, but the binding it names can be revoked between the trigger and
 * the approval, so the live connection + binding rows are re-checked here
 * exactly as the scheduled fire-time path does.
 */
export async function resolveApprovalChatOrigin(
	ctx: ToolContext,
): Promise<ApprovalDeliveryTarget> {
	const delivery = sourceToDeliveryContext(ctx.sourceContext);
	if (!delivery) return NO_APPROVAL_DELIVERY_TARGET;
	// No acting agent means no binding to validate against — an agentless turn
	// (a human in the web app) has no channel it "belongs" to.
	if (!ctx.agentId) return NO_APPROVAL_DELIVERY_TARGET;

	const result = await validateDeliveryAuthorization({
		organizationId: ctx.organizationId,
		agentId: ctx.agentId,
		delivery,
	}).catch((err) => {
		logger.warn(
			{ err, organizationId: ctx.organizationId, agentId: ctx.agentId },
			"[Approvals] Chat-origin authorization check failed — falling back to requester DM",
		);
		return { authorized: false as const, reason: "connection-missing" as const };
	});
	if (!result.authorized) return NO_APPROVAL_DELIVERY_TARGET;

	return {
		connectionId: delivery.connectionId,
		channelId: delivery.channelId,
		teamId: delivery.teamId ?? null,
	};
}
