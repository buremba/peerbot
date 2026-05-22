import { describe, expect, test } from "bun:test";
import { ConnectorRuntime } from "../connector-runtime.js";
import { defineConnector } from "../define-connector.js";

// Mirrors connector-worker/src/executor/child-runner.ts `findRuntimeClass`: a
// connector is detected by a constructor whose prototype has sync() + execute().
// If this passes, an esbuild-bundled `export default defineConnector(...)` is
// picked up by the worker unchanged.
function isConnectorRuntimeClass(val: unknown): boolean {
	return (
		typeof val === "function" &&
		!!(val as { prototype?: { sync?: unknown } }).prototype?.sync &&
		!!(val as { prototype?: { execute?: unknown } }).prototype?.execute
	);
}

const Github = defineConnector({
	key: "github",
	name: "GitHub",
	version: "1.0.0",
	feeds: {
		stars: {
			name: "Stars",
			sync: async (ctx) => ({
				events: [
					{
						origin_id: ctx.feedKey,
						payload_text: "star",
						occurred_at: new Date(),
					},
				],
				checkpoint: { seen: 1 },
			}),
		},
	},
	actions: {
		star_repo: {
			name: "Star repo",
			execute: async (ctx) => ({
				success: true,
				output: { repo: ctx.input.repo },
			}),
		},
	},
});

describe("defineConnector", () => {
	test("returns a ConnectorRuntime subclass the worker can detect", () => {
		expect(isConnectorRuntimeClass(Github)).toBe(true);
		expect(new Github()).toBeInstanceOf(ConnectorRuntime);
	});

	test("lowers the spec to a ConnectorDefinition with keys from the record keys", () => {
		const { definition } = new Github();
		expect(definition.key).toBe("github");
		expect(definition.version).toBe("1.0.0");
		expect(definition.feeds?.stars?.key).toBe("stars");
		expect(definition.feeds?.stars?.name).toBe("Stars");
		expect(definition.actions?.star_repo?.key).toBe("star_repo");
		// requiresApproval defaults to false
		expect(definition.actions?.star_repo?.requiresApproval).toBe(false);
		// handler closures must NOT leak into the serializable definition
		expect(
			(definition.feeds?.stars as Record<string, unknown>).sync,
		).toBeUndefined();
		expect(
			(definition.actions?.star_repo as Record<string, unknown>).execute,
		).toBeUndefined();
	});

	test("sync dispatches to the matching feed handler", async () => {
		const res = await new Github().sync({
			feedKey: "stars",
			config: {},
			checkpoint: null,
			credentials: null,
			entityIds: [],
		});
		expect(res.events).toHaveLength(1);
		expect(res.checkpoint).toEqual({ seen: 1 });
	});

	test("sync throws for an unknown feed", async () => {
		await expect(
			new Github().sync({
				feedKey: "nope",
				config: {},
				checkpoint: null,
				credentials: null,
				entityIds: [],
			}),
		).rejects.toThrow(/no sync handler for feed 'nope'/);
	});

	test("execute dispatches to the matching action handler", async () => {
		const res = await new Github().execute({
			actionKey: "star_repo",
			input: { repo: "lobu-ai/lobu" },
			credentials: null,
			config: {},
		});
		expect(res).toEqual({ success: true, output: { repo: "lobu-ai/lobu" } });
	});

	test("execute returns an error result for an unknown action", async () => {
		const res = await new Github().execute({
			actionKey: "nope",
			input: {},
			credentials: null,
			config: {},
		});
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/no action handler/);
	});

	test("a feeds-only connector still satisfies the worker contract", () => {
		const ReadOnly = defineConnector({
			key: "ro",
			name: "ReadOnly",
			version: "0.0.1",
			feeds: {
				items: {
					name: "Items",
					sync: async () => ({ events: [], checkpoint: null }),
				},
			},
		});
		expect(isConnectorRuntimeClass(ReadOnly)).toBe(true);
		expect(new ReadOnly().definition.actions).toBeUndefined();
	});

	const authCtx = () => ({
		config: {},
		previousCredentials: null,
		emit: async () => {},
		awaitSignal: async () => ({}),
		signal: new AbortController().signal,
	});

	test("authenticate dispatches to the spec handler when provided", async () => {
		const WithAuth = defineConnector({
			key: "wa",
			name: "WithAuth",
			version: "0.0.1",
			feeds: {
				f: { name: "F", sync: async () => ({ events: [], checkpoint: null }) },
			},
			authenticate: async () => ({ credentials: { token: "t" } }),
		});
		await expect(new WithAuth().authenticate(authCtx())).resolves.toEqual({
			credentials: { token: "t" },
		});
	});

	test("authenticate throws by default when no handler is provided", () => {
		expect(new Github().authenticate(authCtx())).rejects.toThrow(
			/interactive authentication/,
		);
	});
});
