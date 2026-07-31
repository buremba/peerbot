/**
 * Platform-owned Behavior event keys that every connector may declare.
 * Kept free of activation / DB imports so catalog validation and unit tests
 * stay dependency-light.
 */

/** Hard auto-pause after consecutive feed failures (feed-backoff). */
export const PLATFORM_EVENT_FEED_AUTO_PAUSED = "feed.auto_paused";

export interface PlatformBehaviorEventDef {
	key: string;
	description?: string;
	capabilities?: {
		steering?: boolean;
		replyToSource?: boolean;
	};
}

/** Injected into every connector's behavior_events catalog for trigger validation + UI. */
export const PLATFORM_BEHAVIOR_EVENTS: PlatformBehaviorEventDef[] = [
	{
		key: PLATFORM_EVENT_FEED_AUTO_PAUSED,
		description:
			"Fires once when Lobu hard-pauses a feed after too many consecutive sync failures.",
	},
];

/** Merge platform events into a connector's declared behavior_events list. */
export function withPlatformBehaviorEvents<T extends { key: string }>(
	events: T[],
): Array<T | PlatformBehaviorEventDef> {
	const seen = new Set(events.map((event) => event.key));
	const merged: Array<T | PlatformBehaviorEventDef> = [...events];
	for (const platform of PLATFORM_BEHAVIOR_EVENTS) {
		if (!seen.has(platform.key)) merged.push(platform);
	}
	return merged;
}
