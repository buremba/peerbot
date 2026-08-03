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
			message: "Behavior not found: 404",
			data: { behavior_id: 404 },
		});
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
		);

		const thrown = await action("create", {
			behavior_id: 404,
		}).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ClientSdkActionError);
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown).toMatchObject({
			message: "Behavior not found: 404",
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
					behavior_id: "missing-behavior",
					success: false,
					message: "Behavior not found or already archived",
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

	it("rewrites an internal manage_* validation error to the public SDK method", async () => {
		// A client.feeds.get({ id: 1 }) whose internal handler (manage_feeds)
		// rejects the args must NOT leak `manage_feeds` — the caller can only
		// recover against `client.feeds.get`.
		const handler = async () => {
			throw new ToolUserError(
				"Invalid arguments for manage_feeds: /feed_id: Expected required property",
			);
		};
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
			"feeds",
		);
		const thrown = (await action("read_feed", { id: 1 }, "get").catch(
			(e: unknown) => e,
		)) as ToolUserError;
		expect(thrown).toBeInstanceOf(ToolUserError);
		expect(thrown.message).not.toMatch(/manage_feeds/);
		expect(thrown.message).toMatch(/client\.feeds\.get/);
		expect(thrown.message).toMatch(/feed_id/);
	});

	it("derives a CAMEL-CASE public method from a snake_case action when none is supplied", async () => {
		// `generate_embeddings` (internal) → the real method is
		// client.classifiers.generateEmbeddings, NOT ...generate_embeddings.
		const handler = async () => {
			throw new ToolUserError(
				"Invalid arguments for manage_classifiers: /entity_type: Expected required property",
			);
		};
		const { action } = createActionCaller(
			handler as never,
			{} as never,
			{} as never,
			"classifiers",
		);
		const thrown = (await action("generate_embeddings", {}).catch(
			(e: unknown) => e,
		)) as ToolUserError;
		expect(thrown.message).not.toMatch(/manage_classifiers/);
		expect(thrown.message).not.toMatch(/generate_embeddings/);
		expect(thrown.message).toMatch(/client\.classifiers\.generateEmbeddings/);
	});

	it("leaves errors from callers with no declared namespace untouched", async () => {
		const handler = async () => {
			throw new ToolUserError("Invalid arguments for manage_feeds: boom");
		};
		const { action } = createActionCaller(handler as never, {} as never, {} as never);
		const thrown = (await action("read_feed", {}).catch((e: unknown) => e)) as ToolUserError;
		// No namespace → nothing to rewrite to; message passes through.
		expect(thrown.message).toBe("Invalid arguments for manage_feeds: boom");
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
