import { createLogger } from "@lobu/core";
import {
	getChatInstanceManager,
	isLobuGatewayRunning,
} from "../../lobu/gateway.js";
import { slugToRuntimeConnectionId } from "../../lobu/stores/connections-projection.js";

const logger = createLogger("bind-channel-notify");

type ChatInstanceManagerLike = {
	postMessageToChannel: (
		connectionId: string,
		channelKey: string,
		content: { markdown: string },
	) => Promise<void>;
};

type BindChannelNotifyDeps = {
	getManager: () => ChatInstanceManagerLike | null | undefined;
	gatewayRunning: () => boolean;
};

let deps: BindChannelNotifyDeps = {
	getManager: getChatInstanceManager,
	gatewayRunning: isLobuGatewayRunning,
};

/** Test hook: override gateway/manager accessors used by bind confirmation. */
export function __setBindChannelNotifyDepsForTests(
	next: Partial<BindChannelNotifyDeps>,
): void {
	deps = { ...deps, ...next };
}

/** Escape chars that would break a markdown `[label](url)` link label. */
function escapeMarkdownLinkLabel(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
}

export function channelBindConfirmationText(
	agentName: string,
	agentUrl?: string,
): string {
	const agentRef = agentUrl
		? `[${escapeMarkdownLinkLabel(agentName)}](${agentUrl})`
		: `**${agentName}**`;
	return `✅ Linked to ${agentRef}. I'll reply here from now on.`;
}

function channelKey(platform: string, channelId: string): string {
	return channelId.includes(":") ? channelId : `${platform}:${channelId}`;
}

export type PostChannelBindConfirmationParams = {
	connectionSlug: string;
	platform: string;
	channelId: string;
	agentId: string;
	agentName: string;
	/** Owletto Behaviors page — rendered as the link label when set. */
	agentUrl?: string;
	/** When equal to `agentId`, skip — rebinding the same agent (e.g. model tweak). */
	previousAgentId?: string | null;
};

/**
 * Best-effort outbound ack after a single-channel bind. Uses the Chat SDK
 * adapter path (`ChatInstanceManager.postMessageToChannel`) so every chat
 * platform shares one code path. The binding is authoritative — delivery
 * failure is logged and swallowed.
 */
export async function postChannelBindConfirmation(
	params: PostChannelBindConfirmationParams,
): Promise<void> {
	const {
		connectionSlug,
		platform,
		channelId,
		agentId,
		agentName,
		agentUrl,
		previousAgentId,
	} = params;

	if (previousAgentId === agentId) return;
	if (!deps.gatewayRunning()) return;

	const manager = deps.getManager();
	if (!manager?.postMessageToChannel) return;
	const runtimeConnectionId = slugToRuntimeConnectionId(connectionSlug);
	const key = channelKey(platform, channelId);

	try {
		await manager.postMessageToChannel(runtimeConnectionId, key, {
			markdown: channelBindConfirmationText(agentName, agentUrl),
		});
	} catch (err) {
		logger.warn(
			{
				err: String(err),
				connectionSlug,
				channelKey: key,
				agentId,
			},
			"bind confirmation post failed (binding still succeeded)",
		);
	}
}

/** Fire-and-forget — tool handlers must not block on chat delivery. */
export function scheduleChannelBindConfirmation(
	params: PostChannelBindConfirmationParams,
): void {
	void postChannelBindConfirmation(params).catch(() => {});
}