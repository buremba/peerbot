import { describe, expect, it } from "bun:test";
import {
	parseWatcherSourceRef,
	validateWatcherSourceRef,
	watcherSourceKindForRef,
} from "../../watchers/source-refs";

describe("watcher source refs", () => {
	it("parses event-backed refs", () => {
		expect(parseWatcherSourceRef("@feed:support")).toEqual({
			type: "feed",
			value: "support",
		});
		expect(parseWatcherSourceRef("@connection:gmail")).toEqual({
			type: "connection",
			value: "gmail",
		});
		expect(parseWatcherSourceRef("@connector:slack")).toEqual({
			type: "connector",
			value: "slack",
		});
		expect(parseWatcherSourceRef("@channel:#support")).toEqual({
			type: "channel",
			value: "#support",
		});
	});

	it("parses entity and metric refs as context sources", () => {
		const entity = parseWatcherSourceRef("@entity:customer");
		const metric = parseWatcherSourceRef("@metric:customer.retention");

		expect(entity).toEqual({ type: "entity", value: "customer" });
		expect(metric).toEqual({
			type: "metric",
			entityType: "customer",
			measure: "retention",
		});
		expect(watcherSourceKindForRef(entity)).toBe("entity");
		expect(watcherSourceKindForRef(metric)).toBe("metric");
	});

	it("leaves raw SQL alone", () => {
		expect(parseWatcherSourceRef("SELECT id FROM events")).toBeNull();
		expect(validateWatcherSourceRef("content", "SELECT id FROM events")).toBeNull();
	});

	it("rejects unsupported or unsafe refs", () => {
		expect(() => parseWatcherSourceRef("@metric:customer")).toThrow(/metric/i);
		expect(() => parseWatcherSourceRef("@entity:bad.slug")).toThrow(/slug/i);
		expect(() => parseWatcherSourceRef("@feed:support';DROP")).toThrow(
			/unsupported characters/i,
		);
		expect(() => validateWatcherSourceRef("x", "@unknown:y")).toThrow(
			/unsupported/i,
		);
	});
});
