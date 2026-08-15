/**
 * Platform-owned Automation event keys that every connector may declare.
 * Kept free of activation / DB imports so catalog validation and unit tests
 * stay dependency-light.
 */

/** Hard auto-pause after consecutive feed failures (feed-backoff). */
export const PLATFORM_EVENT_FEED_AUTO_PAUSED = "feed.auto_paused";

export interface PlatformAutomationEventDef {
	key: string;
	description?: string;
	capabilities?: {
		steering?: boolean;
		replyToSource?: boolean;
	};
}

/** Injected into every connector's automation_events catalog for trigger validation + UI. */
export const PLATFORM_AUTOMATION_EVENTS: PlatformAutomationEventDef[] = [
	{
		key: PLATFORM_EVENT_FEED_AUTO_PAUSED,
		description:
			"Fires once when Lobu hard-pauses a feed after too many consecutive sync failures.",
	},
];

/** Merge platform events into a connector's declared automation_events list. */
export function withPlatformAutomationEvents<T extends { key: string }>(
	events: T[],
): Array<T | PlatformAutomationEventDef> {
	const seen = new Set(events.map((event) => event.key));
	const merged: Array<T | PlatformAutomationEventDef> = [...events];
	for (const platform of PLATFORM_AUTOMATION_EVENTS) {
		if (!seen.has(platform.key)) merged.push(platform);
	}
	return merged;
}
