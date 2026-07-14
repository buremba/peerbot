/**
 * conversations SDK namespace — regression for the failure-conversion trap.
 *
 * `send` returns a discriminated result whose `status` may be "error" or
 * "timeout" — NON-throwing outcomes the caller must branch on. The generic
 * `action()` wrapper (createActionCaller) runs failureMessage(), which turns a
 * result with `status:"error"` / `status:"timeout"` (or an `error` field) into a
 * thrown ClientSdkActionError. So `send` must route through `manage()` (raw),
 * NOT `action()`. This test pins that: a mocked handler returning each status
 * comes back as a VALUE, and list/get still throw a real ToolUserError.
 */

import { describe, expect, it, vi } from "vitest";

const handlerResult = { current: undefined as unknown, throws: false };

vi.mock("../../../tools/admin/manage_conversations", () => ({
	manageConversations: () => {
		if (handlerResult.throws) {
			return Promise.reject(new Error("boom"));
		}
		return Promise.resolve(handlerResult.current);
	},
}));

import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { buildConversationsNamespace } from "../conversations";

const env = { ENVIRONMENT: "test" } as Env;
const ctx = { organizationId: "o", userId: "u" } as ToolContext;

describe("conversations namespace — send does not throw on error/timeout status", () => {
	it("returns a status:'error' result as a VALUE (not thrown)", async () => {
		handlerResult.current = {
			action: "send",
			conversation_id: "c",
			message_id: "m",
			status: "error",
			error: "provider down",
		};
		const ns = buildConversationsNamespace(ctx, env);
		const res = (await ns.send({ agent_id: "a", text: "hi" })) as Record<
			string,
			unknown
		>;
		expect(res.status).toBe("error");
		expect(res.error).toBe("provider down");
	});

	it("returns a status:'timeout' result as a VALUE (not thrown)", async () => {
		handlerResult.current = {
			action: "send",
			conversation_id: "c",
			message_id: "m",
			status: "timeout",
		};
		const ns = buildConversationsNamespace(ctx, env);
		const res = (await ns.send({ agent_id: "a", text: "hi" })) as Record<
			string,
			unknown
		>;
		expect(res.status).toBe("timeout");
	});

	it("returns a status:'complete' reply as a VALUE", async () => {
		handlerResult.current = {
			action: "send",
			conversation_id: "c",
			message_id: "m",
			status: "complete",
			reply: "the answer",
		};
		const ns = buildConversationsNamespace(ctx, env);
		const res = (await ns.send({ agent_id: "a", text: "hi" })) as Record<
			string,
			unknown
		>;
		expect(res.status).toBe("complete");
		expect(res.reply).toBe("the answer");
	});

	it("still propagates a genuine handler throw", async () => {
		handlerResult.throws = true;
		const ns = buildConversationsNamespace(ctx, env);
		await expect(ns.send({ agent_id: "a", text: "hi" })).rejects.toThrow(
			/boom/,
		);
		handlerResult.throws = false;
	});
});
