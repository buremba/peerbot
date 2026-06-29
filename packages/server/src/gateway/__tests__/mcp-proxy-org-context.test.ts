import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { encrypt, type WorkerTokenData } from "@lobu/core";
import { McpProxy } from "../auth/mcp/proxy.js";

function createWorkerToken(data: Omit<WorkerTokenData, "timestamp">): string {
	return encrypt(JSON.stringify({ ...data, timestamp: Date.now() }));
}

describe("McpProxy org context", () => {
	const originalFetch = globalThis.fetch;
	const originalEncryptionKey = process.env.ENCRYPTION_KEY;

	beforeAll(() => {
		process.env.ENCRYPTION_KEY =
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterAll(() => {
		if (originalEncryptionKey === undefined) {
			delete process.env.ENCRYPTION_KEY;
		} else {
			process.env.ENCRYPTION_KEY = originalEncryptionKey;
		}
	});

	test("REST tool calls without token organization fail before upstream access", async () => {
		const mcpId = "rest-missing-org-mcp";
		const token = createWorkerToken({
			userId: "user-rest-missing-org",
			conversationId: "conv-rest-missing-org",
			deploymentName: "deploy-rest-missing-org",
			channelId: "ch-rest-missing-org",
			agentId: "agent-rest-missing-org",
		});
		const proxy = new McpProxy(
			{
				getHttpServer: async () => {
					throw new Error("config lookup should not happen");
				},
				getAllHttpServers: async () => new Map(),
			},
			{},
		);

		let upstreamCalled = false;
		globalThis.fetch = async () => {
			upstreamCalled = true;
			throw new Error("upstream should not be called");
		};

		const res = await proxy.getApp().request(`/${mcpId}/tools/my_tool`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ arg1: "value1" }),
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: "Worker token missing organizationId",
		});
		expect(upstreamCalled).toBe(false);
	});

	test("JSON-RPC proxy calls without token organization fail before upstream access", async () => {
		const mcpId = "proxy-missing-org-mcp";
		const token = createWorkerToken({
			userId: "user-proxy-missing-org",
			conversationId: "conv-proxy-missing-org",
			deploymentName: "deploy-proxy-missing-org",
			channelId: "ch-proxy-missing-org",
			agentId: "agent-proxy-missing-org",
		});
		const proxy = new McpProxy(
			{
				getHttpServer: async () => {
					throw new Error("config lookup should not happen");
				},
				getAllHttpServers: async () => new Map(),
			},
			{},
		);

		let upstreamCalled = false;
		globalThis.fetch = async () => {
			upstreamCalled = true;
			throw new Error("upstream should not be called");
		};

		const res = await proxy.getApp().request(`/${mcpId}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "my_tool", arguments: { arg1: "value1" } },
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "Worker token missing organizationId",
			},
		});
		expect(upstreamCalled).toBe(false);
	});
});
