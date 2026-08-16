import { describe, expect, it } from "bun:test";
import {
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	withPlatformAutomationEvents,
} from "../../../automations/platform-event-catalog";
import { pauseGenerationForFeed } from "../../../automations/platform-events";

describe("platform automation events", () => {
	it("injects feed.auto_paused into an empty connector catalog", () => {
		const merged = withPlatformAutomationEvents([]);
		expect(merged.map((e) => e.key)).toContain(PLATFORM_EVENT_FEED_AUTO_PAUSED);
	});

	it("does not duplicate when the connector already declares the event", () => {
		const merged = withPlatformAutomationEvents([
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
	it("uses first_failure_at epoch milliseconds when present", () => {
		const at = new Date("2024-06-15T12:00:00.500Z");
		expect(
			pauseGenerationForFeed({
				first_failure_at: at,
				consecutive_failures: 9,
			}),
		).toBe(at.getTime());
	});

	it("keeps two episodes inside the same second distinct", () => {
		const first = pauseGenerationForFeed({
			first_failure_at: new Date("2024-06-15T12:00:00.100Z"),
			consecutive_failures: 3,
		});
		const second = pauseGenerationForFeed({
			first_failure_at: new Date("2024-06-15T12:00:00.900Z"),
			consecutive_failures: 3,
		});
		expect(second).not.toBe(first);
	});

	it("truncates sub-millisecond precision the way Postgres FLOOR does", () => {
		// postgres.js hands `new Date()` the raw timestamptz text; V8 truncates
		// digits past ms, matching FLOOR(EXTRACT(EPOCH …) * 1000) in SQL.
		expect(
			pauseGenerationForFeed({
				first_failure_at: "2024-06-15 12:00:00.123999+00",
				consecutive_failures: 3,
			}),
		).toBe(new Date("2024-06-15T12:00:00.123Z").getTime());
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
