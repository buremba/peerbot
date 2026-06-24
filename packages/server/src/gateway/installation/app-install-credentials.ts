/**
 * Resolve app-installation credentials from the connector's DECLARED auth schema
 * instead of hardcoding `process.env.GITHUB_*` literals in the server.
 *
 * The connector's `app_installation` method declares the *names* of the env vars
 * that hold each credential (`appIdKey`, `privateKeyKey`, `appSlugKey`,
 * `clientIdKey`, `clientSecretKey`, `webhookSecretKey`) plus the `installUrlTemplate`.
 * This module reads those declared names and returns the resolved values, so the
 * server holds no provider-specific env literal — adding/relocating a credential
 * env var is a connector edit, not a server edit.
 *
 * The declaration is sourced from the BUNDLED connector on disk (the same compile
 * path `ensure-connector-installed` uses): env-var names are deployment-wide
 * constants, not per-org, so one resolve per (connectorKey, provider) per process
 * is correct. `compileConnectorFromFile` is mtime-cached and the resolved method
 * is memoised here, so route/startup callers pay the extract cost at most once.
 */

import type { ConnectorAuthAppInstallation } from "@lobu/connector-sdk";
import {
	getAppInstallationAuthMethods,
	normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import {
	compileConnectorFromFile,
	findBundledConnectorFile,
} from "../../utils/connector-catalog.js";
import { extractConnectorMetadata } from "../../utils/connector-compiler.js";

const methodCache = new Map<string, ConnectorAuthAppInstallation | null>();

/**
 * The declared `app_installation` auth method for a bundled connector (or null
 * when the connector has no bundled source / no app_installation method).
 * Memoised per (connectorKey, provider).
 */
export async function getBundledAppInstallationMethod(
	connectorKey: string,
	provider?: string,
): Promise<ConnectorAuthAppInstallation | null> {
	const cacheKey = `${connectorKey}::${provider ?? ""}`;
	const cached = methodCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const file = findBundledConnectorFile(connectorKey);
	if (!file) {
		methodCache.set(cacheKey, null);
		return null;
	}
	const code = await compileConnectorFromFile(file);
	const metadata = await extractConnectorMetadata(code);
	const methods = getAppInstallationAuthMethods(
		normalizeConnectorAuthSchema(metadata.authSchema),
	);
	const method =
		methods.find((m) => !provider || m.provider === provider) ?? null;
	methodCache.set(cacheKey, method);
	return method;
}

/**
 * Synchronous read of a previously-resolved (primed) app_installation method.
 * Returns undefined when the (connectorKey, provider) pair has not been primed —
 * callers in synchronous contexts (gateway route wiring) must
 * {@link primeAppInstallationMethods} during async boot first.
 */
export function getCachedAppInstallationMethod(
	connectorKey: string,
	provider?: string,
): ConnectorAuthAppInstallation | null | undefined {
	return methodCache.get(`${connectorKey}::${provider ?? ""}`);
}

/**
 * Warm the method cache during async boot so synchronous wiring (e.g.
 * `createGatewayApp`) can read declarations via {@link getCachedAppInstallationMethod}
 * without going async. Per-spec failures are swallowed (logged by the compile
 * path) and leave that entry unprimed — the provider simply isn't registered,
 * identical to a missing app-id env, never a boot failure.
 */
export async function primeAppInstallationMethods(
	specs: Array<{ connectorKey: string; provider?: string }>,
): Promise<void> {
	await Promise.all(
		specs.map(async (spec) => {
			try {
				await getBundledAppInstallationMethod(spec.connectorKey, spec.provider);
			} catch {
				// leave unprimed; getCachedAppInstallationMethod returns undefined
			}
		}),
	);
}

/** Test-only: drop the memoised methods so a re-declared connector is re-read. */
export function clearAppInstallationMethodCache(): void {
	methodCache.clear();
}

export interface ResolvedAppInstallCredentials {
	appId?: string;
	privateKey?: string;
	appSlug?: string;
	clientId?: string;
	clientSecret?: string;
	webhookSecret?: string;
	installUrlTemplate?: string;
	/** The declared env-var names, stamped onto the install row so token minting reads the right vars. */
	appIdKey?: string;
	privateKeyKey?: string;
}

/** Read each declared credential env var by the NAME the connector declares. */
export function resolveAppInstallCredentials(
	method: ConnectorAuthAppInstallation,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedAppInstallCredentials {
	const read = (key?: string): string | undefined =>
		key ? env[key] : undefined;
	return {
		appId: read(method.appIdKey),
		privateKey: read(method.privateKeyKey),
		appSlug: read(method.appSlugKey),
		clientId: read(method.clientIdKey),
		clientSecret: read(method.clientSecretKey),
		webhookSecret: read(method.webhookSecretKey),
		installUrlTemplate: method.installUrlTemplate,
		appIdKey: method.appIdKey,
		privateKeyKey: method.privateKeyKey,
	};
}

/**
 * Build the App install URL from the connector's declared `installUrlTemplate`,
 * substituting `{{app_slug}}` and stamping the CSRF `state`. Falls back to null
 * when no template is declared.
 */
export function renderAppInstallUrl(
	template: string | undefined,
	appSlug: string | undefined,
	state: string,
): string | null {
	if (!template) return null;
	const filled = template.replace(
		/\{\{\s*app_slug\s*\}\}/g,
		encodeURIComponent(appSlug ?? ""),
	);
	const url = new URL(filled);
	url.searchParams.set("state", state);
	return url.toString();
}
