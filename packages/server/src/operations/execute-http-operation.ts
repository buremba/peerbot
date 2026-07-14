import { getErrorMessage } from "@lobu/core";
import { getDb } from "../db/client";
import { resolveCredentialsByConnectionId } from "../mcp-proxy/credential-resolver";
import type { OperationDescriptor } from "./types";

export type HttpOperationExecutionResult =
	| {
			status: "completed";
			output: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	| { status: "failed"; error_message: string };

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

async function failRun(
	runId: number,
	organizationId: string,
	errorMessage: string,
): Promise<HttpOperationExecutionResult> {
	await getDb()`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage} WHERE id = ${runId} AND organization_id = ${organizationId}`;
	return { status: "failed", error_message: errorMessage };
}

/** Execute one OpenAPI-derived HTTP operation and finalize its run row. */
export async function executeHttpOperation(
	runId: number,
	organizationId: string,
	connection: HttpOperationConnection,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
): Promise<HttpOperationExecutionResult> {
	const sql = getDb();
	if (operation.backend_config.backend !== "http_operation") {
		return {
			status: "failed",
			error_message: "Invalid HTTP operation backend config",
		};
	}

	const credentials = await resolveCredentialsByConnectionId(
		connection.id,
		organizationId,
	);
	if (!credentials) {
		return {
			status: "failed",
			error_message: `No active OAuth credentials found for '${connection.connector_key}'.`,
		};
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

	try {
		const response = await fetch(url, {
			method: operation.backend_config.method,
			headers,
			body: ["GET", "HEAD"].includes(operation.backend_config.method)
				? undefined
				: requestBody,
			redirect: "manual",
		});

		const text = await response.text();
		let parsedBody: unknown = text;
		try {
			parsedBody = text ? JSON.parse(text) : null;
		} catch {
			// Keep non-JSON responses as text.
		}
		const output = { body: parsedBody } as Record<string, unknown>;
		const metadata: Record<string, unknown> = {
			http_status: response.status,
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
				typeof parsedBody === "string" ? parsedBody : `HTTP ${response.status}`;
			await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), action_output = ${sql.json(output)}, error_message = ${errorText} WHERE id = ${runId} AND organization_id = ${organizationId}`;
			return { status: "failed", error_message: errorText };
		}

		await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
		return { status: "completed", output, metadata };
	} catch (error) {
		return failRun(runId, organizationId, getErrorMessage(error));
	}
}
