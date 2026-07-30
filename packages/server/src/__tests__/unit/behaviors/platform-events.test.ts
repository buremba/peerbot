import { describe, expect, it } from "bun:test";
import {
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	withPlatformBehaviorEvents,
} from "../../../behaviors/platform-event-catalog";
import { pauseGenerationForFeed } from "../../../behaviors/platform-events";

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

describe("pauseGenerationForFeed", () => {
	it("uses first_failure_at epoch ms when present", () => {
		const at = new Date("2024-06-15T12:00:00.000Z");
		expect(
			pauseGenerationForFeed({
				first_failure_at: at,
				consecutive_failures: 9,
			}),
		).toBe(at.getTime());
	});

	it("falls back to consecutive_failures when first_failure_at is null", () => {
		expect(
			pauseGenerationForFeed({
				first_failure_at: null,
				consecutive_failures: 7,
			}),
		).toBe(7);
	});
});
