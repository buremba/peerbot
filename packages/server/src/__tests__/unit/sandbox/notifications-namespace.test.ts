/**
 * notifications SDK namespace — list/markRead parity with REST.
 *
 * Proves the SDK methods call the same service layer as REST (listNotifications /
 * markAsRead) rather than reimplementing SQL.
 */

import { beforeAll, describe, expect, it, mock } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { withValidatedArgs } from "../../../tools/validate-args";

const listCalls: Array<Record<string, unknown>> = [];
const markCalls: Array<{ organizationId: string; userId: string; id: number }> =
	[];
const notifyCalls: Array<{
	args: Record<string, unknown>;
	env: Env;
	ctx: ToolContext;
}> = [];
let listResult: {
	notifications: Array<Record<string, unknown>>;
	nextCursor: number | null;
} = { notifications: [], nextCursor: null };
let markResult = true;

mock.module("../../../notifications/service", () => ({
	listNotifications: async (opts: Record<string, unknown>) => {
		listCalls.push(opts);
		return listResult;
	},
	markAsRead: async (
		organizationId: string,
		userId: string,
		notificationId: number,
	) => {
		markCalls.push({ organizationId, userId, id: notificationId });
		return markResult;
	},
}));

mock.module("../../../tools/admin/notify", () => ({
	notify: withValidatedArgs(
		"notify",
		Type.Object({}, { additionalProperties: true }),
		async (
			args: Record<string, unknown>,
			notifyEnv: Env,
			notifyCtx: ToolContext,
		) => {
			notifyCalls.push({ args, env: notifyEnv, ctx: notifyCtx });
			return {
				notified_count: 1,
				event_id: 41,
				url: "/atlas/activity?event=41",
				run_id: 42,
			};
		}
	),
}));

const env = { ENVIRONMENT: "test" } as Env;
const ctx = {
	organizationId: "org-1",
	userId: "user-1",
} as ToolContext;

let buildNotificationsNamespace: typeof import("../../../sandbox/namespaces/notifications").buildNotificationsNamespace;

beforeAll(async () => {
	({ buildNotificationsNamespace } = await import(
		"../../../sandbox/namespaces/notifications"
	));
});

describe("notifications namespace — list/markRead", () => {
	it("send forwards the question schema and returns its durable handles", async () => {
		notifyCalls.length = 0;
		const ns = buildNotificationsNamespace(ctx, env);
		const inputSchema = {
			type: "object",
			properties: { plan: { enum: ["legacy", "new"] } },
			required: ["plan"],
		};

		const result = await ns.send({
			title: "Which plan?",
			input_schema: inputSchema,
		});

		expect(notifyCalls).toEqual([
			{
				args: {
					title: "Which plan?",
					input_schema: inputSchema,
					action: "send",
				},
				env,
				ctx,
			},
		]);
		expect(result).toEqual({
			notified_count: 1,
			event_id: 41,
			url: "/atlas/activity?event=41",
			run_id: 42,
		});
	});

	it("list forwards org/user scope and pagination to the shared service", async () => {
		listCalls.length = 0;
		listResult = {
			notifications: [{ id: 10, title: "Hello", is_read: false }],
			nextCursor: null,
		};
		const ns = buildNotificationsNamespace(ctx, env);

		const result = await ns.list({ cursor: 99, limit: 5, unread_only: true });

		expect(listCalls).toEqual([
			{
				organizationId: "org-1",
				userId: "user-1",
				cursor: 99,
				limit: 5,
				unreadOnly: true,
			},
		]);
		expect(result).toEqual({
			notifications: [{ id: 10, title: "Hello", is_read: false }],
			nextCursor: null,
		});
	});

	it("markRead forwards an id returned by list", async () => {
		listCalls.length = 0;
		markCalls.length = 0;
		listResult = {
			notifications: [{ id: 42, title: "Ack me", is_read: false }],
			nextCursor: null,
		};
		markResult = true;
		const ns = buildNotificationsNamespace(ctx, env);

		const listed = await ns.list({ unread_only: true });
		const id = (listed.notifications[0] as { id: number }).id;
		const marked = await ns.markRead({ notification_id: id });

		expect(markCalls).toEqual([
			{ organizationId: "org-1", userId: "user-1", id: 42 },
		]);
		expect(marked).toEqual({ success: true });
	});

	it("markRead accepts a positional notification id", async () => {
		markCalls.length = 0;
		markResult = true;
		const ns = buildNotificationsNamespace(ctx, env);

		await ns.markRead(7);

		expect(markCalls).toEqual([
			{ organizationId: "org-1", userId: "user-1", id: 7 },
		]);
	});

	it("markRead throws when the target is missing or already read", async () => {
		markResult = false;
		const ns = buildNotificationsNamespace(ctx, env);

		await expect(ns.markRead({ notification_id: 404 })).rejects.toThrow(
			/not found or already read/i,
		);
	});

	it("rejects inbox access without an authenticated user", async () => {
		listCalls.length = 0;
		markCalls.length = 0;
		const ns = buildNotificationsNamespace({ ...ctx, userId: null }, env);

		await expect(ns.list()).rejects.toThrow(/authenticated user required/i);
		await expect(ns.markRead(7)).rejects.toThrow(
			/authenticated user required/i,
		);
		expect(listCalls).toEqual([]);
		expect(markCalls).toEqual([]);
	});
});
