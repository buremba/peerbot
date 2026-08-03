import type {
	ConnectorAuthAppInstallation,
	ConnectorAuthOAuth,
} from "@lobu/connector-sdk";

export type ConnectorSetupError = {
	error: string;
	error_code: "connector_setup_required";
	connector_key: string;
	provider: string;
	provider_instance?: string;
	install_type: "app_installation" | "oauth_app_profile";
	next_action: "install_app" | "configure_oauth_app" | "open_setup";
	setup_url?: string;
	install_url?: string;
	install_shape?: "oauth-code-exchange" | "github-app";
	setup_instructions?: string;
};

function hostedInstallPath(
	method: ConnectorAuthAppInstallation,
): string | undefined {
	const provider = encodeURIComponent(method.provider);
	if (method.installShape === "oauth-code-exchange")
		return `/${provider}/install`;
	if (method.installShape === "github-app") return `/${provider}/app/install`;
	return undefined;
}

function joinUrl(
	baseUrl: string | undefined,
	path: string | undefined,
): string | undefined {
	if (!baseUrl || !path) return undefined;
	return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export function buildAppInstallationSetupError(params: {
	connectorKey: string;
	method: ConnectorAuthAppInstallation;
	gatewayBaseUrl?: string;
	setupUrl?: string;
}): ConnectorSetupError {
	const installUrl = joinUrl(
		params.gatewayBaseUrl,
		hostedInstallPath(params.method),
	);
	return {
		error: installUrl
			? `Connector '${params.connectorKey}' is connected by installing its ${params.method.provider} app. Open install_url to install it, then retry after the installation links the connection.`
			: `Connector '${params.connectorKey}' requires a ${params.method.provider} app installation. Open setup_url to configure the installation, then retry.`,
		error_code: "connector_setup_required",
		connector_key: params.connectorKey,
		provider: params.method.provider,
		install_type: "app_installation",
		next_action: installUrl ? "install_app" : "open_setup",
		...(params.method.providerInstance
			? { provider_instance: params.method.providerInstance }
			: {}),
		...(params.setupUrl ? { setup_url: params.setupUrl } : {}),
		...(installUrl ? { install_url: installUrl } : {}),
		...(params.method.installShape
			? { install_shape: params.method.installShape }
			: {}),
	};
}

export function buildOAuthAppProfileSetupError(params: {
	connectorKey: string;
	method: Pick<ConnectorAuthOAuth, "provider" | "setupInstructions">;
	setupUrl?: string;
}): ConnectorSetupError {
	return {
		error: `OAuth app profile not configured for '${params.method.provider}'. Configure the connector's OAuth app credentials, then retry.`,
		error_code: "connector_setup_required",
		connector_key: params.connectorKey,
		provider: params.method.provider,
		install_type: "oauth_app_profile",
		next_action: "configure_oauth_app",
		...(params.setupUrl ? { setup_url: params.setupUrl } : {}),
		...(params.method.setupInstructions
			? { setup_instructions: params.method.setupInstructions }
			: {}),
	};
}
