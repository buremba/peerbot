import {
	getAppInstallationAuthMethods,
	getOAuthAuthMethods,
	normalizeConnectorAuthSchema,
} from "../utils/connector-auth";

export type OnboardingConnectorCandidate = {
	key: string;
	auth_schema: unknown;
};

export type AppInstallOnboardingCandidate = {
	connectorKey: string;
	provider: string;
	installShape: string | null;
};

export function lowerProvider(
	provider: string | null | undefined,
): string | null {
	const normalized = provider?.trim().toLowerCase();
	return normalized || null;
}

export function installUrlFor(provider: string, installShape: unknown): string {
	// The Lobu gateway is mounted under /lobu. GitHub App install owns the
	// /<provider>/app/install route; OAuth-code-exchange app installs (Slack)
	// mount /<provider>/install.
	if (installShape === "github-app") {
		return `/lobu/${encodeURIComponent(provider)}/app/install`;
	}
	return `/lobu/${encodeURIComponent(provider)}/install`;
}

export function findAppInstallLoginMatch(
	rows: OnboardingConnectorCandidate[],
	provider: string,
): AppInstallOnboardingCandidate | null {
	for (const row of rows) {
		const authSchema = normalizeConnectorAuthSchema(row.auth_schema);
		const hasMatchingLogin = getOAuthAuthMethods(authSchema).some(
			(method) =>
				lowerProvider(method.provider) === provider &&
				Array.isArray(method.loginScopes) &&
				method.loginScopes.length > 0,
		);
		if (!hasMatchingLogin) continue;

		const appInstall = getAppInstallationAuthMethods(authSchema).find(
			(method) => lowerProvider(method.provider) === provider,
		);
		if (!appInstall) continue;

		return {
			connectorKey: row.key,
			provider,
			installShape: appInstall.installShape ?? null,
		};
	}
	return null;
}

export function resolveAppInstallOnboardingCandidate(params: {
	hasNewUserMarker: boolean;
	providerId: string | null | undefined;
	connectors: OnboardingConnectorCandidate[];
}): AppInstallOnboardingCandidate | null {
	if (!params.hasNewUserMarker) return null;
	const provider = lowerProvider(params.providerId);
	if (!provider) return null;
	return findAppInstallLoginMatch(params.connectors, provider);
}
