import { describe, expect, test } from "bun:test";
import {
	GITHUB_BEHAVIOR_EVENTS,
	githubBehaviorSignalDrafts,
	githubPullRequestSubscribable,
	githubSyncShouldEmitBehaviorSignals,
} from "../github-behavior-events";

describe("GitHub Behavior events", () => {
	test("advertises a stable resource ref and useful default events", () => {
		const resource = githubPullRequestSubscribable("Lobu-AI/Lobu", 208);
		expect(resource).toEqual({
			connector_key: "github",
			resource_type: "pull_request",
			resource_ref: "github:pull_request:lobu-ai/lobu#208",
			label: "GitHub PR lobu-ai/lobu#208",
			suggested_event_keys: ["pull_request.updated"],
		});
	});

	test("normalizes a PR envelope without platform-owned routing fields", () => {
		expect(
			githubBehaviorSignalDrafts({
				origin_id: "pr_lobu-ai_lobu_208",
				origin_type: "pull_request",
				title: "Consolidate Behavior triggers",
				payload_text: "Make event activation connector-neutral.",
				source_url: "https://github.com/lobu-ai/lobu/pull/208",
				occurred_at: new Date("2026-07-17T12:00:00Z"),
				metadata: { repository: "lobu-ai/lobu", number: 208 },
			}),
		).toContainEqual(
			expect.objectContaining({
				event_type: "pull_request.created",
				updated_event_type: "pull_request.updated",
				resource_ref: "github:pull_request:lobu-ai/lobu#208",
			}),
		);
	});

	test("declares connection-scoped events without a second webhook parser", () => {
		expect(GITHUB_BEHAVIOR_EVENTS).toContainEqual(
			expect.objectContaining({
				key: "pull_request.created",
				resourceType: "pull_request",
			}),
		);
	});

	test("suppresses Behavior signals on cold-start / checkpoint-reset syncs", () => {
		// lookback_days floods pull_request.created for every first-seen PR when
		// last_sync_at is missing. Steady-state deltas keep signals.
		expect(githubSyncShouldEmitBehaviorSignals(null)).toBe(false);
		expect(githubSyncShouldEmitBehaviorSignals({})).toBe(false);
		expect(githubSyncShouldEmitBehaviorSignals({ last_sync_at: "" })).toBe(
			false,
		);
		expect(
			githubSyncShouldEmitBehaviorSignals({
				last_sync_at: "2026-07-01T00:00:00Z",
			}),
		).toBe(true);
	});
});
