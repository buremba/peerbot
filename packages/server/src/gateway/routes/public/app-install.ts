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

	// 2. Find an existing connection in this org for the github connector already
	//    bound to this install (idempotent re-install / callback retry). The
	//    install id is the stable key; match on config.installation_ref.
	const existing = (await sql`
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
	`) as unknown as Array<{ id: number; config: Record<string, unknown> | null }>;

	if (existing.length > 0) {
		const connectionId = Number(existing[0].id);
		const mergedConfig = {
			...(existing[0].config ?? {}),
			installation_ref: install.id,
		};
		await sql`
			UPDATE connections
			SET config = ${sql.json(mergedConfig)},
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

	// 3. No existing linked connection — create one bound to the install. The
	//    config carries ONLY installation_ref (no repo/org target), so the
	//    connect-flow webhook gate (connectionWantsWebhook) never fires: inbound
	//    deliveries route through the shared /app-webhooks/github endpoint, and
	//    resolveExecutionAuth mints a tenant-scoped token from the install.
	const displayName = accountLogin
		? `GitHub (${accountLogin})`
		: "GitHub App";
	const slugResult = await resolveNewConnectionSlug({
		organizationId: params.organizationId,
		connectorKey: GITHUB_CONNECTOR_KEY,
		displayName,
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
		doInsert: (slug) => sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config, created_by
			) VALUES (
				${params.organizationId}, ${GITHUB_CONNECTOR_KEY}, ${slug}, ${displayName},
				'active', ${sql.json({ installation_ref: install.id })}, ${params.createdBy ?? null}
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
}

/** Dependencies the install routes need (injected for testability). */
export interface AppInstallRouterDeps {
	installationStore: AppInstallationStore;
	/** Resolve the active org for the request (session-bound + single-tenant). */
	resolveInstallOrgId(c: import("hono").Context): Promise<string | null>;
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
		// /github/app/install — NOT the ambient callback session. Verify + consume
		// the state BEFORE any DB write: a missing/invalid/expired state rejects
		// (4xx) with zero mutation, so a forged GET can't plant a connection into a
		// victim's org. `consume` is an atomic DELETE … RETURNING (single-use,
		// replay-safe across replicas).
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
		const installState = await stateStore.consume(stateParam);
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
		// Bind to the org encoded in the verified state — never the callback session.
		const orgId = installState.organizationId;

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
