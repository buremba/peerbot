import { describe, expect, test } from "bun:test";
import type { BehaviorTriggerInput } from "../../tools/admin/manage_behaviors/executors";
import {
	assertBehaviorExecutorsResolve,
	resolveBehaviorExecutor,
	resolveTriggerExecutor,
} from "../../tools/admin/manage_behaviors/executors";

const eventTrigger = (
	respondWith?: BehaviorTriggerInput["respond_with"],
): BehaviorTriggerInput => ({
	kind: "event",
	connector_key: "github",
	event_types: ["pull_request.created"],
	...(respondWith ? { respond_with: respondWith } : {}),
});

const scheduleTrigger = (
	respondWith?: BehaviorTriggerInput["respond_with"],
): BehaviorTriggerInput => ({
	kind: "schedule",
	cron: "0 9 * * *",
	...(respondWith ? { respond_with: respondWith } : {}),
});

describe("resolveTriggerExecutor", () => {
	test("explicit respond_with agent override wins over defaults", () => {
		const resolved = resolveTriggerExecutor(
			eventTrigger({ kind: "agent", agent_id: "agent-b" }),
			{ agentId: "agent-a", deviceWorkerId: "device-1" },
		);
		expect(resolved).toEqual({ kind: "agent", agentId: "agent-b" });
	});

	test("explicit respond_with device override wins over defaults", () => {
		const resolved = resolveTriggerExecutor(eventTrigger({
			kind: "device",
			device_worker_id: "device-9",
			agent_kind: "claude-code",
		}), { agentId: "agent-a" });
		expect(resolved).toEqual({
			kind: "device",
			deviceWorkerId: "device-9",
			agentKind: "claude-code",
		});
	});

	// Legacy dual rows carried both agent_id and device_worker_id and always
	// ran on the device lane (#802). The fallback MUST be device-pin-first or
	// existing device-pinned behaviors flip to server dispatch.
	test("fallback prefers the device pin over the agent", () => {
		const resolved = resolveTriggerExecutor(eventTrigger(), {
			agentId: "agent-a",
			deviceWorkerId: "device-1",
			agentKind: "codex",
		});
		expect(resolved).toEqual({
			kind: "device",
			deviceWorkerId: "device-1",
			agentKind: "codex",
		});
	});

	test("fallback uses the agent when no device pin", () => {
		const resolved = resolveTriggerExecutor(scheduleTrigger(), {
			agentId: "agent-a",
		});
		expect(resolved).toEqual({ kind: "agent", agentId: "agent-a" });
	});

	test("no executor anywhere resolves to null", () => {
		expect(resolveTriggerExecutor(eventTrigger(), {})).toBeNull();
	});
});

describe("resolveBehaviorExecutor", () => {
	test("device-first at the behavior level too", () => {
		expect(
			resolveBehaviorExecutor({ agentId: "a", deviceWorkerId: "d" }),
		).toEqual({ kind: "device", deviceWorkerId: "d", agentKind: null });
		expect(resolveBehaviorExecutor({ agentId: "a" })).toEqual({
			kind: "agent",
			agentId: "a",
		});
		expect(resolveBehaviorExecutor({})).toBeNull();
	});
});

describe("assertBehaviorExecutorsResolve", () => {
	test("manual-only behaviors (no triggers) pass with or without an executor", () => {
		expect(() => assertBehaviorExecutorsResolve([], {})).not.toThrow();
		expect(() =>
			assertBehaviorExecutorsResolve(undefined, {}),
		).not.toThrow();
		expect(() =>
			assertBehaviorExecutorsResolve([], { agentId: "a" }),
		).not.toThrow();
	});

	test("automated triggers require a Behavior-level executor", () => {
		expect(() =>
			assertBehaviorExecutorsResolve([eventTrigger()], {}),
		).toThrow(/Behavior-level executor/);
		expect(() =>
			assertBehaviorExecutorsResolve([scheduleTrigger()], {}),
		).toThrow(/Behavior-level executor/);
	});

	// respond_with is a pure override: it can never be the sole executor,
	// because the scheduler/event SELECTs gate on row-level columns — an
	// override-only behavior would validate but never fire.
	test("override-only executors are rejected", () => {
		expect(() =>
			assertBehaviorExecutorsResolve(
				[eventTrigger({ kind: "agent", agent_id: "agent-b" })],
				{},
			),
		).toThrow(/Behavior-level executor/);
	});

	test("behavior-level executor satisfies all automated triggers", () => {
		expect(() =>
			assertBehaviorExecutorsResolve(
				[
					eventTrigger({ kind: "agent", agent_id: "agent-b" }),
					scheduleTrigger(),
				],
				{ agentId: "agent-a" },
			),
		).not.toThrow();
		expect(() =>
			assertBehaviorExecutorsResolve([eventTrigger()], {
				deviceWorkerId: "device-1",
			}),
		).not.toThrow();
	});
});
