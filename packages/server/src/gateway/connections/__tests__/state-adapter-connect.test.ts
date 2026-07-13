/**
 * Regression: chat-instance-manager builds fresh state adapters for
 * removeConnection history cleanup (and other off-instance paths). Those
 * adapters must be connected — otherwise the first store op throws
 * "LobuStateAdapter is not connected" and BYO chat delete aborts before
 * soft-deleting the connection row.
 *
 * Requires DATABASE_URL (constructor eagerly binds getDb()).
 */
import { describe, expect, test } from "bun:test";
import {
	createConnectedGatewayStateAdapter,
	createGatewayStateAdapter,
} from "../state-adapter.js";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("createGatewayStateAdapter", () => {
	test.skipIf(!hasDb)(
		"unconnected adapter rejects store ops with a clear error",
		async () => {
			const adapter = createGatewayStateAdapter();
			await expect(adapter.get("any-key")).rejects.toThrow(
				/LobuStateAdapter is not connected/,
			);
		},
	);
});

describe("createConnectedGatewayStateAdapter", () => {
	test.skipIf(!hasDb)(
		"connects so store ops no longer fail on the connect gate",
		async () => {
			const adapter = await createConnectedGatewayStateAdapter();
			// get on a missing key returns null — proves ensureConnected passed.
			await expect(
				adapter.get("missing-key-after-connect"),
			).resolves.toBeNull();
			await adapter.disconnect();
		},
	);
});
