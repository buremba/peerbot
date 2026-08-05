import { describe, expect, test } from "bun:test";
import type { BehaviorTriggerInput } from "../../tools/admin/manage_behaviors/executors";
import {
	assertBehaviorExecutorsResolve,
	resolveBehaviorExecutor,
} from "../../tools/admin/manage_behaviors/executors";

const eventTrigger = (): BehaviorTriggerInput => ({
	kind: "event",
	connector_key: "github",
	event_types: ["pull_request.created"],
});

const scheduleTrigger = (): BehaviorTriggerInput => ({
	kind: "schedule",
	cron: "0 9 * * *",
});

describe("resolveBehaviorExecutor", () => {
	// Legacy dual rows carried both agent_id and device_worker_id and always
	// ran on the device lane (#802). Resolution MUST be device-pin-first or
	// existing device-pinned behaviors flip to server dispatch.
	test("device pin takes precedence over the agent", () => {
		expect(
			resolveBehaviorExecutor({ agentId: "a", deviceWorkerId: "d" }),
		).toEqual({ kind: "device", deviceWorkerId: "d", agentKind: null });
	});

	test("agent resolves when there is no device pin", () => {
		expect(resolveBehaviorExecutor({ agentId: "agent-a" })).toEqual({
			kind: "agent",
			agentId: "agent-a",
		});
	});

	test("device carries its runtime kind", () => {
		expect(
			resolveBehaviorExecutor({ deviceWorkerId: "d", agentKind: "codex" }),
		).toEqual({ kind: "device", deviceWorkerId: "d", agentKind: "codex" });
	});

	test("no executor resolves to null", () => {
		expect(resolveBehaviorExecutor({})).toBeNull();
	});
});

describe("assertBehaviorExecutorsResolve", () => {
	test("manual-only behaviors (no triggers) pass with or without an executor", () => {
		expect(() => assertBehaviorExecutorsResolve([], {})).not.toThrow();
		expect(() => assertBehaviorExecutorsResolve(undefined, {})).not.toThrow();
		expect(() =>
			assertBehaviorExecutorsResolve([], { agentId: "a" }),
		).not.toThrow();
	});

	test("automated behaviors require an executor", () => {
		expect(() => assertBehaviorExecutorsResolve([eventTrigger()], {})).toThrow(
			/executor/,
		);
		expect(() =>
			assertBehaviorExecutorsResolve([scheduleTrigger()], {}),
		).toThrow(/executor/);
	});

	test("an agent satisfies automated triggers", () => {
		expect(() =>
			assertBehaviorExecutorsResolve([eventTrigger(), scheduleTrigger()], {
				agentId: "agent-a",
			}),
		).not.toThrow();
	});

	test("a device pin satisfies automated triggers", () => {
		expect(() =>
			assertBehaviorExecutorsResolve([eventTrigger()], {
				deviceWorkerId: "device-1",
			}),
		).not.toThrow();
	});
});
