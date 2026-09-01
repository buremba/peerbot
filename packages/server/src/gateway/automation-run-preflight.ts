import {
	AgentErrorCode,
	getErrorMessage,
} from "@lobu/core";
import type { ProviderCatalogService } from "./auth/provider-catalog.js";
import type { GrantStore } from "./permissions/grant-store.js";

const AUTOMATION_COMPLETION_TOOL = "/mcp/lobu-memory/tools/run_sdk";

export type AutomationRunPreflightResult =
	| { ok: true; model: string }
	| {
			ok: false;
			retryable: boolean;
			error: string;
			errorCode?: AgentErrorCode;
		};

export function automationToolIsPreApproved(
	patterns: readonly string[] | null | undefined,
	toolPath = AUTOMATION_COMPLETION_TOOL,
): boolean {
	const wildcard = `${toolPath.slice(0, toolPath.lastIndexOf("/"))}/*`;
	return (patterns ?? []).some((pattern) => {
		const normalized = pattern.trim().toLowerCase();
		return normalized === toolPath || normalized === wildcard;
	});
}

/**
 * Last gate before a verified headless Automation message enters the durable
 * worker queue. It proves a concrete model has a credentialed provider and the
 * run can call its mandatory completion tool without waiting for a human who
 * is not present. Dependency failures are retryable; deterministic config
 * failures are not.
 */
export async function preflightAutomationRun(params: {
	agentId: string;
	organizationId: string;
	userId: string;
	requestedModel?: string;
	preApprovedTools?: readonly string[];
	proxyBaseUrl?: string;
	providerCatalog?: ProviderCatalogService;
	grantStore?: Pick<GrantStore, "isExactDeniedStrict">;
	completionRequired?: boolean;
}): Promise<AutomationRunPreflightResult> {
	const requestedModel = params.requestedModel?.trim();
	if (!requestedModel) {
		return {
			ok: false,
			retryable: false,
			error:
				"No runnable model is configured for this Automation's assigned agent.",
			errorCode: AgentErrorCode.NO_MODEL_CONFIGURED,
		};
	}

	if (!params.providerCatalog) {
		return {
			ok: false,
			retryable: true,
			error: "Provider catalog is temporarily unavailable for Automation preflight.",
		};
	}

	try {
		const resolved = await params.providerCatalog.resolveDispatchModel(
			params.agentId,
			params.organizationId,
			requestedModel,
			params.userId,
		);
		if (!resolved.model) {
			const requestedProvider = await params.providerCatalog.findProviderForModel(
				requestedModel,
				resolved.modules,
			);
			if (
				requestedProvider &&
				!requestedProvider.hasSystemKey() &&
				!(await requestedProvider.hasCredentials(params.agentId, {
					organizationId: params.organizationId,
					userId: params.userId,
				}))
			) {
				return {
					ok: false,
					retryable: false,
					error: `Provider "${requestedProvider.providerId}" is not authorized for this headless Automation. Configure a shared organization credential or API key for the provider.`,
					errorCode: AgentErrorCode.PROVIDER_AUTH,
				};
			}
			return {
				ok: false,
				retryable: false,
				error: `Model "${requestedModel}" has no runnable provider for this Automation.`,
				errorCode: AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED,
			};
		}

		const provider = await params.providerCatalog.findProviderForModel(
			resolved.model,
			resolved.modules,
		);
		if (!provider) {
			return {
				ok: false,
				retryable: false,
				error: `Model "${resolved.model}" has no installed provider for this Automation.`,
				errorCode: AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED,
			};
		}

		const hasCredentials =
			provider.hasSystemKey() ||
			(await provider.hasCredentials(params.agentId, {
				organizationId: params.organizationId,
				userId: params.userId,
			}));
		if (!hasCredentials) {
			return {
				ok: false,
				retryable: false,
				error: `Provider "${provider.providerId}" is not authorized for this headless Automation. Configure a shared organization credential or API key for the provider.`,
				errorCode: AgentErrorCode.PROVIDER_AUTH,
			};
		}
		if (!params.proxyBaseUrl) {
			return {
				ok: false,
				retryable: true,
				error: "Provider proxy route is temporarily unavailable for Automation preflight.",
			};
		}
		const mappings = provider.getProxyBaseUrlMappings(
			params.proxyBaseUrl,
			params.agentId,
			{
				organizationId: params.organizationId,
				userId: params.userId,
			},
		);
		if (Object.keys(mappings).length === 0) {
			return {
				ok: false,
				retryable: false,
				error: `Provider "${provider.providerId}" has no routable proxy mapping for this Automation.`,
				errorCode: AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED,
			};
		}

		if (params.completionRequired === false) {
			return { ok: true, model: resolved.model };
		}

		if (!params.grantStore) {
			return {
				ok: false,
				retryable: true,
				error:
					"Permissions store is temporarily unavailable for Automation preflight.",
			};
		}

		// Headless access must be present in the CURRENT agent configuration.
		// Durable allow rows cannot prove that: operator config grants and old
		// "always" approvals share the same table and have no provenance. The
		// worker synchronizes this current list before execution; preflight only
		// needs to make an explicit durable deny win over the configured wildcard.
		const completionDenied = await params.grantStore.isExactDeniedStrict(
			params.agentId,
			AUTOMATION_COMPLETION_TOOL,
			params.organizationId,
		);
		const completionApproved =
			automationToolIsPreApproved(params.preApprovedTools) && !completionDenied;
		if (!completionApproved) {
			return {
				ok: false,
				retryable: false,
				error:
					"Headless Automation cannot start because lobu-memory/run_sdk requires interactive approval.",
			};
		}

		return { ok: true, model: resolved.model };
	} catch (error) {
		return {
			ok: false,
			retryable: true,
			error: `Automation preflight could not verify runtime readiness: ${getErrorMessage(error)}`,
		};
	}
}
