import type {
	ConnectorBehaviorEvent,
	ConnectorTriggerSignal,
} from "@lobu/connector-sdk";

export const SLACK_BEHAVIOR_EVENTS: ConnectorBehaviorEvent[] = [
	{
		key: "message.created",
		label: "A message is sent",
		description: "Runs for messages in the selected Slack conversation scope.",
		resourceType: "channel",
		filterSchema: {
			type: "object",
			properties: {
				channel_id: {
					type: "string",
					title: "Channel",
					description: "Optional channel or direct-message identifier.",
				},
				mention_only: {
					type: "boolean",
					title: "Only when mentioned",
				},
			},
		},
		capabilities: { steering: true, replyToSource: true },
		defaults: {
			execution: "turn",
			activeRun: "steer",
			output: "reply_to_source",
		},
	},
];

interface SlackMessageEvent {
	type?: string;
	channel?: string;
	user?: string;
	text?: string;
	bot_id?: string;
	subtype?: string;
	channel_type?: string;
	team?: string;
	thread_ts?: string;
	ts?: string;
}

interface SlackEventCallback {
	type?: string;
	team_id?: string;
	event?: SlackMessageEvent;
}

interface SlackUserMessageEvent extends SlackMessageEvent {
	channel: string;
	user: string;
}

function parseEventCallback(
	body: string,
	contentType: string,
): SlackEventCallback | null {
	// Slack uses form bodies for slash commands/interactivity. Those are a
	// different normalized event kind and must not be mistaken for messages.
	if (contentType.includes("application/x-www-form-urlencoded")) return null;
	try {
		const payload = JSON.parse(body) as SlackEventCallback;
		return payload.type === "event_callback" ? payload : null;
	} catch {
		return null;
	}
}

function isUserMessage(
	event: SlackMessageEvent,
): event is SlackUserMessageEvent {
	if (!event.channel || !event.user || event.bot_id || event.subtype)
		return false;
	return event.type === "app_mention" || event.type === "message";
}

/**
 * Backward-compatible narrow parser used by the unclaimed-workspace response.
 * Provider payload interpretation lives in the connector package, not gateway
 * core, even while that response path still consumes this smaller projection.
 */
export function parseSlackUserMessageEvent(
	body: string,
	contentType: string,
): { channel: string; user: string } | null {
	const event = parseEventCallback(body, contentType)?.event;
	if (!event || !isUserMessage(event)) return null;
	const isMention = event.type === "app_mention";
	const isDirectMessage =
		event.type === "message" && event.channel_type === "im";
	if (!isMention && !isDirectMessage) return null;
	return { channel: event.channel, user: event.user };
}

/**
 * Normalize a verified Slack Events API message into the same bounded signal
 * GitHub and other connectors use to activate a Behavior. The message text is
 * the turn input; routing/filter fields stay in normalized attributes.
 */
export function normalizeSlackBehaviorSignals(args: {
	body: string;
	contentType: string;
	deliveryId: string;
}): ConnectorTriggerSignal[] {
	if (!args.deliveryId) return [];
	const payload = parseEventCallback(args.body, args.contentType);
	const event = payload?.event;
	if (!event || !isUserMessage(event)) return [];

	const teamId = payload?.team_id ?? event.team;
	const channelId = event.channel;
	const isMention = event.type === "app_mention";
	const attributes: Record<string, string | number | boolean | null> = {
		channel_id: channelId,
		user_id: event.user,
		is_mention: isMention,
		mention_only: isMention,
	};
	if (teamId) attributes.team_id = teamId;
	if (event.channel_type) attributes.channel_type = event.channel_type;
	if (event.thread_ts) attributes.thread_id = event.thread_ts;
	if (event.ts) attributes.message_id = event.ts;

	return [
		{
			connector_key: "slack",
			resource_type: "channel",
			resource_ref: teamId
				? `slack:channel:${teamId}:${channelId}`
				: `slack:channel:${channelId}`,
			event_type: "message.created",
			delivery_id: args.deliveryId,
			label: `Slack message in ${channelId}`,
			input_text: event.text ?? "",
			attributes,
		},
	];
}
