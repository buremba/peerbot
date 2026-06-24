/**
 * Resolve app-installation credentials from the connector's DECLARED auth schema
 * instead of hardcoding `process.env.GITHUB_*` / `SLACK_*` literals in the server.
 *
 * The connector's `app_installation` method declares the *names* of the env vars
 * that hold each credential (`appIdKey`, `privateKeyKey`, `appSlugKey`,
 * `clientIdKey`, `clientSecretKey`, `webhookSecretKey`) plus the `installUrlTemplate`.
 * This module reads those declared names and returns the resolved values, so the
 * server holds no provider-specific env literal.
 *
 * Two sources, by context (this split fixes the prior compile-in-route fragility):
 *  - PER-ORG ROUTES (have an orgId): read the method from the org's
 *    `connector_definitions.auth_schema` row — the same declaration the install UI
 *    seeded and the hourly refresh-cron keeps synced from bundled source. No
 *    connector compile in a request path.
 *  - ORG-LESS STARTUP (gateway wiring): prime from the bundled connector on disk
 *    once at boot, then read synchronously. Env-var names are deployment-wide
 *    constants, so one resolve per (connectorKey, provider) per process is correct.
 */

import type { ConnectorAuthAppInstallation } from "@lobu/connector-sdk";
import { getDb } from "../../db/client.js";
import {
	getAppInstallationAuthMethods,
	normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import {
	compileConnectorFromFile,
	findBundledConnectorFile,
} from "../../utils/connector-catalog.js";
import { extractConnectorMetadata } from "../../utils/connector-compiler.js";

function pickMethod(
	authSchema: unknown,
	provider?: string,
): ConnectorAuthAppInstallation | null {
	const methods = getAppInstallationAuthMethods(
		normalizeConnectorAuthSchema(authSchema),
	);
	return methods.find((m) => !provider || m.provider === provider) ?? null;
}

/**
 * The declared `app_installation` method for a connector AS INSTALLED FOR ONE ORG
 * (read from `connector_definitions.auth_schema`). The per-org row is the source
 * of truth for routes — never compile the bundled connector in a request path.
 */
export async function getOrgAppInstallationMethod(
	organizationId: string,
	connectorKey: string,
	provider?: string,
): Promise<ConnectorAuthAppInstallation | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT auth_schema FROM connector_definitions
		WHERE key = ${connectorKey}
			AND organization_id = ${organizationId}
			AND status = 'active'
		LIMIT 1
	`) as unknown as Array<{ auth_schema: unknown }>;
	if (rows.length === 0) return null;
	return pickMethod(rows[0].auth_schema, provider);
}

// ---- org-less startup path (bundled connector) ----------------------------

const bundledMethodCache = new Map<
	string,
	ConnectorAuthAppInstallation | null
>();

async function resolveBundledMethod(
	connectorKey: string,
	provider?: string,
): Promise<ConnectorAuthAppInstallation | null> {
	const cacheKey = `${connectorKey}::${provider ?? ""}`;
	const cached = bundledMethodCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const file = findBundledConnectorFile(connectorKey);
	if (!file) {
		bundledMethodCache.set(cacheKey, null);
		return null;
	}
	const code = await compileConnectorFromFile(file);
	const metadata = await extractConnectorMetadata(code);
	const method = pickMethod(metadata.authSchema, provider);
	bundledMethodCache.set(cacheKey, method);
	return method;
}

/**
 * Synchronous read of a primed bundled-connector method, for synchronous wiring
 * (gateway route registration). Returns undefined when not primed — callers must
 * {@link primeAppInstallationMethods} during async boot first.
 */
export function getPrimedBundledMethod(
	connectorKey: string,
	provider?: string,
): ConnectorAuthAppInstallation | null | undefined {
	return bundledMethodCache.get(`${connectorKey}::${provider ?? ""}`);
}

/** Warm the bundled-method cache at async boot so sync gateway wiring can read it. */
export async function primeAppInstallationMethods(
	specs: Array<{ connectorKey: string; provider?: string }>,
): Promise<void> {
	await Promise.all(
		specs.map(async (spec) => {
			try {
				await resolveBundledMethod(spec.connectorKey, spec.provider);
			} catch {
				// leave unprimed; getPrimedBundledMethod returns undefined
			}
		}),
	);
}

/** Test-only: drop the primed bundled methods. */
export function clearBundledMethodCache(): void {
	bundledMethodCache.clear();
}

// ---- pure credential resolution -------------------------------------------

export interface ResolvedAppInstallCredentials {
	appId?: string;
	privateKey?: string;
	appSlug?: string;
	clientId?: string;
	clientSecret?: string;
	webhookSecret?: string;
	installUrlTemplate?: string;
	/** Declared env-var names, stamped onto the install row so token minting reads the right vars. */
	appIdKey?: string;
	privateKeyKey?: string;
	/** Declared env-var name for the app-webhook secret (so the webhook resolver prefers it). */
	webhookSecretKey?: string;
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
		webhookSecretKey: method.webhookSecretKey,
	};
}

/**
 * Build the App install URL from the connector's declared `installUrlTemplate`,
 * substituting `{{app_slug}}` and stamping the CSRF `state`. Null when no template.
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
