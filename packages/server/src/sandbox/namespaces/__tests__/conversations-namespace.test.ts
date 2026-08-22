/**
 * conversations SDK namespace — regression for the failure-conversion trap.
 *
 * `send` returns a discriminated result whose `status` may be "error" or
 * "timeout" — NON-throwing outcomes the caller must branch on. The generic
 * named-method wrapper runs failureMessage(), which turns a result with
 * `status:"error"` / `status:"timeout"` (or an `error` field) into a thrown
 * ClientSdkActionError. `send` disables that conversion. This test pins that:
 * a mocked handler returning each status comes back as a VALUE, and a genuine
 * handler throw still propagates.
 *
 * Uses vi.doMock + vi.resetModules + dynamic import (NOT hoisted vi.mock): the
 * integration suite shares a module registry across files, where a hoisted
 * vi.mock does not reliably replace the module — the namespace would then call
 * the REAL manageConversations and hit routeAction's access gate. doMock scoped
 * per test + a fresh import registry keeps the mock hermetic. [[vitest module-
 * mock isolation]]
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { withValidatedArgs } from "../../../tools/validate-args";

const env = { ENVIRONMENT: "test" } as Env;
const ctx = { organizationId: "o", userId: "u" } as ToolContext;

/** Register the handler mock, then dynamic-import the namespace against it. */
async function loadNamespaceWith(handler: () => Promise<unknown>) {
	vi.resetModules();
	vi.doMock("../../../tools/admin/manage_conversations", () => ({
		manageConversations: withValidatedArgs(
			"manage_conversations",
			Type.Object({}, { additionalProperties: true }),
			handler,
		),
	}));
	const { buildConversationsNamespace } = await import("../conversations.js");
	return buildConversationsNamespace(ctx, env);
}

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("../../../tools/admin/manage_conversations");
});

describe("conversations namespace — send does not throw on error/timeout status", () => {
	it("returns a status:'error' result as a VALUE (not thrown)", async () => {
		const ns = await loadNamespaceWith(() =>
			Promise.resolve({
				action: "send",
				conversation_id: "c",
				message_id: "m",
				status: "error",
				error: "provider down",
			}),
		);
		const res = (await ns.send({ agent_id: "a", text: "hi" })) as Record<
			string,
			unknown
		>;
		expect(res.status).toBe("error");
		expect(res.error).toBe("provider down");
	});

	it("returns a status:'timeout' result as a VALUE (not thrown)", async () => {
		const ns = await loadNamespaceWith(() =>
			Promise.resolve({
				action: "send",
				conversation_id: "c",
				message_id: "m",
				status: "timeout",
			}),
		);
		const res = (await ns.send({ agent_id: "a", text: "hi" })) as Record<
			string,
			unknown
		>;
		expect(res.status).toBe("timeout");
	});

	it("returns a status:'complete' reply as a VALUE", async () => {
		const ns = await loadNamespaceWith(() =>
			Promise.resolve({
				action: "send",
				conversation_id: "c",
				message_id: "m",
				status: "complete",
				reply: "the answer",
			}),
		);
		const res = (await ns.send({ agent_id: "a", text: "hi" })) as Record<
			string,
			unknown
		>;
		expect(res.status).toBe("complete");
		expect(res.reply).toBe("the answer");
	});

	it("still propagates a genuine handler throw", async () => {
		const ns = await loadNamespaceWith(() =>
			Promise.reject(new Error("boom")),
		);
		await expect(ns.send({ agent_id: "a", text: "hi" })).rejects.toThrow(
			/boom/,
		);
	});
});
