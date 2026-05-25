/**
 * Cloud credential resolver for the managed-connector runtime token fetch.
 *
 * A LOCAL Lobu instance with a `managedBy` connection fetches a fresh access
 * token for the user's cloud connection via POST /oauth/connection-token. That
 * call needs a cloud credential carrying the `connections:token` scope.
 *
 * The credential is the USER's OWN device-login — the SAME credential `lobu`
 * itself uses, stored at `~/.config/lobu/credentials.json` by the CLI's
 * `lobu login`. The login token carries `connections:token` (granted at login;
 * see auth/oauth/scopes.ts), so the local resolver reuses it directly — no
 * separate PAT to mint.
 *
 * The v2 credential-store format + refresh grant are shared with the CLI via
 * `@lobu/core` (`credentials.ts`) so the two can't drift; this module only adds
 * the server-side glue: context base-URL resolution and the headless env
 * fallback.
 *
 * Headless / CI fallback: when there is no stored login credential, fall back
 * to the instance-configured `LOBU_CLOUD_PAT` + `LOBU_CLOUD_URL` env.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	credentialCanRefresh,
	credentialNeedsRefresh,
	readContextCredential,
	refreshOAuthToken,
	writeContextCredential,
} from "@lobu/core";
import logger from "../utils/logger";

/**
 * The Lobu config dir (`~/.config/lobu` by default). `LOBU_CONFIG_DIR` overrides
 * it — the CLI uses `~/.config/lobu` directly, but a server-side override lets
 * isolated tests (and a relocated config) point at a throwaway dir instead of
 * the developer's real login.
 */
function configDir(): string {
	const override = process.env.LOBU_CONFIG_DIR?.trim();
	return override || join(homedir(), ".config", "lobu");
}
const DEFAULT_CONTEXT_NAME = "lobu";

const credentialsPath = () => join(configDir(), "credentials.json");
const contextConfigPath = () => join(configDir(), "config.json");

/**
 * A resolved cloud credential: the bearer token to send to the cloud and the
 * cloud's base origin (no trailing path) the token-fetch endpoint lives under.
 */
export interface CloudCredential {
	/** Bearer token (`Bearer <token>`) — a login access token, or LOBU_CLOUD_PAT. */
	token: string;
	/** Cloud base origin, e.g. `https://app.lobu.ai` (no `/api/v1`, no trailing slash). */
	baseUrl: string;
}

// ----- config.json (context URLs; mirrors the CLI's context.ts) -------------

interface StoredContextEntry {
	url?: unknown;
	apiUrl?: unknown;
}

interface StoredContextConfig {
	currentContext?: unknown;
	contexts?: Record<string, StoredContextEntry>;
}

/** Parse config.json once (tolerating a missing/corrupt file). */
async function loadContextConfig(): Promise<StoredContextConfig | null> {
	let raw: string;
	try {
		raw = await readFile(contextConfigPath(), "utf-8");
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw) as StoredContextConfig;
	} catch {
		return null;
	}
}

function activeContextName(
	override: string | undefined,
	config: StoredContextConfig | null,
): string {
	const fromConfig =
		typeof config?.currentContext === "string" && config.currentContext.trim()
			? config.currentContext.trim()
			: undefined;
	return (
		override?.trim() ||
		process.env.LOBU_CONTEXT?.trim() ||
		fromConfig ||
		DEFAULT_CONTEXT_NAME
	);
}

/**
 * The cloud base ORIGIN for a context (the host the OAuth + connection-token
 * endpoints are mounted at the root of). The stored context URL is an API URL
 * (e.g. `https://app.lobu.ai/api/v1`); we want only its origin.
 */
function resolveContextBaseUrl(
	contextName: string,
	config: StoredContextConfig | null,
): string | null {
	const entry = config?.contexts?.[contextName];
	const rawUrl =
		(typeof entry?.url === "string" && entry.url) ||
		(typeof entry?.apiUrl === "string" && entry.apiUrl) ||
		null;
	if (!rawUrl) {
		// The default context always resolves to the canonical cloud origin even
		// when config.json is absent (a fresh install).
		if (contextName === DEFAULT_CONTEXT_NAME) return "https://app.lobu.ai";
		return null;
	}
	try {
		return new URL(rawUrl).origin;
	} catch {
		return null;
	}
}

/**
 * Resolve the cloud credential for the managed-connector token fetch.
 *
 * Order:
 *   1. The stored device-login for the active context (`lobu login`), refreshed
 *      when near expiry. baseUrl from the context URL's origin.
 *   2. Fallback: `LOBU_CLOUD_PAT` + `LOBU_CLOUD_URL` env (headless/CI).
 *
 * Returns null when neither is available (the connection falls through to the
 * local credential path, fail-soft).
 */
export async function resolveCloudCredential(
	contextOverride?: string,
): Promise<CloudCredential | null> {
	const config = await loadContextConfig();
	const contextName = activeContextName(contextOverride, config);

	const stored = await readContextCredential(
		credentialsPath(),
		contextName,
		DEFAULT_CONTEXT_NAME,
	);
	if (stored) {
		let active = stored;
		if (credentialNeedsRefresh(stored) && credentialCanRefresh(stored)) {
			const refreshed = await refreshOAuthToken(
				stored.oauth.tokenEndpoint,
				{
					clientId: stored.oauth.clientId,
					clientSecret: stored.oauth.clientSecret,
				},
				stored.refreshToken,
			);
			if (refreshed) {
				active = {
					...stored,
					accessToken: refreshed.accessToken,
					refreshToken: refreshed.refreshToken ?? stored.refreshToken,
					expiresAt:
						typeof refreshed.expiresIn === "number"
							? Date.now() + refreshed.expiresIn * 1000
							: undefined,
				};
				// Persist the rotated tokens so the CLI sees them — issuers often revoke
				// the old refresh token on use, so a refresh that isn't written back
				// would strand the CLI's stored token. Best-effort: an in-memory fresh
				// token is still usable for this run if the write fails.
				await writeContextCredential(
					credentialsPath(),
					contextName,
					DEFAULT_CONTEXT_NAME,
					active,
				).catch((error) => {
					logger.warn(
						{ error: String(error) },
						"Failed to write back refreshed login credential",
					);
				});
			}
		}
		const baseUrl = resolveContextBaseUrl(contextName, config);
		if (baseUrl) {
			return {
				token: active.accessToken,
				baseUrl: baseUrl.replace(/\/+$/, ""),
			};
		}
	}

	// Headless / CI fallback: the instance-configured cloud PAT + URL.
	const envPat = process.env.LOBU_CLOUD_PAT?.trim();
	const envUrl = process.env.LOBU_CLOUD_URL?.trim();
	if (envPat && envUrl) {
		return { token: envPat, baseUrl: envUrl.replace(/\/+$/, "") };
	}

	return null;
}
