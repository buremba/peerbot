import { beforeAll, describe, expect, it } from "vitest";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
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
			workspace.owner.watchers.delete({ watcher_ids: ["999999"] }),
		).rejects.toMatchObject({
			name: "ClientSdkActionError",
			action: "delete",
			message: "Watcher not found or already archived",
			httpStatus: 400,
		});
	});
});
