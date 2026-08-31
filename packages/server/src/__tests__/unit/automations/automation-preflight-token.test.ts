import {
	__resetEncryptionKeyCacheForTests,
	verifyWorkerToken,
	type WorkerTokenData,
} from "@lobu/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightAutomationMemoryTools } from "../../../automations/automation";
import { AUTOMATION_RUN_SOURCE } from "../../../gateway/automation-run-session";

const TEST_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Automation memory preflight token", () => {
	const originalFetch = globalThis.fetch;
	let savedKey: string | undefined;

	beforeEach(() => {
		savedKey = process.env.ENCRYPTION_KEY;
		process.env.ENCRYPTION_KEY = TEST_KEY;
		__resetEncryptionKeyCacheForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
		else process.env.ENCRYPTION_KEY = savedKey;
		__resetEncryptionKeyCacheForTests();
		vi.restoreAllMocks();
	});

	it("stamps the Automation run source on the worker bearer", async () => {
		let claims: WorkerTokenData | null = null;
		globalThis.fetch = vi.fn(async (_input, init) => {
			const authorization = new Headers(init?.headers).get("Authorization");
			expect(authorization).toMatch(/^Bearer /);
			claims = verifyWorkerToken(authorization!.slice("Bearer ".length));
			return Response.json({
				tools: [{ name: "query_sdk" }, { name: "run_sdk" }],
			});
		});

		await expect(
			preflightAutomationMemoryTools({
				organizationId: "org-team",
				agentId: "developer",
				runId: 456,
				executionMode: "capture",
			}),
		).resolves.toEqual({ ok: true });

		expect(claims?.source).toBe(AUTOMATION_RUN_SOURCE);
		expect(claims?.automationRunId).toBe(456);
		expect(claims?.executionMode).toBe("capture");
	});
});
