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
 *     agent turn runs deny-all, unlike a connector's open default.
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

beforeAll(async () => {
	guestCode = await agentGuestBundle();
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			hits.push({
				url: req.url ?? "",
				authorization: (req.headers.authorization as string | undefined) ?? null,
				apiKeyHeader: (req.headers["x-api-key"] as string | undefined) ?? null,
				body: Buffer.concat(chunks).toString("utf8"),
			});
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
});
