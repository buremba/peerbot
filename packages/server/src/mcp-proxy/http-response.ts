import { randomUUID } from "node:crypto";

export const MCP_REQUEST_BODY_LIMIT = 1024 * 1024;
export const MCP_RESPONSE_BODY_LIMIT = 4 * 1024 * 1024;
export const MCP_SSE_FRAME_LIMIT = 1024 * 1024;
export const MCP_DIAGNOSTIC_PREVIEW_LIMIT = 4096;

export type McpAbortReason = "timeout" | "caller_abort" | "upstream_abort";

export class McpTransportError extends Error {
	readonly kind:
		| "timeout"
		| "caller_abort"
		| "upstream_abort"
		| "oversized_request"
		| "oversized_response"
		| "malformed_json";
	readonly bytes?: number;
	readonly limit?: number;
	readonly preview?: string;

	constructor(
		kind: McpTransportError["kind"],
		message: string,
		options: { bytes?: number; limit?: number; preview?: string; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "McpTransportError";
		this.kind = kind;
		this.bytes = options.bytes;
		this.limit = options.limit;
		this.preview = options.preview;
	}
}

export interface McpAbortScope {
	signal: AbortSignal;
	abort: (reason: McpAbortReason) => void;
	cleanup: () => void;
}

/** Compose signals without retaining listeners after the request completes. */
export function createMcpAbortScope(options: {
	timeoutMs?: number;
	callerSignal?: AbortSignal;
	upstreamSignal?: AbortSignal;
}): McpAbortScope {
	const controller = new AbortController();
	const listeners: Array<() => void> = [];

	const abort = (reason: McpAbortReason) => {
		if (controller.signal.aborted) return;
		controller.abort(new McpTransportError(reason, `MCP request ${reason}`));
	};
	const bind = (signal: AbortSignal | undefined, reason: McpAbortReason) => {
		if (!signal) return;
		const listener = () => abort(reason);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push(() => signal.removeEventListener("abort", listener));
		if (signal.aborted) listener();
	};

	bind(options.callerSignal, "caller_abort");
	bind(options.upstreamSignal, "upstream_abort");
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs !== undefined) timer = setTimeout(() => abort("timeout"), options.timeoutMs);

	return {
		signal: controller.signal,
		abort,
		cleanup: () => {
			if (timer) clearTimeout(timer);
			for (const remove of listeners) remove();
		},
	};
}

function previewText(bytes: Uint8Array): string {
	return new TextDecoder()
		.decode(bytes.subarray(0, MCP_DIAGNOSTIC_PREVIEW_LIMIT))
		.replace(/\bAuthorization\s*:\s*[^\r\n]*/gi, "Authorization: [REDACTED]")
		.replace(/\b(?:Set-)?Cookie\s*:\s*[^\r\n]*/gi, "Cookie: [REDACTED]")
		.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
		.replace(/(([\w.-]*(?:form|query|cookie|password|secret|token|authorization|api[_-]?key|session)[\w.-]*)\s*[=:]\s*)([^&\s,;"']+)/gi, "$1[REDACTED]")
		.replace(/("[^"]*(?:form|query|cookie|password|secret|token|authorization|api[_-]?key|session)[^"]*"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
		.slice(0, MCP_DIAGNOSTIC_PREVIEW_LIMIT);
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
	const result = new Uint8Array(Math.min(length, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= result.byteLength) break;
		const copyLength = Math.min(chunk.byteLength, result.byteLength - offset);
		result.set(chunk.subarray(0, copyLength), offset);
		offset += copyLength;
	}
	return result;
}

function abortError(signal: AbortSignal, cause?: unknown): McpTransportError {
	const reason = signal.reason;
	const kind: McpAbortReason =
		reason instanceof McpTransportError &&
		(reason.kind === "timeout" || reason.kind === "caller_abort" || reason.kind === "upstream_abort")
			? reason.kind
			: "upstream_abort";
	return new McpTransportError(kind, `MCP request ${kind}`, { cause });
}

export function normalizeMcpAbortError(error: unknown, signal: AbortSignal): unknown {
	if (signal.aborted) return abortError(signal, error);
	if (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || (error as Error & { code?: unknown }).code === "ABORT_ERR"))
	) {
		return new McpTransportError("upstream_abort", "MCP request upstream_abort", { cause: error });
	}
	return error;
}

export function getMcpAbortReason(
	error: unknown,
	signal?: AbortSignal,
): McpAbortReason | null {
	const transportError =
		error instanceof McpTransportError
			? error
			: signal?.reason instanceof McpTransportError
				? signal.reason
				: undefined;
	return transportError &&
		(transportError.kind === "timeout" ||
			transportError.kind === "caller_abort" ||
			transportError.kind === "upstream_abort")
		? transportError.kind
		: null;
}

export interface BoundedBody {
	bytes: Uint8Array;
	byteLength: number;
	preview: string;
}

/** Read a body by UTF-8 byte count and cancel the source when the limit is exceeded. */
export async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	options: { signal?: AbortSignal; kind?: "request" | "response" } = {},
): Promise<BoundedBody> {
	if (options.signal?.aborted) throw abortError(options.signal);
	if (!body) return { bytes: new Uint8Array(), byteLength: 0, preview: "" };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const onAbort = () => {
		void reader.cancel(options.signal?.reason).catch(() => undefined);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			if (options.signal?.aborted) throw abortError(options.signal);
			const { done, value } = await reader.read();
			if (options.signal?.aborted) throw abortError(options.signal);
			if (done) break;
			if (total + value.byteLength > limit) {
				await reader.cancel("MCP body limit exceeded").catch(() => undefined);
				throw new McpTransportError(
					options.kind === "request" ? "oversized_request" : "oversized_response",
					`MCP ${options.kind ?? "response"} body exceeds ${limit} bytes`,
					{ bytes: total + value.byteLength, limit, preview: previewText(concat([...chunks, value], limit)) },
				);
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} catch (error) {
		const progress = {
			bytes: total,
			preview: previewText(concat(chunks, total)),
		};
		if (options.signal?.aborted) {
			const normalized = abortError(options.signal, error);
			throw new McpTransportError(normalized.kind, normalized.message, {
				...progress,
				cause: error,
			});
		}
		if (!(error instanceof McpTransportError)) {
			const reason: McpAbortReason = options.kind === "request" ? "caller_abort" : "upstream_abort";
			throw new McpTransportError(reason, `MCP request ${reason}`, {
				...progress,
				cause: error,
			});
		}
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	const bytes = concat(chunks, total);
	return { bytes, byteLength: bytes.byteLength, preview: previewText(bytes) };
}

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function assertRequestBodySize(body: string, limit = MCP_REQUEST_BODY_LIMIT): void {
	const encoded = new TextEncoder().encode(body);
	const bytes = encoded.byteLength;
	if (bytes > limit) {
		throw new McpTransportError("oversized_request", `MCP request body exceeds ${limit} bytes`, {
			bytes,
			limit,
			preview: previewText(encoded),
		});
	}
}

/** Only protocol setup/catalog requests are safe to replay after an ambiguous 404. */
export function isReplaySafeMcpRequest(body: string): boolean {
	try {
		const parsed = JSON.parse(body) as { jsonrpc?: unknown; method?: unknown };
		return (
			!Array.isArray(parsed) &&
			parsed?.jsonrpc === "2.0" &&
			(parsed.method === "initialize" ||
				parsed.method === "notifications/initialized" ||
				parsed.method === "tools/list")
		);
	} catch {
		return false;
	}
}

export function isMcpToolCallRequest(body: string): boolean {
	try {
		const parsed = JSON.parse(body) as { jsonrpc?: unknown; method?: unknown };
		return !Array.isArray(parsed) && parsed?.jsonrpc === "2.0" && parsed.method === "tools/call";
	} catch {
		return false;
	}
}

export function isMcpSessionError(message: unknown): boolean {
	return typeof message === "string" && /not initialized|session not found/i.test(message);
}

export async function readResponseBody(
	response: Response,
	options: { signal?: AbortSignal; limit?: number } = {},
): Promise<BoundedBody> {
	return readBoundedBody(response.body, options.limit ?? MCP_RESPONSE_BODY_LIMIT, {
		signal: options.signal,
		kind: "response",
	});
}

class McpSseFrameCounter {
	private frameBytes = 0;
	private lineBytes = 0;
	private previousWasCr = false;
	private previousCrEndedFrame = false;

	constructor(private readonly limit: number) {}

	consume(bytes: Uint8Array): void {
		for (const byte of bytes) {
			this.frameBytes++;
			if (this.frameBytes > this.limit) {
				throw new McpTransportError("oversized_response", "MCP SSE frame exceeds limit", {
					bytes: this.frameBytes,
					limit: this.limit,
				});
			}

			if (byte === 13) {
				const endedFrame = this.lineBytes === 0;
				this.lineBytes = 0;
				this.previousWasCr = true;
				this.previousCrEndedFrame = endedFrame;
				if (endedFrame) this.frameBytes = 0;
				continue;
			}

			if (byte === 10) {
				if (this.previousWasCr) {
					if (this.previousCrEndedFrame) this.frameBytes = 0;
				} else {
					if (this.lineBytes === 0) this.frameBytes = 0;
					this.lineBytes = 0;
				}
				this.previousWasCr = false;
				this.previousCrEndedFrame = false;
				continue;
			}

			this.previousWasCr = false;
			this.previousCrEndedFrame = false;
			this.lineBytes++;
		}
	}
}

export interface McpJsonRpcInspection {
	status: "success" | "error" | "unknown";
	sessionError: boolean;
}

/** Inspect only a complete bounded body; malformed or non-JSON bodies remain unknown. */
export function inspectMcpJsonRpcBody(
	bytes: Uint8Array,
	contentType: string | null,
): McpJsonRpcInspection {
	try {
		const text = new TextDecoder().decode(bytes);
		let values: unknown[];
		if ((contentType ?? "").toLowerCase().includes("text/event-stream")) {
			new McpSseFrameCounter(MCP_SSE_FRAME_LIMIT).consume(bytes);
			const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			values = normalizedText
				.split("\n\n")
				.map((frame) =>
					frame
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n"),
				)
				.filter(Boolean)
				.map((data) => JSON.parse(data));
		} else {
			values = [JSON.parse(text)];
		}

		const messages = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
		let sawSuccess = false;
		let sawError = false;
		let sessionError = false;
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			if ((message as { jsonrpc?: unknown }).jsonrpc !== "2.0") continue;
			if (Object.hasOwn(message, "error")) {
				sawError = true;
				const error = (message as { error?: unknown }).error;
				if (error && typeof error === "object") {
					sessionError ||= isMcpSessionError((error as { message?: unknown }).message);
				}
			} else if (Object.hasOwn(message, "result")) {
				sawSuccess = true;
			}
		}
		return {
			status: sawError ? "error" : sawSuccess ? "success" : "unknown",
			sessionError,
		};
	} catch (error) {
		if (error instanceof McpTransportError) throw error;
		return { status: "unknown", sessionError: false };
	}
}

/** Bound long-lived SSE/raw responses without buffering them. */
export function boundStreamingResponse(
	response: Response,
	options: { signal?: AbortSignal; frameLimit?: number; cleanup?: (error?: unknown, bytes?: number) => void; onCancel?: () => void } = {},
): Response {
	if (!response.body) {
		options.cleanup?.(undefined, 0);
		return response;
	}
	const upstreamReader = response.body.getReader();
	const frameLimit = options.frameLimit ?? MCP_SSE_FRAME_LIMIT;
	const frameCounter = new McpSseFrameCounter(frameLimit);
	let totalBytes = 0;
	let settled = false;
	let removeAbort: (() => void) | undefined;
	let readerReleased = false;
	const releaseReader = () => {
		if (readerReleased) return;
		readerReleased = true;
		upstreamReader.releaseLock();
	};
	const cancelAndRelease = async (reason?: unknown) => {
		try {
			await upstreamReader.cancel(reason);
		} finally {
			releaseReader();
		}
	};
	const settle = (error?: unknown) => {
		if (settled) return false;
		settled = true;
		removeAbort?.();
		options.cleanup?.(error, totalBytes);
		return true;
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const abort = () => {
				const error = abortError(options.signal!);
				if (!settle(error)) return;
				void cancelAndRelease(options.signal?.reason).catch(() => undefined);
				controller.error(error);
			};
			if (options.signal) {
				options.signal.addEventListener("abort", abort, { once: true });
				removeAbort = () => options.signal?.removeEventListener("abort", abort);
				if (options.signal.aborted) abort();
			}
		},
		async pull(controller) {
			try {
				const { done, value } = await upstreamReader.read();
				if (settled) return;
				if (done) {
					settle();
					releaseReader();
					controller.close();
					return;
				}
				totalBytes += value.byteLength;
				frameCounter.consume(value);
				controller.enqueue(value);
			} catch (error) {
				const normalized =
					error instanceof McpTransportError
						? error
						: options.signal?.aborted
							? abortError(options.signal, error)
							: new McpTransportError("upstream_abort", "MCP request upstream_abort", { cause: error });
				if (!settle(normalized)) return;
				void cancelAndRelease(normalized).catch(() => undefined);
				controller.error(normalized);
			}
		},
		cancel(reason) {
			if (settled) return;
			settled = true;
			options.onCancel?.();
			options.cleanup?.(undefined, totalBytes);
			removeAbort?.();
			return cancelAndRelease(reason);
		},
	});
	return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Parse only a complete, bounded JSON or SSE response. */
export async function parseJsonRpcResponse(
	response: Response,
	expectedId?: unknown,
	options: { signal?: AbortSignal; limit?: number } = {},
): Promise<unknown> {
	if (response.status === 202 || response.status === 204) {
		if (expectedId !== undefined) throw new Error(`MCP response omitted JSON-RPC id ${String(expectedId)}`);
		return { jsonrpc: "2.0", id: null, result: {} };
	}
	const body = await readResponseBody(response, options);
	const text = new TextDecoder().decode(body.bytes);
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	try {
		if (!contentType.includes("text/event-stream")) return selectExpectedResponse([JSON.parse(text)], expectedId);
		const values: unknown[] = [];
		new McpSseFrameCounter(MCP_SSE_FRAME_LIMIT).consume(body.bytes);
		const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		for (const frame of normalizedText.split("\n\n")) {
			const data = frame
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) values.push(JSON.parse(data));
		}
		if (values.length === 0) throw new Error("SSE response contained no data payload");
		return selectExpectedResponse(values, expectedId);
	} catch (error) {
		if (error instanceof McpTransportError) throw error;
		if (error instanceof Error && (/^MCP response omitted JSON-RPC id /.test(error.message) || error.message === "SSE response contained no data payload")) {
			throw error;
		}
		throw new McpTransportError("malformed_json", "MCP response contained malformed JSON", { preview: body.preview, cause: error });
	}
}

function selectExpectedResponse(values: unknown[], expectedId: unknown): unknown {
	if (expectedId === undefined) return values.at(-1);
	const match = values.find((value) => value !== null && typeof value === "object" && Object.hasOwn(value, "id") && Object.is((value as { id?: unknown }).id, expectedId));
	if (match !== undefined) return match;
	throw new Error(`MCP response omitted JSON-RPC id ${String(expectedId)}`);
}

export function newMcpCallId(): string {
	return randomUUID();
}

export interface McpTerminalOutcome {
	call_id: string;
	request_bytes: number;
	response_bytes: number;
	request_limit: number;
	response_limit: number;
	duration_ms: number;
	http_status: number | null;
	jsonrpc_status: "success" | "error" | "unknown";
	truncated: boolean;
	aborted: boolean;
	abort_reason: McpAbortReason | null;
	retryable: boolean;
	ambiguous_execution: boolean;
	diagnostic_preview?: string;
}

export function logMcpTerminalOutcome(
	logger: { info: (message: unknown, ...args: unknown[]) => void },
	outcome: McpTerminalOutcome,
): void {
	const { diagnostic_preview: diagnosticPreview, ...safeOutcome } = outcome;
	logger.info({
		...safeOutcome,
		...(diagnosticPreview ? { diagnostic_preview: "[REDACTED]" } : {}),
		msg: "MCP terminal outcome",
	});
}
