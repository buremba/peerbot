import { randomUUID } from "node:crypto";
import { isSecretKey } from "@lobu/core";
import type {
	ConnectCompletionCheckType,
	ConnectSdkCallType,
	ConnectSetupFamilyType,
	ConnectSetupNextActionType,
	ManageConnectionsResult,
} from "@lobu/core/contracts/tools/manage-connections";
import type { ConnectorSetupError } from "./connector-setup-errors";

export type ConnectionSetupFamily = ConnectSetupFamilyType;
export type ConnectionSetupNextAction = ConnectSetupNextActionType;
export type SdkCallDescriptor = ConnectSdkCallType;
type SetupCompletionCheck = ConnectCompletionCheckType;

function omitSecretValues(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitSecretValues);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !isSecretKey(key))
			.map(([key, child]) => [key, omitSecretValues(child)]),
	);
}

function omitUndefinedProperties(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, child]) => child !== undefined),
	);
}

/**
 * Build a retry descriptor without reflecting caller-supplied secrets back to
 * the agent. Secret keys are omitted instead of replaced: a redaction sentinel
 * in an executable call could be mistaken for a real credential on resume.
 */
export function buildSafeConnectionResumeCall(
	sdkMethod: "connections.connect" | "connections.create",
	args: object,
): SdkCallDescriptor {
	const safeArgs = omitSecretValues(args) as Record<string, unknown>;
	delete safeArgs.action;
	return {
		sdk_method: sdkMethod,
		arguments: [safeArgs],
	};
}

interface ConnectionSetupContinuationInput {
	action: "connect" | "create";
	connectorKey: string;
	setupFamily: ConnectionSetupFamily;
	nextAction: ConnectionSetupNextAction;
	instructions: string;
	resumeCall?: SdkCallDescriptor;
	completionCheck?: SetupCompletionCheck;
	setupUrl?: string;
	installUrl?: string;
	connectUrl?: string;
	provider?: string;
	connectionId?: number;
	slug?: string;
	authRunId?: number;
	setupAttemptId?: string;
	errorCode?: "connector_setup_required";
	installType?: "app_installation" | "oauth_app_profile";
	installShape?: "oauth-code-exchange" | "github-app";
	setupInstructions?: string;
}

/**
 * A setup continuation is deliberately a successful SDK result: no `error`
 * field means `run_sdk` returns it intact for the agent to act on. The three
 * affordances are separate: `next_action` is the user step, `resume_call` is
 * the exact SDK call after manual setup, and `completion_check` is present
 * only when it can be invoked immediately using values in this result.
 */
export function buildConnectionSetupContinuation(
	input: ConnectionSetupContinuationInput,
): ManageConnectionsResult {
	return omitUndefinedProperties({
		action: input.action,
		status: "setup_required",
		connector_key: input.connectorKey,
		setup_family: input.setupFamily,
		next_action: input.nextAction,
		instructions: input.instructions,
		error_code: input.errorCode,
		install_type: input.installType,
		install_shape: input.installShape,
		setup_instructions: input.setupInstructions,
		resume_call: input.resumeCall,
		completion_check: input.completionCheck,
		setup_url: input.setupUrl,
		install_url: input.installUrl,
		connect_url: input.connectUrl,
		provider: input.provider,
		connection_id: input.connectionId,
		slug: input.slug,
		auth_run_id: input.authRunId,
		setup_attempt_id: input.setupAttemptId,
	}) as ManageConnectionsResult;
}

export function activeConnectionPoll(
	connectionId: number,
): SetupCompletionCheck {
	return {
		call: {
			sdk_method: "connections.get",
			arguments: [connectionId],
		},
		success_when: { path: "connection.status", equals: "active" },
		poll_interval_ms: 2000,
		description: "Poll until the connection becomes active.",
	};
}

export function installedConnectorPoll(
	connectorKey: string,
	setupAttemptId: string,
): SetupCompletionCheck {
	return {
		call: {
			sdk_method: "connections.list",
			arguments: [
				{
					connector_key: connectorKey,
					status: "active",
					setup_attempt_id: setupAttemptId,
				},
			],
		},
		success_when: {
			path: "connections[].config.setup_attempt_ids",
			includes: setupAttemptId,
		},
		poll_interval_ms: 2000,
		description:
			"Poll until the provider callback marks this exact setup attempt active.",
	};
}

export function appendSetupAttemptId(
	installUrl: string,
	setupAttemptId: string,
): string {
	const url = new URL(installUrl);
	url.searchParams.set("setup_attempt_id", setupAttemptId);
	return url.toString();
}

export function appInstallationSetupContinuation(params: {
	action: "connect" | "create";
	connectorKey: string;
	setup: ConnectorSetupError;
	setupUrl?: string;
}): ManageConnectionsResult {
	const { action, connectorKey, setup, setupUrl } = params;
	const setupAttemptId =
		setup.provider === "github" && setup.install_url ? randomUUID() : undefined;
	return buildConnectionSetupContinuation({
		action,
		connectorKey,
		setupFamily: "app_installation",
		nextAction:
			setup.next_action === "install_app" ? "install_app" : "open_setup",
		instructions: setup.error,
		errorCode: setup.error_code,
		installType: setup.install_type,
		installShape: setup.install_shape,
		setupInstructions: setup.setup_instructions,
		setupUrl,
		installUrl:
			setup.install_url && setupAttemptId
				? appendSetupAttemptId(setup.install_url, setupAttemptId)
				: setup.install_url,
		provider: setup.provider,
		completionCheck: setupAttemptId
			? installedConnectorPoll(connectorKey, setupAttemptId)
			: undefined,
		setupAttemptId,
	});
}

export function oauthAppSetupContinuation(params: {
	action: "connect" | "create";
	connectorKey: string;
	setup: ConnectorSetupError;
	resumeCall: SdkCallDescriptor;
	fallbackSetupUrl?: string;
}): ManageConnectionsResult {
	const { action, connectorKey, setup, resumeCall, fallbackSetupUrl } = params;
	return buildConnectionSetupContinuation({
		action,
		connectorKey,
		setupFamily: "oauth",
		nextAction: "configure_oauth_app",
		instructions: setup.setup_instructions
			? `${setup.error} ${setup.setup_instructions}`
			: setup.error,
		setupUrl: setup.setup_url ?? fallbackSetupUrl,
		provider: setup.provider,
		errorCode: setup.error_code,
		installType: setup.install_type,
		setupInstructions: setup.setup_instructions,
		resumeCall,
	});
}
