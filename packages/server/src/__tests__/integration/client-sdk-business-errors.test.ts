import { beforeAll, describe, expect, it } from "vitest";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
import { runScript, safeErrorDetails } from "../../sandbox/run-script";
import { cleanupTestDatabase } from "../setup/test-db";
import { TestWorkspace } from "../setup/test-mcp-client";

describe("ClientSDK business failure boundary", () => {
	let workspace: TestWorkspace;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({
			name: "ClientSDK Business Failure Org",
		});
	});

	it("throws when connections.connect returns an error result", async () => {
		const promise = workspace.owner.connections.connect({
			connector_key: "missing-client-sdk-connector",
		});

		const error = await promise.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect(error).toMatchObject({
			name: "ClientSdkActionError",
			action: "connect",
			httpStatus: 400,
		});
	});

	it("preserves structured action details through the run_sdk sandbox boundary", async () => {
		const result = await runScript({
			source: `export default async (_ctx, client) => {
				return client.connections.connect({ connector_key: "missing-client-sdk-connector" });
			}`,
			sdk: workspace.owner,
			sdkMode: "full",
			maxAccessLevel: "admin",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatchObject({
			name: "ClientSdkActionError",
			message: expect.stringMatching(/connector.*not found/i),
			details: {
				error: expect.stringMatching(/connector.*not found/i),
			},
		});
		expect(result.error?.message).not.toContain('{"');
	});

	it("redacts secrets and bounds structured error details", () => {
		expect(
			safeErrorDetails({
				error: "Provider rejected the request",
				token: "must-not-cross-the-sandbox",
				nested: { authorization: "Bearer secret", retryable: true },
			})
		).toEqual({
			error: "Provider rejected the request",
			token: "[redacted]",
			nested: { authorization: "[redacted]", retryable: true },
		});
		expect(safeErrorDetails({ payload: "x".repeat(20_000) })).toMatchObject({
			truncated: true,
		});
	});

	it("does not throw on BigInt or circular structured error details", () => {
		const circular: Record<string, unknown> = {
			requestId: 42n,
			token: "circular-secret",
		};
		circular.self = circular;

		const details = safeErrorDetails(circular);
		expect(details).toEqual({
			requestId: "42",
			token: "[redacted]",
			self: "[circular]",
		});
		expect(
			Buffer.byteLength(JSON.stringify(details), "utf8")
		).toBeLessThanOrEqual(16_384);
	});

	it("throws when classifiers.create returns success false", async () => {
		const stubEmbedding = Array.from({ length: 768 }, () => 0);
		const promise = workspace.owner.classifiers.create({
			slug: "missing-watcher-classifier",
			name: "Missing Watcher Classifier",
			attribute_key: "sentiment",
			watcher_id: 999_999,
			attribute_values: {
				positive: {
					description: "positive sentiment",
					examples: ["great"],
					embedding: stubEmbedding,
				},
			},
		});

		await expect(promise).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "create",
			message: "Watcher not found: 999999",
			httpStatus: 400,
		});
	});

	it("throws when watchers.delete returns an all-failed aggregate", async () => {
		await expect(
			workspace.owner.behaviors.delete({ watcher_ids: ["999999"] })
		).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "delete",
			message: "Watcher not found or already archived",
			httpStatus: 400,
		});
	});
});
