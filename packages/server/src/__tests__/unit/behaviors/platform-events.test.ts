import { describe, expect, it } from "bun:test";
import {
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	withPlatformBehaviorEvents,
} from "../../../behaviors/platform-event-catalog";

describe("platform behavior events", () => {
	it("injects feed.auto_paused into an empty connector catalog", () => {
		const merged = withPlatformBehaviorEvents([]);
		expect(merged.map((e) => e.key)).toContain(PLATFORM_EVENT_FEED_AUTO_PAUSED);
	});

	it("does not duplicate when the connector already declares the event", () => {
		const merged = withPlatformBehaviorEvents([
			{ key: PLATFORM_EVENT_FEED_AUTO_PAUSED },
			{ key: "message.created" },
		]);
		expect(
			merged.filter((e) => e.key === PLATFORM_EVENT_FEED_AUTO_PAUSED),
		).toHaveLength(1);
		expect(merged.map((e) => e.key)).toEqual([
			PLATFORM_EVENT_FEED_AUTO_PAUSED,
			"message.created",
		]);
	});
});
