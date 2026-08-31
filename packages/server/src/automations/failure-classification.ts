import { AgentErrorCode, PROVIDER_BALANCE_EXHAUSTED } from "@lobu/core";

/**
 * Permanent agent-turn failures are configuration walls: replaying the same
 * unattended run cannot change their outcome. Everything else remains on the
 * normal transient recovery path.
 */
export function isPermanentAutomationAgentError(
	code: string | null | undefined,
	message = "",
): boolean {
	if (
		code === AgentErrorCode.NO_MODEL_CONFIGURED ||
		code === AgentErrorCode.PROVIDER_AUTH ||
		code === AgentErrorCode.PROVIDER_UNKNOWN_MODEL ||
		code === AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED
	) {
		return true;
	}
	if (
		/\brequires interactive approval\b|\bblocked on tool approval\b/i.test(
			message,
		)
	) {
		return true;
	}
	if (code !== AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED) return false;

	// A provider-named reset or retry horizon is self-healing. Only a depleted
	// balance/credit wall needs configuration and should auto-pause immediately.
	if (
		/\b(?:reset(?:s)?(?:\s+at|\s+in)?|retry[-_ ]?(?:in|after|delay))\b/i.test(
			message,
		)
	) {
		return false;
	}
	return PROVIDER_BALANCE_EXHAUSTED.test(message);
}
