import { getErrorMessage } from "@lobu/core";
import { resolveCredentialsByConnectionId } from "../mcp-proxy/credential-resolver";
import type { OperationDescriptor } from "./types";

const DEFAULT_HTTP_OPERATION_FETCH_TIMEOUT_MS = 120_000;
const MAX_HTTP_OPERATION_RESPONSE_BYTES = 5 * 1024 * 1024;

export type HttpOperationExecutionResult =
	| {
			status: "completed";
			output: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	| {
			status: "failed";
			error_message: string;
			output?: Record<string, unknown>;
	  };

export interface HttpOperationConnection {
	id: number;
	connector_key: string;
}

function buildResolvedUrl(
	serverUrl: string,
	pathTemplate: string,
	input: Record<string, unknown>,
): URL {
	const pathValues =
		input.path && typeof input.path === "object"
			? (input.path as Record<string, unknown>)
			: {};
	const queryValues =
		input.query && typeof input.query === "object"
			? (input.query as Record<string, unknown>)
			: {};
	let path = pathTemplate;
	for (const [key, value] of Object.entries(pathValues)) {
		path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
	}

	const url = new URL(
		path,
		serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`,
	);
	for (const [key, value] of Object.entries(queryValues)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) url.searchParams.append(key, String(item));
		} else {
			url.searchParams.set(key, String(value));
		}
	}
	return url;
}

function pickInterestingHeaders(
	headers: Headers,
): Record<string, unknown> | undefined {
	const interestingHeaders = [
		"content-type",
		"x-ratelimit-remaining",
		"x-ratelimit-reset",
		"link",
	];
	const values = Object.fromEntries(
		interestingHeaders
			.map((header) => [header, headers.get(header)])
			.filter(([, value]) => value !== null),
	);
	return Object.keys(values).length > 0 ? values : undefined;
}

function failRun(errorMessage: string): HttpOperationExecutionResult {
	return { status: "failed", error_message: errorMessage };
}

function requestAbortSignal(parent?: AbortSignal): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const configuredTimeout = Number(
		process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS ??
			DEFAULT_HTTP_OPERATION_FETCH_TIMEOUT_MS,
	);
	const timeoutMs =
		Number.isFinite(configuredTimeout) && configuredTimeout > 0
			? configuredTimeout
			: DEFAULT_HTTP_OPERATION_FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const relayParentAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) {
		relayParentAbort();
	} else {
		parent?.addEventListener("abort", relayParentAbort, { once: true });
	}
	const timeout = setTimeout(
		() =>
			controller.abort(
				new Error(`HTTP operation timed out after ${timeoutMs}ms`),
			),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", relayParentAbort);
		},
	};
}

async function readResponseTextBounded(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_HTTP_OPERATION_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    return { text: "", truncated: true };
  }
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_HTTP_OPERATION_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return { text: "", truncated: true };
    }
    chunks.push(value);
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated: false,
  };
}

/**
 * Execute one OpenAPI-derived HTTP operation. Like the other inline backends
 * this only reports the outcome; `executeOperationInline` owns every `runs`
 * transition so a successful apply is persisted before terminalization.
 */
export async function executeHttpOperation(
	organizationId: string,
	connection: HttpOperationConnection,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	abortSignal?: AbortSignal,
): Promise<HttpOperationExecutionResult> {
	if (operation.backend_config.backend !== "http_operation") {
		return failRun("Invalid HTTP operation backend config");
	}

	try {
		const credentials = await resolveCredentialsByConnectionId(
			connection.id,
			organizationId,
		);
		if (!credentials) {
			return failRun(
				`No active OAuth credentials found for '${connection.connector_key}'.`,
			);
		}

		const headersInput =
			actionInput.headers && typeof actionInput.headers === "object"
				? (actionInput.headers as Record<string, unknown>)
				: {};
		const headers = new Headers();
		for (const [key, value] of Object.entries(headersInput)) {
			if (
				/^(authorization|host)$/i.test(key) ||
				value === undefined ||
				value === null
			) {
				continue;
			}
			headers.set(key, String(value));
		}
		headers.set(
			"Authorization",
			`${credentials.tokenType} ${credentials.accessToken}`,
		);

		const body = actionInput.body;
		let requestBody: string | undefined;
		if (body !== undefined) {
			requestBody = typeof body === "string" ? body : JSON.stringify(body);
			if (
				!headers.has("content-type") &&
				typeof body === "object" &&
				body !== null
			) {
				headers.set("content-type", "application/json");
			}
		}

		const url = buildResolvedUrl(
			operation.backend_config.serverUrl,
			operation.backend_config.pathTemplate,
			actionInput,
		);

		const requestAbort = requestAbortSignal(abortSignal);
		let response: Response;
		let text: string;
		let responseBodyTruncated = false;
		try {
			response = await fetch(url, {
				method: operation.backend_config.method,
				headers,
				body: ["GET", "HEAD"].includes(operation.backend_config.method)
					? undefined
					: requestBody,
				redirect: "manual",
				signal: requestAbort.signal,
			});
			const boundedBody = await readResponseTextBounded(response);
			text = boundedBody.text;
			responseBodyTruncated = boundedBody.truncated;
		} finally {
			requestAbort.cleanup();
		}

		let parsedBody: unknown = text;
		try {
			parsedBody = text ? JSON.parse(text) : null;
		} catch {
			// Keep non-JSON responses as text.
		}
		const output = {
			body: responseBodyTruncated ? null : parsedBody,
			...(responseBodyTruncated ? { body_truncated: true } : {}),
		} as Record<string, unknown>;
		const metadata: Record<string, unknown> = {
			http_status: response.status,
			...(responseBodyTruncated
				? { response_body_truncated: true }
				: {}),
		};
		const headerMetadata = pickInterestingHeaders(response.headers);
		if (headerMetadata) {
			metadata.response_headers = headerMetadata;
			const rateLimits = Object.fromEntries(
				Object.entries(headerMetadata).filter(([key]) =>
					key.startsWith("x-ratelimit"),
				),
			);
			if (Object.keys(rateLimits).length > 0) metadata.rate_limits = rateLimits;
			if (headerMetadata.link) {
				metadata.pagination = { link: headerMetadata.link };
			}
		}

		if (!response.ok) {
			const errorText =
				!responseBodyTruncated && typeof parsedBody === "string"
					? parsedBody
					: `HTTP ${response.status}`;
			return { status: "failed", error_message: errorText, output };
		}

		return { status: "completed", output, metadata };
	} catch (error) {
		return failRun(getErrorMessage(error));
	}
}
