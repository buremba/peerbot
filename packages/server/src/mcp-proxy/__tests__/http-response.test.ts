import { expect, test } from "vitest";
import {
	assertRequestBodySize,
	boundStreamingResponse,
	createMcpAbortScope,
	getMcpAbortReason,
	inspectMcpJsonRpcBody,
	logMcpTerminalOutcome,
	MCP_REQUEST_BODY_LIMIT,
	MCP_SSE_FRAME_LIMIT,
	McpTransportError,
	isMcpToolCallRequest,
	normalizeMcpAbortError,
	parseJsonRpcResponse,
	readBoundedBody,
	readResponseBody,
	utf8ByteLength,
} from "../http-response";

function streamFrom(chunks: Uint8Array[], waitMs = 0): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
			const chunk = chunks[index++];
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
	});
}

test("counts request bytes, not UTF-16 characters", () => {
	const value = "🙂".repeat(Math.floor(MCP_REQUEST_BODY_LIMIT / 4) + 1);
	expect(utf8ByteLength(value)).toBeGreaterThan(MCP_REQUEST_BODY_LIMIT);
	expect(() => assertRequestBodySize(value)).toThrow(McpTransportError);
	const short = "🙂".repeat(10);
	expect(() => assertRequestBodySize(short)).not.toThrow();
});

test("cancels a slow body after the deadline, including after headers", async () => {
	const scope = createMcpAbortScope({ timeoutMs: 15 });
	await expect(
		readBoundedBody(streamFrom([new TextEncoder().encode("{"), new TextEncoder().encode("}")], 100), 100, {
			signal: scope.signal,
			kind: "response",
		}),
	).rejects.toMatchObject({ kind: "timeout" });
	scope.cleanup();
});

test("does not parse an oversized or malformed JSON response", async () => {
	const oversized = new Response(streamFrom([new TextEncoder().encode("{" + "x".repeat(100) + "}")]), {
		headers: { "content-type": "application/json" },
	});
	await expect(parseJsonRpcResponse(oversized, undefined, { limit: 10 })).rejects.toMatchObject({
		kind: "oversized_response",
	});

	const malformed = new Response("{\"jsonrpc\":", { headers: { "content-type": "application/json" } });
	await expect(parseJsonRpcResponse(malformed)).rejects.toMatchObject({ kind: "malformed_json" });
});

test("bounds SSE frames and cancels the upstream stream on downstream disconnect", async () => {
	const tooLarge = new Response(streamFrom([new TextEncoder().encode(`data: ${"x".repeat(MCP_SSE_FRAME_LIMIT)}\n\n`)]), {
		headers: { "content-type": "text/event-stream" },
	});
	const bounded = boundStreamingResponse(tooLarge, { frameLimit: MCP_SSE_FRAME_LIMIT });
	await expect(bounded.body?.getReader().read()).rejects.toMatchObject({ kind: "oversized_response" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(tooLarge.body?.locked).toBe(false);

	let cancelled = false;
	const scope = createMcpAbortScope({});
	const upstream = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => undefined);
		},
		cancel() {
			cancelled = true;
		},
	});
	const response = boundStreamingResponse(new Response(upstream), {
		signal: scope.signal,
		onCancel: () => scope.abort("caller_abort"),
	});
	await response.body?.cancel("caller disconnected");
	expect(cancelled).toBe(true);
	expect(upstream.locked).toBe(false);
	expect(scope.signal.aborted).toBe(true);
	expect(scope.signal.reason).toMatchObject({ kind: "caller_abort" });
	scope.cleanup();
});

test("resets CRLF-delimited SSE frames and applies downstream backpressure", async () => {
	const crlfFrames = new Response(streamFrom([
		new TextEncoder().encode("data: first\r\n\r\ndata: second\r\n\r\n"),
	]));
	const boundedFrames = boundStreamingResponse(crlfFrames, { frameLimit: 16 });
	expect(new TextDecoder().decode(await boundedFrames.arrayBuffer())).toBe(
		"data: first\r\n\r\ndata: second\r\n\r\n",
	);
	const crOnlyFrames = boundStreamingResponse(new Response(streamFrom([
		new TextEncoder().encode("data: first\r\rdata: second\r\r"),
	])), { frameLimit: 14 });
	expect(new TextDecoder().decode(await crOnlyFrames.arrayBuffer())).toBe(
		"data: first\r\rdata: second\r\r",
	);

	let pulls = 0;
	const upstream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls++;
			if (pulls <= 5) controller.enqueue(new TextEncoder().encode(`data: ${pulls}\n\n`));
			else controller.close();
		},
	});
	const response = boundStreamingResponse(new Response(upstream));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(pulls).toBeLessThan(5);
	await response.body?.cancel();
});

test("settles an empty streaming response", () => {
	let cleanups = 0;
	boundStreamingResponse(new Response(null, { status: 204 }), {
		cleanup: () => cleanups++,
	});
	expect(cleanups).toBe(1);
});

test("distinguishes caller, timeout, and upstream aborts", async () => {
	for (const [field, expected] of [
		["callerSignal", "caller_abort"],
		["upstreamSignal", "upstream_abort"],
	] as const) {
		const controller = new AbortController();
		const scope = createMcpAbortScope({ [field]: controller.signal });
		controller.abort();
		await expect(readBoundedBody(streamFrom([], 50), 100, { signal: scope.signal, kind: "response" })).rejects.toMatchObject({ kind: expected });
		scope.cleanup();
	}
	const timeout = createMcpAbortScope({ timeoutMs: 1 });
	await expect(readBoundedBody(streamFrom([], 20), 100, { signal: timeout.signal, kind: "response" })).rejects.toMatchObject({ kind: "timeout" });
	timeout.cleanup();

	const failedUpstream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("upstream closed"));
		},
	});
	await expect(readBoundedBody(failedUpstream, 100, { kind: "response" })).rejects.toMatchObject({
		kind: "upstream_abort",
	});

	const unscopedAbort = normalizeMcpAbortError(
		new DOMException("upstream closed", "AbortError"),
		new AbortController().signal,
	);
	expect(unscopedAbort).toMatchObject({ kind: "upstream_abort" });
	expect(getMcpAbortReason(unscopedAbort)).toBe("upstream_abort");
	expect(getMcpAbortReason(new Error("ordinary failure"))).toBeNull();
});

test("classifies tool-call telemetry from parsed JSON, never a substring", () => {
	expect(isMcpToolCallRequest('{"jsonrpc":"2.0","method":"tools/call"}')).toBe(true);
	expect(isMcpToolCallRequest('{"method":"tools/call"}')).toBe(false);
	expect(isMcpToolCallRequest('{"jsonrpc":"2.0","result":{"text":"tools/call error"}}')).toBe(false);
	expect(isMcpToolCallRequest('{"jsonrpc":')).toBe(false);
});

test("derives JSON-RPC status only from a complete parsed body", () => {
	const encode = (value: string) => new TextEncoder().encode(value);
	expect(
		inspectMcpJsonRpcBody(
			encode('{"jsonrpc":"2.0","id":1,"result":{"text":"an error occurred"}}'),
			"application/json",
		),
	).toEqual({ status: "success", sessionError: false });
	expect(
		inspectMcpJsonRpcBody(
			encode('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Session not found"}}'),
			"application/json",
		),
	).toEqual({ status: "error", sessionError: true });
	expect(
		inspectMcpJsonRpcBody(
			encode('data: {"jsonrpc":"2.0","id":1,"result":{}}\r\r'),
			"text/event-stream",
		),
	).toEqual({ status: "success", sessionError: false });
	expect(inspectMcpJsonRpcBody(encode('{"jsonrpc":'), "application/json")).toEqual({
		status: "unknown",
		sessionError: false,
	});
	expect(inspectMcpJsonRpcBody(encode('{"error":"invalid_token"}'), "application/json")).toEqual({
		status: "unknown",
		sessionError: false,
	});
	let oversizedFrameError: unknown;
	try {
		inspectMcpJsonRpcBody(
			encode(`data: ${"x".repeat(MCP_SSE_FRAME_LIMIT)}\n\n`),
			"text/event-stream",
		);
	} catch (error) {
		oversizedFrameError = error;
	}
	expect(oversizedFrameError).toMatchObject({
		kind: "oversized_response",
		limit: MCP_SSE_FRAME_LIMIT,
	});
});

test("terminal outcome logging is structured and previews redact secrets", () => {
	const calls: unknown[][] = [];
	logMcpTerminalOutcome({ info: (...args) => calls.push(args) }, {
		call_id: "call-1",
		request_bytes: 12,
		response_bytes: 20,
		request_limit: MCP_REQUEST_BODY_LIMIT,
		response_limit: 100,
		duration_ms: 3,
		http_status: 200,
		jsonrpc_status: "success",
		truncated: false,
		aborted: false,
		abort_reason: null,
		retryable: false,
		ambiguous_execution: false,
		diagnostic_preview: "cookie=secret-cookie password=secret-password Bearer secret-token",
	});
	expect(calls[0]?.[0]).toMatchObject({ call_id: "call-1", response_limit: 100 });
	expect(calls[0]?.[0]).toMatchObject({ diagnostic_preview: "[REDACTED]" });
	for (const secret of ["secret-cookie", "secret-password", "secret-token"]) {
		expect(JSON.stringify(calls[0])).not.toContain(secret);
	}
});

test("diagnostic previews redact form, query, cookie, password, secret, and token values", async () => {
	const body = new TextEncoder().encode(
		"form=FORM-VALUE&query=QUERY-VALUE&cookie=COOKIE-VALUE password=PASSWORD-VALUE secret=SECRET-VALUE access_token=ACCESS-TOKEN refreshToken=REFRESH-TOKEN",
	);
	const bounded = await readBoundedBody(new ReadableStream({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	}), 4096, { kind: "response" });
	expect(bounded.preview).toContain("form=[REDACTED]");
	expect(bounded.preview).toContain("query=[REDACTED]");
	expect(bounded.preview).toContain("cookie=[REDACTED]");
	expect(bounded.preview).toContain("password=[REDACTED]");
	expect(bounded.preview).toContain("secret=[REDACTED]");
	expect(bounded.preview).toContain("access_token=[REDACTED]");
	expect(bounded.preview).toContain("refreshToken=[REDACTED]");
	for (const value of ["FORM-VALUE", "QUERY-VALUE", "COOKIE-VALUE", "PASSWORD-VALUE", "SECRET-VALUE", "ACCESS-TOKEN", "REFRESH-TOKEN"]) {
		expect(bounded.preview).not.toContain(value);
	}

	const headers = await readBoundedBody(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(
				"Authorization: Basic AUTH-VALUE\nSet-Cookie: session=COOKIE-HEADER-VALUE",
			));
			controller.close();
		},
	}), 4096, { kind: "response" });
	expect(headers.preview).toBe(
		"Authorization: [REDACTED]\nCookie: [REDACTED]",
	);
	expect(headers.preview).not.toContain("AUTH-VALUE");
	expect(headers.preview).not.toContain("COOKIE-HEADER-VALUE");

	try {
		assertRequestBodySize(`token=REQUEST-TOKEN ${"x".repeat(MCP_REQUEST_BODY_LIMIT)}`);
		throw new Error("expected oversized request");
	} catch (error) {
		expect(error).toBeInstanceOf(McpTransportError);
		expect((error as McpTransportError).preview).not.toContain("REQUEST-TOKEN");
	}
});

test("preserves public ID mismatch and empty SSE errors", async () => {
	const mismatch = new Response(JSON.stringify({ jsonrpc: "2.0", id: 8, result: {} }), {
		headers: { "content-type": "application/json" },
	});
	await expect(parseJsonRpcResponse(mismatch, 7)).rejects.toEqual(
		new Error("MCP response omitted JSON-RPC id 7"),
	);

	const emptySse = new Response("event: message\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
	await expect(parseJsonRpcResponse(emptySse)).rejects.toEqual(
		new Error("SSE response contained no data payload"),
	);
});
