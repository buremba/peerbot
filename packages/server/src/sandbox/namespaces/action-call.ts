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

function failureMessage(
	actionName: string,
	value: unknown,
): { message: string; result: Record<string, unknown> } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value as Record<string, unknown>;
	const hasError = result.error !== undefined && result.error !== null;
	// Some mutation policies return `success:false` while durably queueing an
	// approval. That is a non-terminal accepted outcome, not a business failure;
	// callers need its approval URL/run id to continue the workflow.
	const acceptedForApproval = result.approval_queued === true;
	const reportsFailure =
		!acceptedForApproval && (result.success === false || result.ok === false);
	if (!hasError && !reportsFailure) return null;

	const candidates = [result.error, result.message, result.reason];
	const message = candidates.find(
		(candidate): candidate is string =>
			typeof candidate === "string" && candidate.trim().length > 0,
	);
	return {
		message: message?.trim() ?? `ClientSDK action '${actionName}' failed`,
		result,
	};
}

export function createActionCaller(
	handler: AdminHandler,
	env: Env,
	ctx: ToolContext,
) {
	const manage = <T>(payload: object): Promise<T> =>
		handler(payload as never, env, ctx) as Promise<T>;

	const action = async <T>(
		actionName: string,
		input: object = {},
	): Promise<T> => {
		// Spread caller input FIRST, then force `action` so a caller-supplied
		// `action` key (e.g. from a read-only query_sdk script) can never override
		// the discriminator and reach a write/delete handler.
		const { action: _ignored, ...rest } = input as Record<string, unknown>;
		const result = await manage<T>({ ...rest, action: actionName });
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
