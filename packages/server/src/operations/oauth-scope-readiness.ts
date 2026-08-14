import { hasAllScopes } from "../auth/oauth/scopes";

/**
 * Return required OAuth scopes missing from a grant whose scope set is known.
 * Legacy profiles without recorded granted scopes remain ungated, matching
 * operation readiness; a recorded empty grant is known and fails closed.
 */
export function getMissingKnownOAuthScopes(
	grantedScopes: string[],
	grantedScopesKnown: boolean,
	requiredScopes: string[],
): string[] {
	if (!grantedScopesKnown) return [];
	return requiredScopes.filter(
		(scope) => !hasAllScopes(grantedScopes, [scope]),
	);
}
