/**
 * Agent turn on the connector isolate lane, end to end.
 *
 * One conversation turn is one isolate job: `IsolateExecutor` runs Lobu's own
 * agent-session guest bundle exactly the way it runs a connector, so the turn
 * inherits the lane's egress dispatcher, wall clock, memory limit, log budget
 * and terminal-state machine rather than growing a second copy of any of them.
 *
 * What is pinned here:
 *  1. the guest bundle is isolate-eligible — no Node builtin survives the
 *     aliasing, which is the only cheap proof the artifact can load at all;
 *  2. a turn against a provider that streams Server-Sent Events produces the
 *     tokens ON THE HOST WHILE THE STREAM IS OPEN, not in one lump at the end
 *     (what the subprocess lane visibly does, and the reason PR 3 taught
 *     the lane to stream);
 *  3. the transcript comes back with the turn appended, so the next turn can
 *     resume from it;
 *  4. the guest reaches the gateway host it was given and NOTHING else — an
 *     agent turn runs deny-all, unlike a connector's open default;
 *  5. a tool call is one more request to the same gateway, over the same
 *     `fetch`, carrying the same one credential — and the transcript comes
 *     back with the call and its result in it.
 *
 * Runs under Node (vitest); like the other lane suites it FAILS rather than
 * skips when `isolated-vm` cannot load.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { agentGuestBundle } from "@lobu/connector-worker/agent-turn";
import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput } from "@lobu/connector-worker/agent-turn";
import type { ExecutorJob } from "@lobu/connector-worker/executor/interface";
import { IsolateExecutor, type IsolateLogLevel } from "@lobu/connector-worker/executor/isolate";
import { assertIsolateEligible } from "@lobu/connector-worker/isolate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Requests the fake provider has answered. */
interface ProviderHit {
	method: string;
	url: string;
	authorization: string | null;
	apiKeyHeader: string | null;
	body: string;
}

let guestCode: string;
let server: Server;
let port: number;
let hits: ProviderHit[] = [];

/** The gateway's own placeholder for the agent's provider key. */
const GATEWAY_PLACEHOLDER = "lobu_secret_00000000-0000-4000-8000-000000000000";

/**
 * Resolved by the test when the HOST has seen its first token. The fake
 * provider will not finish its response until then, so a lane that buffered the
 * body and only handed the tokens over at the end would deadlock here rather
 * than pass — which is the whole point of streaming the body.
 */
let sawFirstDelta: Promise<void> = Promise.resolve();
let markFirstDelta: () => void = () => undefined;

function armFirstDeltaGate(): void {
	sawFirstDelta = new Promise<void>((resolve) => {
		markFirstDelta = resolve;
	});
}

/** One SSE frame per write, so the guest has to pull the body more than once. */
async function writeAnthropicStream(res: Parameters<Parameters<typeof createServer>[0]>[1], pieces: string[]): Promise<void> {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	send("message_start", {
		type: "message_start",
		message: {
			id: "msg_isolate",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 11, output_tokens: 0 },
		},
	});
	send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	for (const piece of pieces) {
		send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
	}
	await sawFirstDelta;
	send("content_block_stop", { type: "content_block_stop", index: 0 });
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 7 },
	});
	send("message_stop", { type: "message_stop" });
	res.end();
}

/** An assistant turn that calls one tool and stops for its result. */
function writeAnthropicToolUse(
	res: Parameters<Parameters<typeof createServer>[0]>[1],
	call: { id: string; name: string; input: Record<string, unknown> },
): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	send("message_start", {
		type: "message_start",
		message: {
			id: "msg_tool",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 0 },
		},
	});
	send("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
	});
	send("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
	});
	send("content_block_stop", { type: "content_block_stop", index: 0 });
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 3 },
	});
	send("message_stop", { type: "message_stop" });
	res.end();
}

/**
 * The tool the fake gateway serves at its MCP route, and what it answers. The
 * route is the same one the real gateway's MCP proxy mounts.
 */
const TOOL_ROUTE = "/lobu/mcp/lobu-memory/tools/query_sdk";
let toolReply: { status: number; body: unknown } = {
	status: 200,
	body: { content: [{ type: "text", text: "3 entities" }] },
};

beforeAll(async () => {
	guestCode = await agentGuestBundle();
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			hits.push({
				method: req.method ?? "",
				url: req.url ?? "",
				authorization: (req.headers.authorization as string | undefined) ?? null,
				apiKeyHeader: (req.headers["x-api-key"] as string | undefined) ?? null,
				body,
			});
			if (req.url === TOOL_ROUTE) {
				res.writeHead(toolReply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(toolReply.body));
				return;
			}
			// A provider request whose transcript already carries a tool result
			// gets the answer; one whose last message is the human's gets a tool
			// call first — the shape of every tool-using turn.
			const request = JSON.parse(body) as { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> };
			const last = request.messages.at(-1);
			const wantsTool =
				Array.isArray(request.tools) &&
				request.tools.length > 0 &&
				last?.role === "user" &&
				!(Array.isArray(last.content) && last.content.some((b) => (b as { type?: string }).type === "tool_result"));
			if (wantsTool) {
				writeAnthropicToolUse(res, { id: "toolu_01", name: "query_sdk", input: { code: "entities.count()" } });
				return;
			}
			void writeAnthropicStream(res, ["Hello", " from", " the", " isolate"]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function turnJob(input: Partial<AgentTurnInput> = {}, baseUrl?: string): ExecutorJob {
	return {
		mode: "agent_turn",
		turn: {
			provider: {
				api: "anthropic-messages",
				provider: "anthropic",
				modelId: "claude-test",
				baseUrl: baseUrl ?? `http://127.0.0.1:${port}`,
				maxTokens: 64,
			},
			systemPrompt: "You are a test agent.",
			messages: [],
			userMessage: "hi",
			...input,
		},
		config: {},
		// What the gateway hands the subprocess lane today: its own placeholder,
		// resolved by the secret-proxy, never a real key. The host mints a vault
		// placeholder over it, so this exact string must still arrive upstream.
		credentials: { provider: "anthropic", accessToken: GATEWAY_PLACEHOLDER },
		sessionState: null,
		env: {},
	};
}

interface TurnRun {
	events: AgentTurnEvent[];
	logs: { level: IsolateLogLevel; line: string }[];
	output: AgentTurnOutput;
}

async function runTurn(job: ExecutorJob, allowedDomains: readonly string[] = ["127.0.0.1"]): Promise<TurnRun> {
	const events: AgentTurnEvent[] = [];
	const logs: { level: IsolateLogLevel; line: string }[] = [];
	const executor = new IsolateExecutor({
		timeoutMs: 60_000,
		allowedDomains,
		logSink: (level, line) => logs.push({ level, line }),
	});
	const result = await executor.execute(guestCode, job, {
		onTurnEvent: (event) => {
			events.push(event);
			if (event.type === "text_delta") markFirstDelta();
		},
	});
	if (result.mode !== "agent_turn") throw new Error(`expected an agent_turn result, got ${result.mode}`);
	return { events, logs, output: result.turn };
}

/** A turn the lane refused, with the run log that says why. */
async function failTurn(
	job: ExecutorJob,
	allowedDomains: readonly string[],
): Promise<{ error: Error; logs: { level: IsolateLogLevel; line: string }[] }> {
	const logs: { level: IsolateLogLevel; line: string }[] = [];
	const executor = new IsolateExecutor({
		timeoutMs: 60_000,
		allowedDomains,
		logSink: (level, line) => logs.push({ level, line }),
	});
	const error = await executor.execute(guestCode, job, {}).then(
		() => null,
		(caught: unknown) => caught as Error,
	);
	if (!error) throw new Error("expected the agent turn to fail");
	return { error, logs };
}

describe("agent turn on the isolate lane", () => {
	it("bundles the agent guest with no Node builtin left in it", () => {
		expect(guestCode.length).toBeGreaterThan(1_000_000);
		expect(() => assertIsolateEligible(guestCode)).not.toThrow();
	});

	it("streams a turn: deltas reach the host while the response is still open", async () => {
		hits = [];
		armFirstDeltaGate();
		const run = await runTurn(turnJob());

		expect(run.output.text).toBe("Hello from the isolate");
		expect(run.output.stopReason).toBe("stop");
		expect(run.output.usage).toEqual({ input: 11, output: 7 });

		const deltas = run.events.filter((e) => e.type === "text_delta");
		expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual(["Hello", " from", " the", " isolate"]);
		expect(run.events.at(-1)).toEqual({ type: "message_end" });

		// The response the deltas came from is the only request made, and the
		// guest never saw a real key: it sent the gateway's placeholder.
		expect(hits.length).toBe(1);
		expect(hits[0]?.url).toBe("/v1/messages");
		expect(hits[0]?.apiKeyHeader).toBe(GATEWAY_PLACEHOLDER);
		expect(JSON.parse(hits[0]?.body ?? "{}")).toMatchObject({ model: "claude-test", system: expect.anything() });
	}, 120_000);

	it("returns the transcript with the turn appended so the next turn resumes from it", async () => {
		hits = [];
		armFirstDeltaGate();
		const first = await runTurn(turnJob());
		armFirstDeltaGate();
		expect(first.output.messages.length).toBeGreaterThanOrEqual(2);
		expect(first.output.messages[0]).toMatchObject({ role: "user" });
		expect(first.output.messages.at(-1)).toMatchObject({ role: "assistant" });

		// pi prices every assistant entry off the model's four cost keys. A model
		// missing one puts NaN there, which JSON turns to null on the way to the
		// run row — so the entry must be finite before it is ever persisted.
		const priced = first.output.messages.at(-1) as {
			usage?: { cost?: Record<string, number> };
		};
		expect(Object.values(priced.usage?.cost ?? {}).every(Number.isFinite)).toBe(true);

		const second = await runTurn(turnJob({ messages: first.output.messages, userMessage: "and again" }));
		expect(second.output.messages.length).toBe(first.output.messages.length + 2);
		const sent = JSON.parse(hits.at(-1)?.body ?? "{}") as { messages: unknown[] };
		expect(sent.messages.length).toBe(3);
	}, 120_000);

	it("runs deny-all: a turn cannot reach a host outside its allowlist", async () => {
		hits = [];
		const { error, logs } = await failTurn(turnJob(), ["gateway.invalid"]);

		// The provider SDK reports every transport failure as one masked
		// message, so the refusal is only legible in the run log — which is
		// exactly where an operator looks, and why the lane logs it there.
		expect(error.message).toBe("Connection error.");
		expect(logs).toContainEqual({
			level: "warn",
			line: "egress denied: fetch to 127.0.0.1 is not permitted (this run may reach: gateway.invalid)",
		});
		expect(hits.length).toBe(0);
	}, 120_000);

	it("conceals the gateway's own credential from the guest and audits the spend", async () => {
		hits = [];
		armFirstDeltaGate();
		const run = await runTurn(turnJob());

		// Upstream got the gateway's placeholder, so the secret-proxy can still
		// resolve it...
		expect(hits[0]?.apiKeyHeader).toBe(GATEWAY_PLACEHOLDER);
		// ...but what the guest held was a different, per-run placeholder, and the
		// host recorded spending it. Same audit line a connector's OAuth token gets.
		const spends = run.logs.filter((l) => l.line.startsWith("credential "));
		expect(spends).toHaveLength(1);
		expect(spends[0]?.line).toMatch(/^credential [0-9a-f]{12} spent on 127\.0\.0\.1 in header x-api-key$/);
		expect(spends[0]?.line).not.toContain(GATEWAY_PLACEHOLDER.slice(-12));
	}, 120_000);

	function toolJob(overrides: Partial<AgentTurnInput> = {}): ExecutorJob {
		return turnJob({
			tools: {
				gatewayUrl: `http://127.0.0.1:${port}/lobu`,
				definitions: [
					{
						mcpId: "lobu-memory",
						name: "query_sdk",
						description: "Read workspace data",
						inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
					},
				],
			},
			...overrides,
		});
	}

	it("calls a tool through the gateway's MCP route with the same one credential, and resumes from the result", async () => {
		hits = [];
		toolReply = { status: 200, body: { content: [{ type: "text", text: "3 entities" }] } };
		armFirstDeltaGate();
		const run = await runTurn(toolJob());

		expect(run.output.text).toBe("Hello from the isolate");
		expect(run.output.stopReason).toBe("stop");
		// Two provider calls around one tool call: usage is the turn's total.
		expect(run.output.usage).toEqual({ input: 16, output: 10 });

		expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual([
			"POST /v1/messages",
			"POST /lobu/mcp/lobu-memory/tools/query_sdk",
			"POST /v1/messages",
		]);
		// The model was offered the tool with the schema the gateway published...
		const offered = JSON.parse(hits[0]?.body ?? "{}") as { tools?: Array<{ name: string; input_schema: unknown }> };
		expect(offered.tools).toEqual([
			expect.objectContaining({
				name: "query_sdk",
				input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
			}),
		]);
		// ...the tool call carried the model's arguments and the SAME credential
		// the provider call did, resolved by the host into the bearer header...
		expect(hits[1]?.body).toBe(JSON.stringify({ code: "entities.count()" }));
		expect(hits[1]?.authorization).toBe(`Bearer ${GATEWAY_PLACEHOLDER}`);
		expect(hits[1]?.apiKeyHeader).toBeNull();
		// ...and the second provider call resumed from the tool result.
		const resumed = JSON.parse(hits[2]?.body ?? "{}") as { messages: Array<{ role: string; content: unknown }> };
		expect(resumed.messages.at(-1)).toMatchObject({
			role: "user",
			content: [expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_01", content: "3 entities" })],
		});

		// The host saw the call as it happened, in order, with its outcome.
		const toolEvents = run.events.filter((e) => e.type === "tool_call_start" || e.type === "tool_call_end");
		expect(toolEvents).toEqual([
			{ type: "tool_call_start", toolCallId: "toolu_01", name: "query_sdk", args: { code: "entities.count()" } },
			{ type: "tool_call_end", toolCallId: "toolu_01", name: "query_sdk", isError: false, output: "3 entities" },
		]);

		// The transcript the next turn resumes from carries the call and its result.
		const roles = run.output.messages.map((m) => (m as { role: string }).role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(run.output.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "toolu_01", toolName: "query_sdk", isError: false });

		// One credential, one host: the audit line is written once per
		// (placeholder, host), so the tool call adds no second line — the bearer
		// hit above is the evidence it was spent there too.
		const spends = run.logs.filter((l) => l.line.startsWith("credential ")).map((l) => l.line.replace(/^credential [0-9a-f]{12} /, ""));
		expect(spends).toEqual(["spent on 127.0.0.1 in header x-api-key"]);
	}, 120_000);

	it("hands a refused tool call to the model as an error result and lets the turn finish", async () => {
		hits = [];
		// What the gateway answers when the agent's policy gates the tool behind
		// an approval: a 403 with the text the subprocess lane's plugin shows.
		toolReply = {
			status: 403,
			body: { content: [{ type: "text", text: "Tool call requires approval. The user has been asked to approve." }], isError: true },
		};
		armFirstDeltaGate();
		const run = await runTurn(toolJob());

		expect(run.output.text).toBe("Hello from the isolate");
		const end = run.events.find((e) => e.type === "tool_call_end") as { isError: boolean; output: string } | undefined;
		expect(end?.isError).toBe(true);
		expect(end?.output).toContain("Tool call requires approval");
		const resumed = JSON.parse(hits[2]?.body ?? "{}") as { messages: Array<{ content: unknown }> };
		expect(resumed.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ type: "tool_result", is_error: true })],
		});
	}, 120_000);
});
