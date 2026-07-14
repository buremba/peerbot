import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";
import { ToolUserError } from "../../utils/errors";

type AdminHandler = (args: any, env: Env, ctx: ToolContext) => Promise<unknown>;

/**
 * Consistent failure raised by named ClientSDK namespace methods when a legacy
 * admin handler reports a business failure as a result value. The original
 * result is retained for server-side diagnostics and recovery code, while the
 * Error contract makes run_sdk/query_sdk fail instead of reporting success.
 */
export class ClientSdkActionError extends ToolUserError {
	readonly action: string;
	readonly result: Readonly<Record<string, unknown>>;

	constructor(
		action: string,
		message: string,
		result: Record<string, unknown>,
	) {
		super(message, 400);
		this.name = "ClientSdkActionError";
		this.action = action;
		this.result = result;
	}
}

export function requirePositionalNumber(
	method: string,
	value: unknown,
	example: string,
): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new ToolUserError(
		`${method} expects a positional number. Call ${example}; do not pass an object.`,
	);
}

export function requirePositionalString(
	method: string,
	value: unknown,
	example: string,
): string {
	if (typeof value === "string") return value;
	throw new ToolUserError(
		`${method} expects a positional string. Call ${example}; do not pass an object.`,
	);
}

function failureMessage(
	actionName: string,
	value: unknown,
): { message: string; result: Record<string, unknown> } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value as Record<string, unknown>;
	const hasError = result.error !== undefined && result.error !== null;
	const summary =
		result.summary &&
		typeof result.summary === "object" &&
		!Array.isArray(result.summary)
			? (result.summary as Record<string, unknown>)
			: null;
	const allAggregateItemsFailed =
		typeof summary?.failed === "number" &&
		summary.failed > 0 &&
		summary.successful === 0;
	// Some mutation policies return `success:false` while durably queueing an
	// approval. That is a non-terminal accepted outcome, not a business failure;
	// callers need its approval URL/run id to continue the workflow.
	const acceptedForApproval = result.approval_queued === true;
	const reportsFailure =
		!acceptedForApproval &&
		(result.success === false ||
			result.ok === false ||
			result.status === "failed" ||
			result.status === "error" ||
			result.status === "timeout" ||
			allAggregateItemsFailed);
	if (!hasError && !reportsFailure) return null;
	const failedItem = Array.isArray(result.results)
		? result.results.find(
				(item): item is Record<string, unknown> =>
					item !== null &&
					typeof item === "object" &&
					!Array.isArray(item) &&
					(item as Record<string, unknown>).success === false,
			)
		: undefined;

	const candidates = [
		result.error,
		result.error_message,
		result.message,
		result.reason,
		failedItem?.error,
		failedItem?.error_message,
		failedItem?.message,
		failedItem?.reason,
	];
	const message = candidates.find(
		(candidate): candidate is string =>
			typeof candidate === "string" && candidate.trim().length > 0,
	);
	return {
		message: message?.trim() ?? `ClientSDK action '${actionName}' failed`,
		result,
	};
}

/**
 * Rewrite a leaked internal tool name in a validation error to the public SDK
 * method the caller actually invoked. An arg-validation failure raised deep in
 * an admin handler reads `Invalid arguments for manage_feeds: …`, but a fresh
 * agent only ever called `client.feeds.get` — `manage_feeds` is internal
 * plumbing it cannot search or recover against. When the namespace is known,
 * swap `manage_<x>` for `client.<namespace>.<method>` and keep the field-level
 * detail (`/feed_id: Expected required property`) intact.
 */
/** `generate_embeddings` → `generateEmbeddings`; leaves already-camel/plain names intact. */
function snakeToCamel(name: string): string {
	return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function rewriteInternalToolName(
	err: unknown,
	sdkNamespace: string | undefined,
	publicMethod: string,
): unknown {
	if (!sdkNamespace || !(err instanceof ToolUserError)) return err;
	const rewritten = err.message
		.replace(
			/Invalid arguments for manage_[a-z_]+/,
			`Invalid arguments for client.${sdkNamespace}.${publicMethod}`,
		)
		// The valid-args list is scoped to the INTERNAL action (`for action
		// 'read_feed'`) — drop that fragment once the public method already names
		// the call, so no internal action name survives in the message.
		.replace(/ for action '[a-z_]+'/, "");
	if (rewritten === err.message) return err;
	// ClientSdkActionError carries extra fields — but it is raised by THIS module
	// from a result value, never by the arg validator, so a match here is always
	// a plain ToolUserError. Preserve the httpStatus.
	return new ToolUserError(rewritten, err.httpStatus);
}

export function createActionCaller(
	handler: AdminHandler,
	env: Env,
	ctx: ToolContext,
	/**
	 * Public ClientSDK namespace (e.g. `"feeds"`) this caller belongs to. When
	 * set, arg-validation errors that leak the internal `manage_*` tool name are
	 * rewritten to `client.<namespace>.<method>`. Omit for callers with no public
	 * SDK surface (errors then pass through unchanged).
	 */
	sdkNamespace?: string,
) {
	const manage = <T>(payload: object): Promise<T> =>
		handler(payload as never, env, ctx) as Promise<T>;

	const action = async <T>(
		actionName: string,
		input: object = {},
		/**
		 * Public SDK method name. Defaults to the CAMEL-CASE of the internal
		 * action (`generate_embeddings` → `generateEmbeddings`), which is the
		 * actual method on most namespaces — a bare snake_case default would
		 * render a nonexistent path like `client.classifiers.generate_embeddings`.
		 * Namespaces whose public name diverges from the action (e.g. feeds
		 * `read_feed` → `get`) pass it explicitly.
		 */
		publicMethod: string = snakeToCamel(actionName),
	): Promise<T> => {
		// Spread caller input FIRST, then force `action` so a caller-supplied
		// `action` key (e.g. from a read-only query_sdk script) can never override
		// the discriminator and reach a write/delete handler.
		const { action: _ignored, ...rest } = input as Record<string, unknown>;
		let result: T;
		try {
			result = await manage<T>({ ...rest, action: actionName });
		} catch (err) {
			throw rewriteInternalToolName(err, sdkNamespace, publicMethod);
		}
		const failure = failureMessage(actionName, result);
		if (failure) {
			throw new ClientSdkActionError(
				actionName,
				failure.message,
				failure.result,
			);
		}
		return result;
	};

	return { manage, action };
}
