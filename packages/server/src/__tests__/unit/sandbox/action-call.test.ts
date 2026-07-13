import { describe, expect, it } from "bun:test";
import {
	ClientSdkActionError,
	createActionCaller,
} from "../../../sandbox/namespaces/action-call";
import { ToolUserError } from "../../../utils/errors";

describe("createActionCaller", () => {
	it("forces the action discriminator, ignoring a caller-supplied `action` key", async () => {
		const calls: object[] = [];
		const handler = async (payload: object) => {
			calls.push(payload);
			return payload;
		};
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		// A read-only caller tries to smuggle `action: "delete"` into a "list" call.
		await action("list", { action: "delete", entity_id: 42 });

		expect(calls).toHaveLength(1);
		expect((calls[0] as Record<string, unknown>).action).toBe("list");
		expect((calls[0] as Record<string, unknown>).entity_id).toBe(42);
	});

	it("passes through ordinary input", async () => {
		const calls: object[] = [];
		const handler = async (payload: object) => {
			calls.push(payload);
			return payload;
		};
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);
		await action("get", { entity_id: 7 });
		expect(calls[0]).toEqual({ entity_id: 7, action: "get" });
	});

	it("rejects a named connections call when the handler returns an error result", async () => {
		const failure = {
			error: "Connector 'missing' not found. Install it first.",
			setup_url: "/connections",
		};
		const handler = async () => failure;
		const { manage, action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		const thrown = await action("connect", {
			connector_key: "missing",
		}).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ClientSdkActionError);
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown).toMatchObject({
			message: failure.error,
			httpStatus: 400,
			action: "connect",
			result: failure,
		});

		// `manage` is the deliberately raw escape hatch for callers that need to
		// inspect the handler's complete result shape.
		await expect(manage({ action: "connect" })).resolves.toEqual(failure);
	});

	it("rejects a named classifiers call when success is false", async () => {
		const handler = async () => ({
			success: false,
			action: "create",
			message: "Watcher not found: 404",
			data: { watcher_id: 404 },
		});
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		const thrown = await action("create", {
			watcher_id: 404,
		}).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ClientSdkActionError);
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown).toMatchObject({
			message: "Watcher not found: 404",
			httpStatus: 400,
			action: "create",
		});
	});

	it.each(["failed", "error"] as const)(
		"rejects a named call when status is %s",
		async (status) => {
			const failure = {
				status,
				error_message: `Operation ended with status ${status}`,
			};
			const handler = async () => failure;
			const { action } = createActionCaller(
				handler as never,
				{} as never,
				{} as never,
			);

			await expect(action("execute", {})).rejects.toMatchObject({
				name: "ClientSdkActionError",
				action: "execute",
				message: failure.error_message,
				result: failure,
			});
		},
	);

	it("rejects a named call when status is timeout", async () => {
		const failure = {
			status: "timeout",
			error_message: "Device action run timed out",
		};
		const handler = async () => failure;
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		await expect(action("execute", {})).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "execute",
			message: failure.error_message,
			result: failure,
		});
	});

	it("rejects a named call when every aggregate item failed", async () => {
		const failure = {
			action: "delete",
			results: [
				{
					watcher_id: "missing-watcher",
					success: false,
					message: "Watcher not found or already archived",
				},
			],
			summary: { total: 1, successful: 0, failed: 1 },
		};
		const handler = async () => failure;
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		await expect(action("delete", {})).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "delete",
			message: failure.results[0].message,
			result: failure,
		});
	});

	it("returns a queued approval even when its mutation success is false", async () => {
		const queued = {
			success: false,
			approval_queued: true,
			approval_url: "/memory?run_ids=42",
			approval_run_id: 42,
		};
		const handler = async () => queued;
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		await expect(action("delete", { entity_id: 7 })).resolves.toEqual(queued);
	});
});
