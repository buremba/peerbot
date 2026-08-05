import type {
	ConnectorAuthAppInstallation,
	ConnectorAuthOAuth,
} from "@lobu/connector-sdk";
import { buildSlackSelfInstallDeepLink } from "./slack-self-install";

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
	self_install_url?: string;
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
	/**
	 * Whether the connector also declares a BYO (`none`) auth method, i.e. it can
	 * be connected with a self-created app whose credentials are pasted in. Only
	 * then is the self-install deep link relevant.
	 */
	hasByoMethod?: boolean;
}): ConnectorSetupError {
	// The hosted "Add to <provider>" install needs the provider's OAuth client
	// env configured on the gateway. When it's absent (self-hosted gateways,
	// no hosted Lobu app), the hosted install URL is dead — suppress it and
	// lead with the self-install deep link instead.
	const hostedConfigured =
		!params.method.clientIdKey || !!process.env[params.method.clientIdKey];
	const installUrl = hostedConfigured
		? joinUrl(params.gatewayBaseUrl, hostedInstallPath(params.method))
		: undefined;

	const selfInstallUrl =
		params.hasByoMethod && params.method.provider === "slack"
			? buildSlackSelfInstallDeepLink({
					method: params.method,
					gatewayOrigin: params.gatewayBaseUrl
						? new URL(params.gatewayBaseUrl).origin
						: undefined,
				})
			: undefined;

	const error = installUrl
		? `Connector '${params.connectorKey}' is connected by installing its ${params.method.provider} app. Open install_url to install it, then retry after the installation links the connection.`
		: selfInstallUrl
			? `Connector '${params.connectorKey}' has no hosted ${params.method.provider} app configured on this gateway. Create your own app from self_install_url, install it into your workspace, then retry connect with the app's bot token and signing secret.`
			: `Connector '${params.connectorKey}' requires a ${params.method.provider} app installation. Open setup_url to configure the installation, then retry.`;

	return {
		error,
		error_code: "connector_setup_required",
		connector_key: params.connectorKey,
		provider: params.method.provider,
		install_type: "app_installation",
		next_action: installUrl || selfInstallUrl ? "install_app" : "open_setup",
		...(params.method.providerInstance
			? { provider_instance: params.method.providerInstance }
			: {}),
		...(params.setupUrl ? { setup_url: params.setupUrl } : {}),
		...(installUrl ? { install_url: installUrl } : {}),
		...(selfInstallUrl ? { self_install_url: selfInstallUrl } : {}),
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
