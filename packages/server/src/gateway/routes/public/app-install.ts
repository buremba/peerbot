/**
 * GitHub App install callback (PR5 of the app-installation design,
 * docs/design/app-installation.md §4.4).
 *
 * After a user installs the Lobu GitHub App on their org/repos, GitHub redirects
 * the browser to this callback with `installation_id` + `setup_action`
 * (`install` | `update` | `request`). This route:
 *
 *   1. resolves the active org for the request (session-bound, falling back to a
 *      single-tenant deployment's sole org — mirrors the Slack install flow), then
 *   2. on `install`/`update`: upserts the `app_installations` row for the tenant
 *      tuple (provider=github, provider_instance=cloud, provider_app_id=
 *      GITHUB_APP_ID, external_tenant_id=installation_id, status=active) via the
 *      store's reject/transfer upsert (idempotent + ownership-safe), then
 *   3. creates or relinks a `connections` row for the org's `github` connector
 *      with `config.installation_ref` = the install id (the shape
 *      resolveExecutionAuth reads to mint a tenant-scoped token).
 *
 * `request` (the user asked an org admin to approve the install) writes nothing —
 * there's no installation yet — and just acks.
 *
 * Multi-replica: stateless. Org resolution + the two upserts read/write Postgres
 * only; the store upsert serializes ownership on a Postgres advisory lock +
 * partial unique index, so concurrent callbacks across pods converge to one
 * active owner. The signed `state` is a Postgres-backed nonce (oauth_states),
 * readable/consumable from any replica. No per-pod memo.
 *
 * Cross-org safety (CSRF / cross-tenant): the install URL the UI sends the user
 * to is minted by `GET /github/app/install`, which binds a signed `state` nonce
 * to the INITIATING session's org. GitHub passes `state` through to the callback
 * Setup URL. The callback verifies + consumes that state BEFORE any DB write and
 * binds the install to the org encoded in the state — NOT the ambient callback
 * session. A callback with a missing/invalid/expired `state` is rejected (4xx)
 * with zero mutation, so a phished/forged GET can never plant a connection into
 * a victim's org.
 */

import { Hono } from "hono";
import { createLogger } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import {
	ConnectionSlugConflictError,
	insertConnectionWithSlug,
	resolveNewConnectionSlug,
} from "../../../utils/connections.js";
import {
	getAppInstallationAuthMethods,
	normalizeConnectorAuthSchema,
} from "../../../utils/connector-auth.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { exchangeCodeForTokens } from "../../../connect/oauth-providers.js";
import { createGithubInstallStateStore } from "../../auth/oauth/state-store.js";
import {
	renderOAuthErrorPage,
	renderOAuthSuccessPage,
} from "../../auth/oauth-templates.js";

const logger = createLogger("app-install-routes");

/** The GitHub App connector key whose connection an install links. */
const GITHUB_CONNECTOR_KEY = "github";
const GITHUB_PROVIDER = "github";
const GITHUB_PROVIDER_INSTANCE = "cloud";

/**
 * Build the GitHub App install URL the user is redirected to. `app_slug` is the
 * Lobu GitHub App's slug (the `github.com/apps/<slug>` segment); `state` is the
 * signed nonce the callback verifies. GitHub passes `state` through verbatim to
 * the App's configured Setup URL (our callback), which is how we round-trip the
 * initiating org without trusting the callback session.
 */
export function githubAppInstallUrl(appSlug: string, state: string): string {
	const url = new URL(
		`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`,
	);
	url.searchParams.set("state", state);
	return url.toString();
}

/**
 * Build the GitHub App install callback URL — the OAuth `redirect_uri` passed to
 * the token exchange. It MUST exactly equal the App's registered Callback URL
 * (`<public-gateway-base>/github/app/install/callback`), or GitHub returns
 * `redirect_uri_mismatch` and the exchange yields no token.
 *
 * Prefer the configured public gateway base (mirrors slack.ts's
 * `slackOAuthCallbackUrl`): behind a TLS-terminating ingress `c.req.url` is the
 * INTERNAL pod URL (`http://<pod-host>/…`), which never matches the registered
 * https URL. Fall back to deriving it from the request only when no public base
 * is configured (self-host single-origin), stripping the query.
 */
export function githubInstallCallbackUrl(
	gatewayBaseUrl: string | undefined,
	requestUrl: string,
): string {
	if (gatewayBaseUrl) {
		return `${gatewayBaseUrl.replace(/\/+$/, "")}/github/app/install/callback`;
	}
	const url = new URL(requestUrl);
	url.search = "";
	return url.toString();
}

/**
 * Exchange the OAuth `code` GitHub returns on the install redirect for a USER
 * token, then prove the OAuth'd user is the OWNER of the installation's account:
 *   - the personal-account owner for a User install, or
 *   - an active admin/owner of the org for an Organization install.
 *
 * This closes the cross-tenant token-theft hole AND the subtler membership-≠-
 * admin hole: `GET /user/installations` returns installations the user merely
 * has ACCESS to (org membership / repo collaborator), not ones they administer,
 * so a non-admin member of a victim org could otherwise bind that org's
 * installation into their OWN Lobu org and mint tokens for its repos. We require
 * account ownership, not access.
 *
 * Uses the GitHub *App's* OAuth credentials (GITHUB_APP_CLIENT_ID /
 * GITHUB_APP_CLIENT_SECRET) — NOT the separate "Lobu" login OAuth app
 * (GITHUB_CLIENT_ID/SECRET). Requires the App setting "Request user
 * authorization (OAuth) during installation" ON so `code` is present.
 *
 * Returns a discriminated result so the caller maps each failure to a precise
 * HTTP status WITHOUT mutating any DB state.
 */
export type InstallOwnershipResult =
	| { ok: true }
	| { ok: false; status: 400 | 403 | 503; code: string; message: string };

/** A user-administerable installation's owning account, as GitHub reports it. */
export interface InstallationAccount {
	login: string;
	/** GitHub account type: a personal account or an organization. */
	type: "User" | "Organization" | string;
}

/** Default GitHub user-token OAuth exchange (the App's install-time OAuth). */
async function defaultExchangeInstallOAuthCode(params: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<string | null> {
	const tokens = await exchangeCodeForTokens({
		provider: "github",
		code: params.code,
		clientId: params.clientId,
		clientSecret: params.clientSecret,
		redirectUri: params.redirectUri,
	});
	return tokens?.accessToken ?? null;
}

/** Authenticated GitHub GET → parsed JSON, or null on any HTTP/parse failure. */
async function githubUserGet<T>(
	url: string,
	userToken: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${userToken}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "lobu",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!res.ok) return { ok: false, status: res.status };
	const data = (await res.json()) as T;
	return { ok: true, data };
}

/**
 * Find the account that owns the installation the user is trying to link, among
 * the installations the user can administer (`GET /user/installations`,
 * paginated). Returns the account `{login, type}` for the matching id, `null`
 * when the id is not in the user's set ("not owned"), or `undefined` on an HTTP
 * failure (the caller treats that as "cannot verify" → reject, no mutation).
 */
async function defaultFetchInstallationAccount(
	userToken: string,
	installationId: number,
): Promise<InstallationAccount | null | undefined> {
	const perPage = 100;
	let page = 1;
	let total = Number.POSITIVE_INFINITY;
	let seen = 0;
	const MAX_PAGES = 100; // page cap so a hostile total_count can't loop forever
	while (seen < total && page <= MAX_PAGES) {
		const result = await githubUserGet<{
			total_count?: number;
			installations?: Array<{ id?: number; account?: InstallationAccount }>;
		}>(
			`https://api.github.com/user/installations?per_page=${perPage}&page=${page}`,
			userToken,
		);
		if (!result.ok) {
			logger.warn(
				{ status: result.status, page },
				"GitHub /user/installations returned non-OK while verifying install ownership",
			);
			return undefined;
		}
		const body = result.data;
		total = typeof body.total_count === "number" ? body.total_count : seen;
		const installs = Array.isArray(body.installations) ? body.installations : [];
		if (installs.length === 0) break;
		for (const inst of installs) {
			seen += 1;
			if (inst.id === installationId && inst.account?.login) {
				return { login: inst.account.login, type: inst.account.type };
			}
		}
		page += 1;
	}
	return null;
}

/** The authenticated user's GitHub login (`GET /user`), or undefined on failure. */
async function defaultFetchAuthedUserLogin(
	userToken: string,
): Promise<string | undefined> {
	const result = await githubUserGet<{ login?: string }>(
		"https://api.github.com/user",
		userToken,
	);
	if (!result.ok || typeof result.data.login !== "string") {
		if (!result.ok) {
			logger.warn(
				{ status: result.status },
				"GitHub /user returned non-OK while verifying install ownership",
			);
		}
		return undefined;
	}
	return result.data.login;
}

/**
 * The authenticated user's membership role in `org`
 * (`GET /user/memberships/orgs/{org}` — returns the CALLER's own membership, so
 * the user token suffices). Returns `{ state, role }`, or undefined on failure
 * (treated as "cannot verify"). A 404/403 (not a member) is surfaced as a
 * defined value with empty fields so the caller maps it to "not admin", not
 * "cannot verify".
 */
async function defaultFetchOrgMembershipRole(
	userToken: string,
	org: string,
): Promise<{ state: string; role: string } | undefined> {
	const res = await fetch(
		`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
		{
			headers: {
				Authorization: `Bearer ${userToken}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "lobu",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	// 403/404 = the user is not a member of that org → definitively "not admin".
	if (res.status === 403 || res.status === 404) {
		return { state: "none", role: "none" };
	}
	if (!res.ok) {
		logger.warn(
			{ status: res.status, org },
			"GitHub /user/memberships/orgs returned non-OK while verifying install admin",
		);
		return undefined;
	}
	const body = (await res.json()) as { state?: string; role?: string };
	return { state: body.state ?? "", role: body.role ?? "" };
}

export type GithubSetupAction = "install" | "update" | "request";

function parseSetupAction(raw: string | undefined): GithubSetupAction | null {
	if (raw === "install" || raw === "update" || raw === "request") return raw;
	return null;
}

/** Result of {@link linkGithubAppInstallation}. */
export interface LinkGithubInstallationResult {
	installId: number;
	connectionId: number;
	/** True when a new connection row was created (vs an existing one relinked). */
	createdConnection: boolean;
	accountLogin: string | null;
}

/**
 * Upsert the `app_installations` row for a GitHub App install and create/relink
 * the org's `github` connector connection so its `config.installation_ref` points
 * at the install. Pure of HTTP — the route is a thin wrapper, and tests drive
 * this directly. Idempotent: re-running for the same (org, installation_id)
 * refreshes the install (reject/transfer upsert) and reuses an existing linked
 * connection instead of creating a duplicate.
 */
export async function linkGithubAppInstallation(params: {
	organizationId: string;
	installationId: string;
	store: AppInstallationStore;
	/** GitHub App id (provider_app_id); defaults to GITHUB_APP_ID env. */
	providerAppId: string;
	/** Account/metadata stamped onto the install row (account login, etc.). */
	metadata?: Record<string, unknown>;
	createdBy?: string | null;
}): Promise<LinkGithubInstallationResult> {
	const sql = getDb();
	const accountLogin =
		typeof params.metadata?.account_login === "string"
			? (params.metadata.account_login as string)
			: null;

	// 1. Upsert the install row (reject/transfer ownership on the active-tenant
	//    invariant — same-org reinstall refreshes in place, different-org install
	//    transfers ownership). auth_profile_id stays null: the GitHub App
	//    credential (app id + private key) lives in gateway env, not auth_profiles.
	const install = await params.store.upsert({
		organizationId: params.organizationId,
		provider: GITHUB_PROVIDER,
		providerInstance: GITHUB_PROVIDER_INSTANCE,
		providerAppId: params.providerAppId,
		externalTenantId: params.installationId,
		status: "active",
		metadata: params.metadata ?? {},
	});

	// 2 + 3. Find-or-create the connection bound to this install, serialized by a
	//    transaction-scoped advisory lock keyed on (org, install.id). Without it,
	//    two concurrent callbacks for the same install both SELECT-miss and both
	//    INSERT → duplicate connections. The lock lives in Postgres (not memory),
	//    so it serializes across replicas; mirrors the app-installation store's
	//    pg_advisory_xact_lock convergence pattern. The install row upsert (step 1)
	//    has its own lock in the store, so it stays outside this transaction.
	const connectionLockTag = `github_app_install_connection:${params.organizationId}:${install.id}`;
	return sql.begin(async (tx) => {
		await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
			connectionLockTag,
		]);

		// Find an existing connection already bound to this install (idempotent
		// re-install / callback retry). The install id is the stable key; match on
		// config.installation_ref. Read under the lock so a racing callback that
		// already created the row is seen here instead of double-inserted.
		const existing = (await tx`
			SELECT id, config
			FROM connections
			WHERE organization_id = ${params.organizationId}
				AND connector_key = ${GITHUB_CONNECTOR_KEY}
				AND deleted_at IS NULL
				AND (
					config ->> 'installation_ref' = ${String(install.id)}
					OR config ->> 'installation_ref' = ${String(params.installationId)}
				)
			ORDER BY id ASC
			LIMIT 1
		`) as unknown as Array<{
			id: number;
			config: Record<string, unknown> | null;
		}>;

		if (existing.length > 0) {
			const connectionId = Number(existing[0].id);
			const mergedConfig = {
				...(existing[0].config ?? {}),
				installation_ref: install.id,
			};
			await tx`
				UPDATE connections
				SET config = ${tx.json(mergedConfig)},
					status = 'active',
					updated_at = NOW()
				WHERE id = ${connectionId}
					AND organization_id = ${params.organizationId}
			`;
			return {
				installId: install.id,
				connectionId,
				createdConnection: false,
				accountLogin,
			};
		}

		// No existing linked connection — create one bound to the install. The
		// config carries ONLY installation_ref (no repo/org target), so the
		// connect-flow webhook gate (connectionWantsWebhook) never fires: inbound
		// deliveries route through the shared /app-webhooks/github endpoint, and
		// resolveExecutionAuth mints a tenant-scoped token from the install.
		const displayName = accountLogin
			? `GitHub (${accountLogin})`
			: "GitHub App";
		const slugResult = await resolveNewConnectionSlug({
			organizationId: params.organizationId,
			connectorKey: GITHUB_CONNECTOR_KEY,
			displayName,
			db: tx,
		});
		if ("error" in slugResult) {
			throw new Error(slugResult.error);
		}

		const inserted = await insertConnectionWithSlug<
			Array<{ id: number; slug: string }>
		>({
			organizationId: params.organizationId,
			connectorKey: GITHUB_CONNECTOR_KEY,
			displayName,
			initialSlug: slugResult.slug,
			explicit: false,
			db: tx,
			doInsert: (slug) => tx`
				INSERT INTO connections (
					organization_id, connector_key, slug, display_name, status, config, created_by
				) VALUES (
					${params.organizationId}, ${GITHUB_CONNECTOR_KEY}, ${slug}, ${displayName},
					'active', ${tx.json({ installation_ref: install.id })}, ${params.createdBy ?? null}
				)
				RETURNING id, slug
			`,
		}).catch((err) => {
			if (err instanceof ConnectionSlugConflictError) throw new Error(err.message);
			throw err;
		});

		return {
			installId: install.id,
			connectionId: Number(inserted[0].id),
			createdConnection: true,
			accountLogin,
		};
	});
}

/** Dependencies the install routes need (injected for testability). */
export interface AppInstallRouterDeps {
	installationStore: AppInstallationStore;
	/** Resolve the active org for the request (session-bound + single-tenant). */
	resolveInstallOrgId(c: import("hono").Context): Promise<string | null>;
	/**
	 * The public gateway base URL (e.g. `https://app.lobu.ai`) used to build the
	 * OAuth `redirect_uri`, which must equal the App's registered Callback URL.
	 * Undefined falls back to the request origin (self-host single-origin).
	 */
	getPublicGatewayUrl?(): string | undefined;
	/**
	 * Exchange the install-redirect OAuth `code` for a GitHub USER token.
	 * Injected so tests can mock the exchange (never hits real GitHub). Returns
	 * null on a failed exchange. Defaults to the App's install-time OAuth.
	 */
	exchangeInstallOAuthCode?(params: {
		code: string;
		clientId: string;
		clientSecret: string;
		redirectUri: string;
	}): Promise<string | null>;
	/**
	 * Resolve the owning account of the installation the user is linking, among
	 * the installations the user can administer (`GET /user/installations`).
	 * `{login,type}` when found, `null` when the id is not in the user's set,
	 * `undefined` on an HTTP failure ("cannot verify" → reject). Injected so
	 * tests can mock GitHub.
	 */
	fetchInstallationAccount?(
		userToken: string,
		installationId: number,
	): Promise<InstallationAccount | null | undefined>;
	/** The authed user's GitHub login (`GET /user`); undefined on failure. */
	fetchAuthedUserLogin?(userToken: string): Promise<string | undefined>;
	/**
	 * The authed user's membership in `org` (`GET /user/memberships/orgs/{org}`);
	 * undefined on failure. A non-member is reported as a defined value with
	 * non-admin fields, not undefined.
	 */
	fetchOrgMembershipRole?(
		userToken: string,
		org: string,
	): Promise<{ state: string; role: string } | undefined>;
}

/**
 * Verify the OAuth'd user is the OWNER of the installation's account (ownership,
 * not mere access). Performs: code exchange → resolve the installation's owning
 * account from the user's administerable installations → authorize by account
 * type (personal-account login match, or active org admin/owner). Pure of HTTP
 * routing and of any DB mutation — the caller only binds when this returns
 * `{ ok: true }`.
 */
async function verifyInstallationOwnership(params: {
	code: string | undefined;
	installationId: number;
	redirectUri: string;
	exchange: NonNullable<AppInstallRouterDeps["exchangeInstallOAuthCode"]>;
	fetchAccount: NonNullable<AppInstallRouterDeps["fetchInstallationAccount"]>;
	fetchLogin: NonNullable<AppInstallRouterDeps["fetchAuthedUserLogin"]>;
	fetchMembership: NonNullable<AppInstallRouterDeps["fetchOrgMembershipRole"]>;
}): Promise<InstallOwnershipResult> {
	// The App's OAuth creds (NOT the Lobu login OAuth app). Fail safe if unset.
	const clientId = process.env.GITHUB_APP_CLIENT_ID;
	const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		return {
			ok: false,
			status: 503,
			code: "github_app_oauth_not_configured",
			message:
				"GitHub App user-authorization is not configured on this gateway (set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET, and enable 'Request user authorization (OAuth) during installation' on the App).",
		};
	}

	// No code → we cannot prove the caller owns the installation. Reject.
	if (!params.code || !params.code.trim()) {
		return {
			ok: false,
			status: 400,
			code: "missing_oauth_code",
			message:
				"This GitHub install callback is missing the OAuth code needed to verify you own the installation. Enable 'Request user authorization (OAuth) during installation' on the App and try again.",
		};
	}

	const userToken = await params.exchange({
		code: params.code.trim(),
		clientId,
		clientSecret,
		redirectUri: params.redirectUri,
	});
	if (!userToken) {
		return {
			ok: false,
			status: 403,
			code: "oauth_exchange_failed",
			message:
				"We couldn't verify your GitHub identity for this install. Start the install again from your Lobu dashboard.",
		};
	}

	// 1. Resolve the installation's owning account among the user's
	//    administerable installations. undefined = cannot verify; null = the user
	//    has no access to this installation at all → not owned.
	const account = await params.fetchAccount(userToken, params.installationId);
	if (account === undefined) {
		return {
			ok: false,
			status: 403,
			code: "ownership_check_unavailable",
			message:
				"We couldn't confirm you own this GitHub installation. Try again in a moment.",
		};
	}
	if (account === null) {
		return {
			ok: false,
			status: 403,
			code: "installation_not_owned",
			message:
				"This GitHub installation does not belong to your GitHub account. Install the Lobu App on an organization you administer.",
		};
	}

	// 2. The authed user's login (needed for the personal-account match).
	const authedLogin = await params.fetchLogin(userToken);
	if (!authedLogin) {
		return {
			ok: false,
			status: 403,
			code: "ownership_check_unavailable",
			message:
				"We couldn't confirm your GitHub identity for this install. Try again in a moment.",
		};
	}

	// 3. Authorize by account type. Access ≠ ownership: a non-admin org member
	//    appears in /user/installations but must NOT be able to bind the org's
	//    installation. Require the personal-account owner, or an active org admin.
	if (account.type === "Organization") {
		const membership = await params.fetchMembership(userToken, account.login);
		if (membership === undefined) {
			return {
				ok: false,
				status: 403,
				code: "ownership_check_unavailable",
				message:
					"We couldn't confirm your role in this GitHub organization. Try again in a moment.",
			};
		}
		if (membership.state !== "active" || membership.role !== "admin") {
			return {
				ok: false,
				status: 403,
				code: "installation_not_admin",
				message:
					"You must be an admin of this GitHub organization to connect its installation to Lobu.",
			};
		}
		return { ok: true };
	}

	// Personal-account install: the OAuth'd user must BE the account owner.
	if (authedLogin.toLowerCase() !== account.login.toLowerCase()) {
		return {
			ok: false,
			status: 403,
			code: "installation_not_owned",
			message:
				"This GitHub installation belongs to a different account. Install the Lobu App from the account that owns it.",
		};
	}
	return { ok: true };
}

/**
 * Build the GitHub App install routes.
 *
 * Mounted at the gateway root like the Slack routes (`app.route("", ...)`), so
 * the callback lives at `<gateway-base>/github/app/install/callback`.
 */
export function createAppInstallRoutes(deps: AppInstallRouterDeps): Hono {
	const router = new Hono();

	// Start of the GitHub App install flow. Binds a signed `state` nonce to the
	// initiating session's org and redirects to GitHub's install page. The
	// callback verifies that state before mutating anything — this is the CSRF /
	// cross-tenant guard (the callback is otherwise a public, unauthenticated GET).
	router.get("/github/app/install", async (c) => {
		const appSlug = process.env.GITHUB_APP_SLUG;
		if (!process.env.GITHUB_APP_ID || !appSlug) {
			return c.html(
				renderOAuthErrorPage(
					"github_app_not_configured",
					"The Lobu GitHub App is not configured on this gateway (set GITHUB_APP_ID and GITHUB_APP_SLUG).",
				),
				503,
			);
		}

		// Bind the install to the initiating session's active org (single-tenant
		// fallback for self-host). Without this the resulting state would carry no
		// authoritative org and the callback couldn't tell which tenant initiated.
		const orgId = await deps.resolveInstallOrgId(c);
		if (!orgId) {
			return c.html(
				renderOAuthErrorPage(
					"unauthorized",
					"Sign in to your organization before installing the GitHub App.",
				),
				401,
			);
		}

		const stateStore = createGithubInstallStateStore();
		const state = await stateStore.create({ organizationId: orgId });
		return c.redirect(githubAppInstallUrl(appSlug, state), 302);
	});

	router.get("/github/app/install/callback", async (c) => {
		const appId = process.env.GITHUB_APP_ID;
		if (!appId) {
			return c.html(
				renderOAuthErrorPage(
					"github_app_not_configured",
					"The Lobu GitHub App is not configured on this gateway (GITHUB_APP_ID unset).",
				),
				503,
			);
		}

		const setupAction = parseSetupAction(c.req.query("setup_action"));
		const installationIdRaw = c.req.query("installation_id");

		// `request`: the user asked an org admin to approve the install — there is
		// no installation to record yet. Ack and tell them what happens next.
		if (setupAction === "request") {
			return c.html(
				renderOAuthSuccessPage("GitHub", undefined, {
					title: "Install requested",
					description:
						"Your GitHub organization admin needs to approve the Lobu App install. We'll wire it up automatically once they do.",
				}),
			);
		}

		// setup_action must be one of install|update|request (request handled above).
		// A missing/unrecognized value must NOT be treated like install/update —
		// reject (400) before any state validation or mutation. parseSetupAction
		// returns null for both missing and garbage.
		if (setupAction === null) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_request",
					"The GitHub install callback has a missing or invalid setup_action (expected install, update, or request).",
				),
				400,
			);
		}

		if (!installationIdRaw || !installationIdRaw.trim()) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_request",
					"The GitHub install callback is missing installation_id.",
				),
				400,
			);
		}

		// CSRF / cross-tenant guard. The callback is a public, unauthenticated GET,
		// so the org MUST come from the signed `state` minted by GET
		// /github/app/install — NOT the ambient callback session. A missing/invalid/
		// expired state rejects (4xx) with zero mutation, so a forged GET can't plant
		// a connection into a victim's org.
		//
		// We PEEK (non-destructive) first, run the side-channel checks (session-org
		// match, ownership), and only CONSUME the single-use nonce right before the
		// write — mirroring slack.ts. That way a benign mismatch or a transient
		// ownership-check failure doesn't burn a still-valid install link.
		const stateParam = c.req.query("state");
		if (!stateParam) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_state",
					"This GitHub install callback is missing its security token. Start the install from your Lobu dashboard.",
				),
				400,
			);
		}
		const stateStore = createGithubInstallStateStore();
		const installState = await stateStore.peek(stateParam);
		if (!installState) {
			logger.warn(
				{ installation_id: installationIdRaw },
				"Rejecting GitHub install callback: missing/invalid/expired state",
			);
			return c.html(
				renderOAuthErrorPage(
					"invalid_state",
					"This GitHub install link is invalid or has expired. Start the install again from your Lobu dashboard.",
				),
				400,
			);
		}

		// Confused-deputy / installation-fixation guard. The signed state proves
		// WHICH org MINTED the link, but not that the BROWSER completing the callback
		// belongs to that org. Without this, an attacker (org A) could mint a link,
		// send the genuine github.com/apps/<slug>/installations/new?state=S to a
		// victim, the victim installs the App on THEIR org V and passes the ownership
		// check (they own V) — and V's installation lands in the attacker's org A.
		// Require the completing session's org to equal the state's org (mirrors
		// slack.ts). The legit admin completes in the same session (A === A).
		const callbackOrgId = await deps.resolveInstallOrgId(c);
		if (!callbackOrgId || callbackOrgId !== installState.organizationId) {
			logger.warn(
				{
					state_org: installState.organizationId,
					callback_org: callbackOrgId ?? null,
					installation_id: installationIdRaw,
				},
				"Rejecting GitHub install callback: completing session org does not match install state",
			);
			return c.html(
				renderOAuthErrorPage(
					"org_mismatch",
					"This GitHub install link was started in a different organization. Sign in to that organization and try again.",
				),
				403,
			);
		}
		// Bind to the org encoded in the verified state (== callbackOrgId).
		const orgId = installState.organizationId;

		// Ownership proof. The signed state proves WHICH org initiated, but NOT that
		// the caller OWNS the supplied installation_id (an enumerable integer).
		// Without this, an attacker with their own valid state could pass a victim's
		// installation_id and bind/transfer the victim's GitHub installation — and
		// its minted repo tokens — into the attacker's org. And mere membership is
		// not enough: a non-admin org member can SEE the org's installation, so we
		// require account OWNERSHIP (personal-account owner, or active org admin).
		// Prove it via OAuth-during-install — ALL of this runs BEFORE any DB write,
		// so every failure returns 4xx/503 with zero mutation.
		const installationId = Number(installationIdRaw.trim());
		if (!Number.isInteger(installationId) || installationId <= 0) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_request",
					"The GitHub install callback carried an invalid installation_id.",
				),
				400,
			);
		}
		// The redirect_uri must EXACTLY equal the App's registered Callback URL.
		// Derive it from the public gateway base — NOT c.req.url, which behind the
		// prod TLS-terminating ingress is the internal pod URL and would trigger
		// GitHub `redirect_uri_mismatch` on every legit install. Falls back to the
		// request origin only on self-host (no public base configured).
		const callbackUrl = githubInstallCallbackUrl(
			deps.getPublicGatewayUrl?.(),
			c.req.url,
		);
		const ownership = await verifyInstallationOwnership({
			code: c.req.query("code"),
			installationId,
			redirectUri: callbackUrl,
			exchange: deps.exchangeInstallOAuthCode ?? defaultExchangeInstallOAuthCode,
			fetchAccount:
				deps.fetchInstallationAccount ?? defaultFetchInstallationAccount,
			fetchLogin: deps.fetchAuthedUserLogin ?? defaultFetchAuthedUserLogin,
			fetchMembership:
				deps.fetchOrgMembershipRole ?? defaultFetchOrgMembershipRole,
		});
		if (!ownership.ok) {
			logger.warn(
				{
					organization_id: orgId,
					installation_id: installationIdRaw,
					reason: ownership.code,
				},
				"Rejecting GitHub install callback: installation ownership not verified",
			);
			return c.html(
				renderOAuthErrorPage(ownership.code, ownership.message),
				ownership.status,
			);
		}

		// Guard: the org must actually have the github connector definition with an
		// app_installation auth method, otherwise there's nothing to link the
		// install to (and a connection would dangle).
		const sql = getDb();
		const defRows = (await sql`
			SELECT auth_schema FROM connector_definitions
			WHERE key = ${GITHUB_CONNECTOR_KEY}
				AND organization_id = ${orgId}
				AND status = 'active'
			LIMIT 1
		`) as unknown as Array<{ auth_schema: unknown }>;
		const hasAppInstallMethod =
			defRows.length > 0 &&
			getAppInstallationAuthMethods(normalizeConnectorAuthSchema(defRows[0].auth_schema))
				.length > 0;
		if (!hasAppInstallMethod) {
			return c.html(
				renderOAuthErrorPage(
					"github_connector_missing",
					"The GitHub connector is not installed for this organization, or it does not support App installs. Add the GitHub connector and try again.",
				),
				400,
			);
		}

		// All side-channel checks passed — atomically consume the single-use nonce
		// now (right before the write) so the link can't be replayed. If the row is
		// gone between peek and consume (a racing tab/redelivery already consumed
		// it), fall through to the same invalid_state response — no double-bind.
		const consumed = await stateStore.consume(stateParam);
		if (!consumed) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_state",
					"This GitHub install link is invalid or has expired. Start the install again from your Lobu dashboard.",
				),
				400,
			);
		}

		try {
			const result = await linkGithubAppInstallation({
				organizationId: orgId,
				installationId: installationIdRaw.trim(),
				store: deps.installationStore,
				providerAppId: appId,
				metadata: buildInstallMetadata(c),
			});
			logger.info(
				{
					organization_id: orgId,
					install_id: result.installId,
					connection_id: result.connectionId,
					created_connection: result.createdConnection,
					setup_action: setupAction,
				},
				"GitHub App install linked",
			);
			return c.html(
				renderOAuthSuccessPage(result.accountLogin ?? "GitHub", undefined, {
					title: "GitHub App installed",
					description:
						"Your GitHub organization is connected to Lobu. Issues, PRs, and discussions will sync, and agents can act on them.",
				}),
			);
		} catch (error) {
			logger.error(
				{
					organization_id: orgId,
					installation_id: installationIdRaw,
					error: error instanceof Error ? error.message : String(error),
				},
				"GitHub App install callback failed",
			);
			return c.html(
				renderOAuthErrorPage(
					"github_install_failed",
					error instanceof Error ? error.message : "GitHub App install failed.",
				),
				500,
			);
		}
	});

	return router;
}

/** Pull the account login GitHub passes (when present) into install metadata. */
function buildInstallMetadata(c: import("hono").Context): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	// GitHub doesn't pass the account login on the install redirect, but a
	// future state-bound flow / the owletto UI can; accept it if present.
	const accountLogin = c.req.query("account_login") || c.req.query("login");
	if (accountLogin) metadata.account_login = accountLogin;
	const setupAction = c.req.query("setup_action");
	if (setupAction) metadata.setup_action = setupAction;
	return metadata;
}
