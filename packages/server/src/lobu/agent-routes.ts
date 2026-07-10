/**
 * Agent CRUD routes for the embedded Lobu gateway.
 *
 * All routes are org-scoped via mcpAuth middleware and orgContext.
 */

import { type AuthProfile, encrypt, isSdkCompat } from "@lobu/core";
import { Hono } from "hono";
import { ensureBuilderAgent } from "../auth/builder-provisioning";
import { mcpAuth } from "../auth/middleware";
import { getDb } from "../db/client";
import { grantStrategyFor } from "../gateway/auth/oauth/grant-strategy";
import {
	getOAuthProviderConfig,
	getOAuthProviderConfigs,
	type OAuthProviderConfig,
} from "../gateway/auth/oauth/providers";
import { isUnresolvedModelRef } from "../gateway/auth/model-sentinel";
import { buildProviderCatalog } from "../gateway/auth/provider-catalog";
import { createAuthProfileLabel } from "../gateway/auth/settings/auth-profiles-manager";
import { orgBucketAgentId } from "../gateway/auth/settings/user-auth-profile-store";
import { getModelProviderModules } from "../gateway/modules/module-system";
import {
	ProviderRegistryService,
	resolveProviderRegistryPath,
} from "../gateway/services/provider-registry-service";
import type { Env } from "../index";
import { getApplyContext } from "../utils/apply-context";
import { recordConfigChangeEvent } from "../utils/insert-event";
import logger from "../utils/logger";
import { generateCodeVerifier } from "../utils/pkce";
import { countRuntimeMessagingClientsByAgent } from "./client-routes";
import { getLobuCoreServices } from "./gateway";
import { orgContext } from "./stores/org-context";
import {
	AGENT_ID_PATTERN,
	createPostgresAgentConfigStore,
} from "./stores/postgres-stores";
import {
	createInferenceProvider,
	ensureOAuthInferenceProvider,
	type InferenceCapabilities,
	type InferenceCapabilityBlock,
	isInferenceModality,
	isValidInferenceProviderSlug,
	listInferenceProviders,
	providerOrgSecretName,
	rotateInferenceProviderKey,
	setInferenceProviderDefault,
	softDeleteInferenceProvider,
	updateInferenceProviderCapabilities,
	updateInferenceProviderCoreFields,
	validateCapabilityBlock,
} from "./stores/provider-secrets";

const routes = new Hono<{ Bindings: Env }>();

/**
 * Coerce an `array_agg` result into a real `string[]`. With the `::text` cast
 * the driver returns a JS array, but if some schema still hands back a raw
 * Postgres array literal (`'{telegram,slack}'`) we parse it rather than letting
 * a string leak to the UI, where `.map` would throw.
 */
function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") {
		const inner = value.replace(/^\{/, "").replace(/\}$/, "").trim();
		if (!inner) return [];
		return inner.split(",").map((s) => s.replace(/^"|"$/g, "").trim());
	}
	return [];
}

const configStore = createPostgresAgentConfigStore();

function buildRequestBaseUrls(c: any, agentId: string, providerId: string) {
	const url = new URL(c.req.url);
	const apiIndex = url.pathname.indexOf("/api/");
	const mountPath = apiIndex >= 0 ? url.pathname.slice(0, apiIndex) : "";
	const origin = url.origin;
	const orgSlug = c.req.param("orgSlug") as string | undefined;
	const encodedAgent = encodeURIComponent(agentId);
	return {
		proxyBaseUrl: `${origin}${mountPath}/api/proxy`,
		expectedProxyUrl: `${origin}${mountPath}/api/proxy/${providerId}/a/${encodedAgent}`,
		settingsUrl: orgSlug
			? `${origin}${mountPath}/${encodeURIComponent(orgSlug)}/agents/${encodedAgent}/settings`
			: `${origin}${mountPath}/agents/${encodedAgent}/settings`,
	};
}

/**
 * Validate a PATCHed `models` list. Every entry must be an explicit
 * `<slug>/<model>` ref (no bare model ids, no `auto` in either position) whose
 * slug resolves at the ORG level: a registry provider module OR one of the
 * org's `inference_providers` rows. Validating against the org-level set (not
 * the agent's own list) is what makes the write atomic — an entry can never
 * dangle on "the agent hasn't installed that provider yet", because the list
 * being written IS the install.
 *
 * Returns `{ error }` JSON on the first invalid entry, or null when valid.
 */
/**
 * Legacy agent-settings model fields removed in the atomic cutover. A PATCH
 * carrying any of these is rejected (see the config route) rather than silently
 * dropped — silently dropping would reset a RESTRICTED agent to `models = NULL`
 * (allow-all), widening access. Exported for the route guard + its test.
 */
export const LEGACY_MODEL_FIELDS = ["defaultModel", "installedProviders"] as const;

export async function validateModelsUpdate(params: {
	models: unknown;
	organizationId: string;
	agentId: string;
	c: any;
}): Promise<Record<string, unknown> | null> {
	if (
		!Array.isArray(params.models) ||
		params.models.some((m) => typeof m !== "string")
	) {
		return {
			error: "invalid_models",
			error_description: "models must be an array of strings",
		};
	}

	const entries = (params.models as string[]).map((m) => m.trim());
	const invalid = (ref: string, why: string): Record<string, unknown> => ({
		error: "invalid_model_ref",
		error_description: `Invalid models entry "${ref}": ${why}. Every entry must be an explicit "<provider>/<model>" ref.`,
		model: ref,
	});
	for (const ref of entries) {
		// A `<slug>/__unresolved__` restriction sentinel is a deliberate,
		// non-routable placeholder (emitted by the migration/provisioning for a
		// "provider intended, no concrete model" agent). It must round-trip
		// through PATCH — e.g. editing soulMd on a migrated legacy agent PATCHes
		// the full settings incl. `models`, which may contain a sentinel — so
		// accept it as valid without the model-shape / org-provider checks below.
		if (isUnresolvedModelRef(ref)) continue;
		const slash = ref.indexOf("/");
		if (!ref || slash <= 0 || slash === ref.length - 1) {
			return invalid(ref, "expected a provider-qualified model ref");
		}
		if (ref.slice(slash + 1).trim() === "auto") {
			return invalid(ref, '"auto" is not a model; pick a concrete model');
		}
	}

	// Org-level slug resolution: registry modules ∪ the org's provider rows.
	const orgSlugs = new Set<string>(
		getModelProviderModules().map((m) => m.providerId),
	);
	for (const row of await listInferenceProviders(params.organizationId)) {
		orgSlugs.add(row.slug);
	}
	for (const ref of entries) {
		// Sentinels are accepted above; skip the org-provider existence check
		// (their slug — e.g. `legacy` — is intentionally not a real provider).
		if (isUnresolvedModelRef(ref)) continue;
		const providerId = ref.slice(0, ref.indexOf("/"));
		if (orgSlugs.has(providerId)) continue;
		const urls = buildRequestBaseUrls(params.c, params.agentId, providerId);
		return {
			error: "model_provider_not_connected",
			error_description:
				`The model "${ref}" uses provider "${providerId}", but that provider does not exist in this organization. ` +
				`Add it under Providers (or fix the slug), then save again. ` +
				`Expected gateway proxy URL after setup: ${urls.expectedProxyUrl}`,
			model: ref,
			provider: providerId,
			settingsUrl: urls.settingsUrl,
			expectedProxyUrl: urls.expectedProxyUrl,
		};
	}

	return null;
}

// ── Route-level middleware ───────────────────────────────────────────────────
//
// Every agent route is org-scoped: it requires a valid auth context (`mcpAuth`)
// and runs inside an `orgContext` keyed on the caller's organization. Both used
// to be repeated per handler (`routes.get('/', mcpAuth, …)` plus a
// `withOrg(c, …)` wrapper); they're applied once here. Registered before any
// route handler below so they wrap all of them.

routes.use("*", mcpAuth);

routes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

/**
 * Admin-tier auth gate.
 *
 * Admin-tier routes (agent CRUD, connection mutations, anything called by
 * `lobu apply`) accept either:
 *   - a better-auth session (`authSource === 'session'`), or
 *   - a PAT/OAuth bearer that carries the `mcp:admin` scope.
 *
 * Read-only routes (list, get) keep using `mcpAuth` alone — a `mcp:read` PAT
 * is fine for those.
 *
 * Returns a Response when the request must be rejected; returns null when the
 * caller should proceed.
 */
export function requireSessionOrAdminPat(c: any): Response | null {
	const authSource = c.get("authSource") as "session" | "pat" | "oauth" | null;

	if (authSource === "session") {
		return null;
	}

	if (authSource === "pat" || authSource === "oauth") {
		const authInfo = c.get("mcpAuthInfo");
		const scopes: string[] = Array.isArray(authInfo?.scopes)
			? authInfo.scopes
			: [];
		if (scopes.includes("mcp:admin")) {
			return null;
		}
		return c.json(
			{
				error: "forbidden",
				error_description:
					"This route requires a web session or a token with mcp:admin scope.",
			},
			403,
		);
	}

	return c.json({ error: "Authentication required" }, 401);
}

/**
 * Emit a config-audit event for a mutation handled in this file. Thin wrapper
 * binding `recordConfigChangeEvent` (fire-and-forget, redacts internally) to
 * the request's apply/actor context.
 */
function emitConfigChange(
	c: any,
	params: {
		resourceKind: Parameters<typeof recordConfigChangeEvent>[0]["resourceKind"];
		resourceId: string | number;
		op: "created" | "updated" | "deleted";
		summary: string;
		state: Record<string, unknown> | null;
		changedFields?: string[];
	},
): void {
	const applyCtx = getApplyContext(c);
	recordConfigChangeEvent({
		organizationId: c.get("organizationId") as string,
		...params,
		applyId: applyCtx.applyId,
		actorSource: applyCtx.actorSource,
		createdBy: applyCtx.createdBy,
		clientId: applyCtx.clientId,
	});
}

/** Whitelist profile metadata down to the non-secret fields (email, expiresAt, accountId). */
function sanitizeClientProfileMetadata(
	metadata: AuthProfile["metadata"],
): AuthProfile["metadata"] | undefined {
	if (!metadata) return undefined;
	const next = {
		...(metadata.email ? { email: metadata.email } : {}),
		...(typeof metadata.expiresAt === "number"
			? { expiresAt: metadata.expiresAt }
			: {}),
		...(metadata.accountId ? { accountId: metadata.accountId } : {}),
	};
	return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Strip secret material from a stored auth profile before returning it to the
 * web client. `user_auth_profiles` only ever holds refs (not plaintext), but
 * we still drop `credentialRef` / `metadata.*Ref` so the UI never sees them.
 * `credential` is surfaced as an empty string to match the client type — the
 * UI uses it only as "is a key already saved?" signal, never reads its value.
 */
function sanitizeAuthProfileForClient(profile: AuthProfile) {
	const metadata = sanitizeClientProfileMetadata(profile.metadata);
	return {
		id: profile.id,
		provider: profile.provider,
		model: profile.model,
		credential: "",
		label: profile.label,
		authType: profile.authType,
		...(metadata ? { metadata } : {}),
		createdAt: profile.createdAt,
	};
}

/**
 * Reconcile the user-scoped auth profiles for `(userId, agentId)` against the
 * list the web client just submitted in a `PATCH /config` body.
 *
 *   - entries in `desired` that carry a non-empty `credential` are upserted
 *     first (the secret is written to the secret store, the ref to the profile
 *     JSON) — done before any removal so a failed write can't leave the user
 *     with fewer credentials than they started with.
 *   - profiles in the store but absent from `desired` are then removed (with
 *     their secrets), so deleting a provider row in the UI actually deletes it.
 *   - entries with an empty/absent `credential` are unchanged rows the client
 *     round-tripped — left as-is so the stored secret is preserved.
 *
 * Throws if the auth-profiles manager is unavailable; the caller surfaces that
 * rather than reporting a save that was dropped.
 */
async function reconcileAgentAuthProfiles(
	agentId: string,
	userId: string,
	desired: AuthProfile[],
): Promise<void> {
	const manager = getLobuCoreServices()?.getAuthProfilesManager?.();
	if (!manager) {
		throw new Error(
			"Auth profile store is not available — retry once startup completes",
		);
	}
	const store = manager.getUserAuthProfileStore();
	for (const profile of desired) {
		const credential =
			typeof profile.credential === "string" ? profile.credential.trim() : "";
		if (!credential) continue;
		const metadata = sanitizeClientProfileMetadata(profile.metadata);
		await manager.upsertProfile({
			userId,
			agentId,
			id: profile.id,
			provider: profile.provider,
			credential,
			authType: profile.authType,
			label: profile.label,
			model: profile.model,
			...(metadata ? { metadata } : {}),
			makePrimary: true,
		});
	}
	const desiredIds = new Set(
		desired.map((profile) => profile.id).filter(Boolean),
	);
	const current = await store.list(userId, agentId);
	for (const existing of current) {
		if (!desiredIds.has(existing.id)) {
			await store.remove(userId, agentId, {
				provider: existing.provider,
				profileId: existing.id,
			});
		}
	}
}

/** True if the submitted profile list contains at least one fresh credential. */
function hasFreshCredential(profiles: AuthProfile[]): boolean {
	return profiles.some(
		(profile) =>
			typeof profile.credential === "string" &&
			profile.credential.trim().length > 0,
	);
}

// ── Resolve the org's builder/system agent ───────────────────────────────────
// Server-controlled pointer (organization.system_agent_id). The web console
// mounts the builder chat against this id; null when none is provisioned.
// Registered before any `/:agentId` route so the literal path wins.
routes.get("/system-agent", async (c) => {
	const orgId = c.get("organizationId")!;
	const sql = getDb();
	// Backfill / heal the org's builder on demand. Orgs created before the
	// builder feature have no system agent yet, and an org whose builder was
	// provisioned before its providers resolved needs its providers/model filled
	// in. ensureBuilderAgent is idempotent + one SELECT on the healthy path, and
	// best-effort (never throws), so it can't break console load.
	await ensureBuilderAgent(orgId, sql);
	const rows = await sql`
    SELECT system_agent_id FROM organization WHERE id = ${orgId} LIMIT 1
  `;
	return c.json({
		systemAgentId: (rows[0]?.system_agent_id as string | null) ?? null,
	});
});

// ── List agents ──────────────────────────────────────────────────────────────

routes.get("/", async (c) => {
	const agents = await configStore.listAgents();

	// Count connections per agent
	const sql = getDb();
	const orgId = c.get("organizationId")!;
	const connCounts = await sql`
    SELECT c.agent_id,
      count(*)::int as count,
      count(*) FILTER (WHERE c.status = 'active')::int as active_count
    FROM connections c
    JOIN agents a ON a.id = c.agent_id AND a.organization_id = c.organization_id
    WHERE c.organization_id = ${orgId}
      AND c.credential_mode IS NOT NULL
      AND c.deleted_at IS NULL
    GROUP BY c.agent_id
  `;
	const countMap = new Map(connCounts.map((r: any) => [r.agent_id, r.count]));
	const activeCountMap = new Map(
		connCounts.map((r: any) => [r.agent_id, r.active_count]),
	);

	const [
		runtimeClientCounts,
		watcherCounts,
		userCounts,
		platformRows,
		providerRows,
	] = await Promise.all([
		countRuntimeMessagingClientsByAgent(orgId),
		// Watchers owned by each agent (active only).
		sql`
        SELECT agent_id, count(*)::int as count
        FROM watchers
        WHERE organization_id = ${orgId} AND status = 'active' AND agent_id IS NOT NULL
        GROUP BY agent_id
      `,
		// Distinct end-users per agent across messaging platforms.
		sql`
        SELECT u.agent_id, count(DISTINCT (u.platform, u.user_id))::int as count
        FROM agent_users u
        JOIN agents a ON a.id = u.agent_id
        WHERE a.organization_id = ${orgId}
        GROUP BY u.agent_id
      `,
		// Distinct connection platforms per agent. Cast to text so the driver always
		// returns a JS array — array_agg over an enum/varchar column can come back as
		// a raw `'{telegram,slack}'` string when postgres.js has no array parser for
		// the element OID, which then blows up `.map` in the UI.
		sql`
        SELECT c.agent_id, array_agg(DISTINCT c.connector_key::text) as platforms
        FROM connections c
        JOIN agents a ON a.id = c.agent_id AND a.organization_id = c.organization_id
        WHERE c.organization_id = ${orgId}
          AND c.credential_mode IS NOT NULL
          AND c.deleted_at IS NULL
        GROUP BY c.agent_id
      `,
		// Provider ids per agent, derived from the `models` list's slug prefixes.
		sql`
        SELECT id, models
        FROM agents
        WHERE organization_id = ${orgId}
      `,
	]);

	const clientCountMap = new Map<string, Set<string>>();
	for (const [agentId, runtimeIds] of runtimeClientCounts.entries()) {
		let ids = clientCountMap.get(agentId);
		if (!ids) {
			ids = new Set<string>();
			clientCountMap.set(agentId, ids);
		}
		for (const clientId of runtimeIds) ids.add(clientId);
	}
	const watcherCountMap = new Map(
		watcherCounts.map((r: any) => [r.agent_id, r.count]),
	);
	const userCountMap = new Map(
		userCounts.map((r: any) => [r.agent_id, r.count]),
	);
	const platformsMap = new Map(
		platformRows.map((r: any) => [r.agent_id, toStringArray(r.platforms)]),
	);
	const providersMap = new Map<string, string[]>();
	for (const r of providerRows) {
		const set = new Set<string>();
		for (const ref of ((r as any).models ?? []) as unknown[]) {
			if (typeof ref !== "string") continue;
			const slash = ref.indexOf("/");
			if (slash > 0) set.add(ref.slice(0, slash));
		}
		providersMap.set((r as any).id, [...set]);
	}

	return c.json({
		agents: agents.map((a) => ({
			...a,
			connectionCount: countMap.get(a.agentId) ?? 0,
			activeConnectionCount: activeCountMap.get(a.agentId) ?? 0,
			clientCount: clientCountMap.get(a.agentId)?.size ?? 0,
			watcherCount: watcherCountMap.get(a.agentId) ?? 0,
			userCount: userCountMap.get(a.agentId) ?? 0,
			platforms: platformsMap.get(a.agentId) ?? [],
			providers: providersMap.get(a.agentId) ?? [],
			status: (activeCountMap.get(a.agentId) ?? 0) > 0 ? "active" : "idle",
		})),
	});
});

// ── Create agent ─────────────────────────────────────────────────────────────

routes.post("/", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const body = await c.req.json<{
		agentId: string;
		name: string;
		description?: string;
	}>();
	const user = c.get("user");
	if (!user) return c.json({ error: "Authentication required" }, 401);

	const { agentId, name, description } = body;
	if (!agentId || !name)
		return c.json({ error: "agentId and name are required" }, 400);

	// Validate agentId format
	if (!AGENT_ID_PATTERN.test(agentId)) {
		return c.json(
			{
				error:
					"agentId must be 3-60 lowercase alphanumeric chars with hyphens, starting with a letter",
			},
			400,
		);
	}

	const orgId = c.get("organizationId") as string;

	// Atomic create + auto-inject. Two concurrent `lobu apply` runs from the
	// same operator can both reach this endpoint with the same agentId. The
	// previous version did INSERT-then-saveSettings as two separate writes:
	// a "loser" returning 200 in the idempotent branch could see the row
	// before the winner's saveSettings landed, then immediately PATCH it with
	// operator config — only for the winner's deferred saveSettings to clobber
	// it moments later. Folding `pre_approved_tools` into the same INSERT
	// statement closes that gap: the row + auto-injected pre-approvals land
	// atomically and the loser's idempotent 200 already reflects
	// fully-initialized state. The `lobu-memory` MCP server itself is no longer
	// stored per-agent — it's derived at worker startup by McpConfigService.
	const sql = getDb();
	const now = new Date();
	const ownerPreApprovedTools = ["/mcp/lobu-memory/tools/*"];
	const inserted = await sql`
    INSERT INTO agents (
      id, organization_id, name, description, owner_platform, owner_user_id,
      pre_approved_tools, created_at, updated_at
    )
    VALUES (
      ${agentId}, ${orgId}, ${name}, ${description ?? null},
      'lobu', ${user.id},
      ${sql.json(ownerPreApprovedTools)}, ${now}, ${now}
    )
    ON CONFLICT (organization_id, id) DO NOTHING
    RETURNING id
  `;

	if (inserted.length === 0) {
		// Another writer (or a previous apply cycle) already owns this id in
		// *this* org. Return idempotent 200 with the existing row's metadata.
		// Cross-org collisions are no longer possible — the PK is per-org now.
		const existing = await configStore.getMetadata(agentId);
		if (!existing) {
			return c.json({ error: "Agent metadata missing" }, 500);
		}
		return c.json(
			{
				agentId,
				name: existing.name,
				description: existing.description,
			},
			200,
		);
	}

	emitConfigChange(c, {
		resourceKind: "agent",
		resourceId: agentId,
		op: "created",
		summary: `Agent '${name}' created`,
		state: { agentId, name, description: description ?? null },
	});

	return c.json({ agentId, name, description }, 201);
});

// ── Org-scoped inference-provider routes ─────────────────────────────────────
// Registered BEFORE any `/:agentId` route so these literal paths win the match
// (Hono would otherwise treat 'inference-providers' as an :agentId → 404).
// Helpers (requireOrgId, validateCapabilitiesMap) are hoisted fn declarations
// defined lower in this file.

routes.get("/inference-providers", async (c) => {
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	await ensureVisibleOAuthProvidersForUser(c, orgId);
	const providers = await listInferenceProviders(orgId);
	return c.json({ providers });
});

// Bundled provider catalog (PUBLIC metadata only — no secrets). Renders the
// default "Available" add-cards on the inference-providers page; each entry
// carries enough pre-fill data that adopting a bundled provider needs only an
// API key. Registered before any `/:agentId` route so the literal path matches.
routes.get("/inference-providers/catalog", async (c) => {
	try {
		const registry = new ProviderRegistryService(resolveProviderRegistryPath());
		const configs = await registry.getProviderConfigs();
		// Built from the module registry (not just providers.json) so Claude /
		// ChatGPT (OAuth modules) appear too, each carrying its auth metadata.
		const catalog = buildProviderCatalog(configs);
		return c.json({ catalog });
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"[inference-providers/catalog] failed to load bundled provider catalog",
		);
		return c.json({ catalog: [] });
	}
});

// ── Org-scoped LLM-provider OAuth (subscription login) ───────────────────────
//
// Generic start/complete for every providers.json entry with an `oauth` block.
// Profiles land in the per-user ORG BUCKET so one sign-in covers all of this
// user's agents in the org. Behavior is dispatched by config.grant via
// grantStrategyFor.
//
// Auth: interactive session only.

async function ensureVisibleOAuthProvidersForUser(
	c: any,
	orgId: string,
): Promise<void> {
	const user = c.get("user") as { id: string } | undefined;
	if (!user?.id) return;
	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	if (!authProfilesManager) return;

	for (const config of Object.values(getOAuthProviderConfigs())) {
		const profiles = await orgContext.run({ organizationId: orgId }, () =>
			authProfilesManager.getProviderProfiles(
				orgBucketAgentId(orgId),
				config.id,
				user.id,
			),
		);
		if (profiles.length === 0) continue;
		await ensureOAuthInferenceProvider({
			organizationId: orgId,
			slug: config.id,
			kind: config.id,
			displayName: config.name,
			createdBy: user.id,
		});
	}
}

/** Resolve the OAuth provider config, or a 400 Response if unknown. */
function resolveOAuthProvider(
	c: any,
	providerId: unknown,
): OAuthProviderConfig | Response {
	const id = typeof providerId === "string" ? providerId : "";
	const config = getOAuthProviderConfig(id);
	if (!config) {
		return c.json(
			{ error: `Provider '${id}' does not support OAuth sign-in` },
			400,
		);
	}
	return config;
}

/**
 * Interactive-session guard for OAuth. OAuth providers require a real user to
 * complete the browser round-trip; a headless PAT/OAuth-bearer caller cannot.
 * Returns the session user, or a Response (403 headless, 401 unauthenticated).
 */
function requireInteractiveUser(c: any): { id: string } | Response {
	const user = c.get("user") as { id: string } | undefined;
	const authSource = c.get("authSource") as string | null;
	if (authSource !== "session" || !user) {
		return c.json(
			{ error: "OAuth providers require interactive sign-in" },
			403,
		);
	}
	return user;
}

routes.post("/inference-providers/oauth/start", async (c) => {
	const config = resolveOAuthProvider(c, await readProviderId(c));
	if (config instanceof Response) return config;
	const user = requireInteractiveUser(c);
	if (user instanceof Response) return user;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const strategy = grantStrategyFor(config);
	const bucketAgentId = orgBucketAgentId(orgId);

	if ((config.grant ?? "authorization-code") === "authorization-code") {
		const oauthStateStore = getLobuCoreServices()?.getOAuthStateStore?.();
		if (!oauthStateStore) {
			return c.json({ error: "Embedded Lobu auth is not available" }, 503);
		}
		// Mint the PKCE verifier + state row FIRST, then build the authorize URL
		// around that exact state so `complete` can validate it and recover the
		// verifier. The bucket agentId rides the state so complete stores to the
		// same org bucket even though no agents row exists for it.
		const codeVerifier = generateCodeVerifier();
		const stateToken = await oauthStateStore.create({
			userId: user.id,
			agentId: bucketAgentId,
			codeVerifier,
			context: { platform: "web", channelId: bucketAgentId },
		});
		const result = await strategy.start(
			config,
			{ kind: "org", slug: orgId, organizationId: orgId, userId: user.id },
			{ stateToken, codeVerifier },
		);
		return c.json(result);
	}

	// device-code (ChatGPT): no state store — deviceAuthId + userCode round-trip
	// directly through the client on poll.
	const result = await strategy.start(config, {
		kind: "org",
		slug: orgId,
		organizationId: orgId,
		userId: user.id,
	});
	return c.json(result);
});

routes.post("/inference-providers/oauth/complete", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		providerId?: unknown;
		code?: unknown;
		deviceAuthId?: unknown;
		userCode?: unknown;
	};
	const config = resolveOAuthProvider(c, body.providerId);
	if (config instanceof Response) return config;
	const user = requireInteractiveUser(c);
	if (user instanceof Response) return user;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	if (!authProfilesManager) {
		return c.json({ error: "Embedded Lobu auth is not available" }, 503);
	}

	const strategy = grantStrategyFor(config);
	const scope = {
		kind: "org" as const,
		slug: orgId,
		organizationId: orgId,
		userId: user.id,
	};
	const bucketAgentId = orgBucketAgentId(orgId);

	try {
		let stored: Awaited<ReturnType<typeof strategy.complete>>;
		if ((config.grant ?? "authorization-code") === "authorization-code") {
			const input = typeof body.code === "string" ? body.code.trim() : "";
			if (!input) return c.json({ error: "Missing OAuth code" }, 400);
			const parts = input.split("#");
			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				return c.json(
					{ error: "OAuth code must be in code#state format" },
					400,
				);
			}
			const oauthStateStore = getLobuCoreServices()?.getOAuthStateStore?.();
			if (!oauthStateStore) {
				return c.json({ error: "Embedded Lobu auth is not available" }, 503);
			}
			const stateData = await oauthStateStore.consume(parts[1].trim());
			if (!stateData) {
				return c.json({ error: "OAuth state expired or is invalid" }, 400);
			}
			if (stateData.userId !== user.id || stateData.agentId !== bucketAgentId) {
				return c.json(
					{ error: "OAuth state does not match this session" },
					403,
				);
			}
			stored = await strategy.complete(config, scope, {
				mode: "redirect",
				code: parts[0].trim(),
				state: parts[1].trim(),
				codeVerifier: stateData.codeVerifier,
			});
		} else {
			const deviceAuthId =
				typeof body.deviceAuthId === "string" ? body.deviceAuthId.trim() : "";
			const userCode =
				typeof body.userCode === "string" ? body.userCode.trim() : "";
			if (!deviceAuthId || !userCode) {
				return c.json({ error: "Missing deviceAuthId or userCode" }, 400);
			}
			stored = await strategy.complete(config, scope, {
				mode: "device",
				deviceAuthId,
				userCode,
			});
			if (!stored) return c.json({ status: "pending" });
		}

		// authorization-code never returns null (it either exchanges or throws); the
		// device branch already handled its pending case. This guards the type.
		if (!stored) return c.json({ status: "pending" });

		// Persist to the org bucket. `organizationId` on the row is what keeps these
		// tokens refreshing (scanAllOAuth COALESCE + refreshForUserAgent branch);
		// the profile's providerId must be the config id so the refresh job's
		// `doRefresh` matches it to the right refresher.
		await authProfilesManager.upsertProfile({
			agentId: bucketAgentId,
			userId: user.id,
			provider: config.id,
			credential: stored.accessToken,
			authType: stored.authType,
			label: createAuthProfileLabel(
				config.name,
				stored.accessToken,
				stored.accountId,
			),
			metadata: {
				...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
				expiresAt: stored.expiresAt,
				...(stored.accountId ? { accountId: stored.accountId } : {}),
			},
			makePrimary: true,
			organizationId: orgId,
		});

		const provider = await ensureOAuthInferenceProvider({
			organizationId: orgId,
			slug: config.id,
			kind: config.id,
			displayName: config.name,
			createdBy: user.id,
		});
		emitConfigChange(c, {
			resourceKind: "inference-provider",
			resourceId: provider.slug,
			op: "created",
			summary: `Inference provider '${provider.slug}' connected`,
			state: {
				slug: provider.slug,
				kind: provider.kind,
				displayName: provider.displayName,
				capabilities: provider.capabilities,
				hasCustomUpstream: provider.hasCustomUpstream,
				status: provider.status,
			},
		});

		return c.json({ status: "success" });
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : "OAuth exchange failed",
			},
			400,
		);
	}
});

/** Read `providerId` from the JSON body (start route). Kept tiny so the two
 *  OAuth handlers share the parse without duplicating the try/catch. */
async function readProviderId(c: any): Promise<unknown> {
	const body = (await c.req.json().catch(() => ({}))) as {
		providerId?: unknown;
	};
	return body.providerId;
}

routes.post("/inference-providers", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	let body: {
		slug?: unknown;
		kind?: unknown;
		displayName?: unknown;
		apiKey?: unknown;
		capabilities?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}

	const slug = typeof body.slug === "string" ? body.slug.trim() : "";
	const kind = typeof body.kind === "string" ? body.kind.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
	if (!slug) return c.json({ error: "Body must include a `slug` string" }, 400);
	if (!isValidInferenceProviderSlug(slug)) {
		return c.json(
			{
				error:
					"`slug` must be lowercase alphanumeric + hyphen, 1-63 chars, no leading/trailing hyphen",
			},
			400,
		);
	}
	if (!kind) return c.json({ error: "Body must include a `kind` string" }, 400);
	if (!apiKey) {
		return c.json(
			{ error: "Body must include a non-empty `apiKey` string" },
			400,
		);
	}
	const capErr = validateCapabilitiesMap(body.capabilities);
	if (capErr) return c.json({ error: capErr }, 400);

	// Gate: a provider is addable via a pasted API key only if its wire protocol
	// is one we can route (present in SDK_COMPAT_PROTOCOLS). `kind` is the catalog
	// slug the user picked; a known catalog entry whose sdkCompat isn't routable
	// (e.g. a subscription-only OAuth provider) is rejected so an unroutable row
	// can't be created. Unknown kinds (custom endpoints) pass — they're treated as
	// OpenAI-compatible by the synthesize path.
	try {
		const registry = new ProviderRegistryService(resolveProviderRegistryPath());
		const catalog = buildProviderCatalog(await registry.getProviderConfigs());
		const entry = catalog.find((e) => e.slug === kind);
		if (entry && !isSdkCompat(entry.sdkCompat)) {
			return c.json(
				{
					error: `Provider '${kind}' can't be added with an API key — it signs in instead.`,
				},
				400,
			);
		}
	} catch (err) {
		// Fail open on catalog-load errors: don't block creation on a metadata
		// read. The synthesize path still gates routing downstream.
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"[inference-providers POST] catalog gate check failed; allowing",
		);
	}

	const createdBy = c.get("user")?.id ?? null;

	const result = await createInferenceProvider({
		organizationId: orgId,
		slug,
		kind,
		displayName: typeof body.displayName === "string" ? body.displayName : null,
		apiKey,
		capabilities: (body.capabilities as InferenceCapabilities) ?? {},
		createdBy,
	});
	if ("error" in result) {
		return c.json(
			{ error: `A provider with slug '${result.slug}' already exists` },
			409,
		);
	}
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: result.slug,
		op: "created",
		summary: `Inference provider '${result.slug}' created`,
		state: {
			slug: result.slug,
			kind: result.kind,
			displayName: result.displayName,
			capabilities: result.capabilities,
			hasCustomUpstream: result.hasCustomUpstream,
			status: result.status,
		},
	});

	// Never echo the key or the api_key_ref back to the caller.
	return c.json(
		{
			provider: {
				id: result.id,
				slug: result.slug,
				kind: result.kind,
				displayName: result.displayName,
				capabilities: result.capabilities,
				hasCustomUpstream: result.hasCustomUpstream,
				status: result.status,
				createdAt: result.createdAt,
			},
		},
		201,
	);
});

// Edit a provider's core fields. Only displayName is mutable — slug (agents
// reference it) and kind (catalog linkage) are immutable. Key rotation and
// per-modality capability edits keep their dedicated routes below; the Edit UI
// calls whichever it needs.
routes.put("/inference-providers/:slug", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	let body: { displayName?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}

	// Empty / whitespace-only name means "leave unchanged" (pass undefined).
	const rawName = typeof body.displayName === "string" ? body.displayName : "";
	const displayName = rawName.trim() ? rawName.trim() : undefined;

	const updated = await updateInferenceProviderCoreFields(orgId, slug, {
		displayName,
	});
	if (!updated) return c.json({ error: "Provider not found" }, 404);
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: updated.slug,
		op: "updated",
		summary: `Inference provider '${updated.slug}' renamed`,
		state: {
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
		},
		changedFields: ["displayName"],
	});
	return c.json({
		provider: {
			id: updated.id,
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
			createdAt: updated.createdAt,
		},
	});
});

// Mark one org inference provider as THE org default. Its `capabilities.text.model`
// becomes the org-default model — the tail of the layered fallback
// (behavior → agent → org default). Exactly one live default per org (enforced
// by a partial unique index); setting a new one clears the prior in one txn.
routes.put("/inference-providers/:slug/default", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	const ok = await setInferenceProviderDefault(orgId, slug);
	if (!ok) return c.json({ error: "Provider not found" }, 404);
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: slug,
		op: "updated",
		summary: `Inference provider '${slug}' set as org default`,
		state: { slug, isDefault: true },
		changedFields: ["isDefault"],
	});
	return c.json({ success: true, slug, isDefault: true });
});

routes.put("/inference-providers/:slug/capabilities/:modality", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug, modality } = c.req.param();

	if (!isInferenceModality(modality)) {
		return c.json(
			{ error: "modality must be one of: text, image, stt, tts" },
			400,
		);
	}

	let body: { block?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	const block = body.block;
	const err = validateCapabilityBlock(modality, block);
	if (err) return c.json({ error: err }, 400);

	const updated = await updateInferenceProviderCapabilities(
		orgId,
		slug,
		modality,
		block as InferenceCapabilityBlock,
	);
	if (!updated) return c.json({ error: "Provider not found" }, 404);
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: updated.slug,
		op: "updated",
		summary: `Inference provider '${updated.slug}' ${modality} capabilities updated`,
		state: {
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
		},
		changedFields: [`capabilities.${modality}`],
	});
	return c.json({
		provider: {
			id: updated.id,
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
			createdAt: updated.createdAt,
		},
	});
});

routes.put("/inference-providers/:slug/key", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	let body: { value?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	const value = typeof body.value === "string" ? body.value.trim() : "";
	if (!value) {
		return c.json(
			{ error: "Body must include a non-empty `value` string" },
			400,
		);
	}

	const ok = await rotateInferenceProviderKey(orgId, slug, value);
	if (!ok) return c.json({ error: "Provider not found" }, 404);
	// Metadata-only: key rotations are audited but the value is never snapshotted.
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: slug,
		op: "updated",
		summary: `Inference provider '${slug}' API key rotated`,
		state: null,
		changedFields: ["apiKey"],
	});
	return c.json({ success: true });
});

routes.delete("/inference-providers/:slug", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	const ok = await softDeleteInferenceProvider(orgId, slug);
	if (!ok) return c.json({ error: "Provider not found" }, 404);
	const user = c.get("user") as { id: string } | undefined;
	const oauthConfig = getOAuthProviderConfig(slug);
	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	// Only an interactive user can revoke their org-bucket OAuth profile. Admin
	// PAT callers may tombstone the visible row, but must not delete another
	// user's subscription credential.
	if (user?.id && oauthConfig && authProfilesManager) {
		await orgContext.run({ organizationId: orgId }, () =>
			authProfilesManager.deleteProviderProfiles(
				orgBucketAgentId(orgId),
				oauthConfig.id,
				{ userId: user.id },
			),
		);
	}
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: slug,
		op: "deleted",
		summary: `Inference provider '${slug}' deleted`,
		state: null,
	});
	return c.json({ success: true });
});

// ── Get agent detail ─────────────────────────────────────────────────────────

routes.get("/:agentId", async (c) => {
	const { agentId } = c.req.param();
	const metadata = await configStore.getMetadata(agentId);
	if (!metadata) return c.json({ error: "Agent not found" }, 404);

	const settings = await configStore.getSettings(agentId);
	const sql = getDb();
	const organizationId = c.get("organizationId") as string;
	const [connectionStats] = await sql`
    SELECT
      count(*)::int as connection_count,
      count(*) FILTER (WHERE status = 'active')::int as active_connection_count
    FROM connections
    WHERE agent_id = ${agentId} AND organization_id = ${organizationId}
      AND credential_mode IS NOT NULL AND deleted_at IS NULL
  `;
	const clientIds = new Set<string>();
	const runtimeClientCounts =
		await countRuntimeMessagingClientsByAgent(organizationId);
	for (const runtimeClientId of runtimeClientCounts.get(agentId) ?? []) {
		clientIds.add(runtimeClientId);
	}

	return c.json({
		...metadata,
		settings,
		connectionCount: connectionStats?.connection_count ?? 0,
		activeConnectionCount: connectionStats?.active_connection_count ?? 0,
		clientCount: clientIds.size,
		status:
			(connectionStats?.active_connection_count ?? 0) > 0 ? "active" : "idle",
	});
});

// ── Update agent metadata ────────────────────────────────────────────────────

routes.patch("/:agentId", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const { agentId } = c.req.param();
	const body = await c.req.json<{ name?: string; description?: string }>();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

	await configStore.updateMetadata(agentId, body);
	// Snapshot the row as stored (post-merge), not the request body.
	const metadata = await configStore.getMetadata(agentId);
	emitConfigChange(c, {
		resourceKind: "agent",
		resourceId: agentId,
		op: "updated",
		summary: `Agent '${metadata?.name ?? agentId}' metadata updated`,
		state: metadata ? { ...metadata, agentId } : null,
		changedFields: Object.keys(body),
	});
	return c.json({ success: true });
});

// ── Delete agent ─────────────────────────────────────────────────────────────

routes.delete("/:agentId", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const { agentId } = c.req.param();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

	// Cascade handled by FK ON DELETE CASCADE
	await configStore.deleteMetadata(agentId);
	emitConfigChange(c, {
		resourceKind: "agent",
		resourceId: agentId,
		op: "deleted",
		summary: `Agent '${agentId}' deleted`,
		state: null,
	});
	return c.json({ success: true });
});

// ── Get agent config (settings) ──────────────────────────────────────────────

routes.get("/:agentId/config", async (c) => {
	const { agentId } = c.req.param();
	const settings = await configStore.getSettings(agentId);
	if (!settings) return c.json({ error: "Agent not found" }, 404);

	// `configStore` doesn't carry auth profiles (they live in
	// `user_auth_profiles`, keyed by the requesting user). Merge the caller's
	// sanitized profiles in so the agent settings UI can show which providers
	// already have a credential connected.
	const user = c.get("user");
	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	const authProfiles =
		user?.id && authProfilesManager
			? (
					await authProfilesManager
						.getUserAuthProfileStore()
						.list(user.id, agentId)
				).map(sanitizeAuthProfileForClient)
			: [];

	return c.json({ ...settings, authProfiles });
});

// ── Recent guardrail trips ───────────────────────────────────────────────────
//
// Read-only audit feed for the agent's Guardrails tab. Each `guardrail-trip`
// event row is one stage a guardrail short-circuited (written by
// `recordGuardrailTrip`). The rows are append-only and never superseded, so we
// read `events` directly rather than the `current_event_records` view, which
// would force an expensive `event_embeddings` join. Org-scoped + Postgres-backed
// and therefore correct under N replicas (any pod can serve it).
routes.get("/:agentId/guardrail-trips", async (c) => {
	const { agentId } = c.req.param();
	const organizationId = c.get("organizationId") as string;

	// Clamp to a sane window — the UI asks for 50; cap so a hand-crafted query
	// can't ask for an unbounded scan.
	const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Number.isFinite(limitRaw)
		? Math.min(Math.max(limitRaw, 1), 200)
		: 50;

	// Optional narrowing to a single guardrail — the per-guardrail detail view
	// asks for just that guardrail's catches.
	const guardrail = c.req.query("guardrail");

	// Optional narrowing to one conversation — the chat view asks for just the
	// trips that fired during this conversation so it can flag the affected turn.
	const conversationId = c.req.query("conversationId");

	const sql = getDb();
	// `recordGuardrailTrip` writes `created_at` (default now()) but leaves
	// `occurred_at` null, so coalesce to `created_at` — otherwise the UI shows
	// "null" for the timestamp of every real trip.
	const rows = await sql`
    SELECT id, COALESCE(occurred_at, created_at) AS occurred_at, metadata
      FROM events
     WHERE organization_id = ${organizationId}
       AND semantic_type = 'guardrail-trip'
       AND metadata->>'agent_id' = ${agentId}
       ${guardrail ? sql`AND metadata->>'guardrail' = ${guardrail}` : sql``}
       ${conversationId ? sql`AND metadata->>'conversation_id' = ${conversationId}` : sql``}
     ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC
     LIMIT ${limit}
  `;

	const agentName = (await configStore.getMetadata(agentId))?.name;

	const trips = rows.map((row) => {
		const metadata = (row.metadata ?? {}) as {
			stage?: string;
			guardrail?: string;
			reason?: string | null;
			conversation_id?: string | null;
		};
		const occurredAt =
			row.occurred_at instanceof Date
				? row.occurred_at.toISOString()
				: row.occurred_at
					? String(row.occurred_at)
					: "";
		return {
			id: Number(row.id),
			occurredAt,
			agentId,
			...(agentName ? { agentName } : {}),
			stage: metadata.stage,
			guardrailName: metadata.guardrail,
			...(metadata.reason ? { reason: metadata.reason } : {}),
			...(metadata.conversation_id
				? { conversationId: metadata.conversation_id }
				: {}),
		};
	});

	return c.json({ trips });
});

// ── Judge model default (for custom guardrail authoring) ─────────────────────
//
// Custom guardrails are LLM judges. There is no hardcoded judge model: the
// operator sets one via `EGRESS_JUDGE_MODEL`. The create/edit UI uses this to
// either show the configured default (model optional) or require a per-guardrail
// model (when unset). Returns null when no gateway default is configured.
routes.get("/:agentId/guardrail-judge-default", async (c) => {
	return c.json({
		defaultModel: process.env.EGRESS_JUDGE_MODEL?.trim() || null,
	});
});

// ── Set the org-shared API key for a provider ────────────────────────────────
//
// Writes (or rotates) the org-wide API key declared via `lobu apply` from
// `[[agents.<id>.providers]] key = "$VAR"`. The key lands in `agent_secrets`
// under `provider:<id>:apiKey`, scoped to the org. The worker's credential
// resolution (base-provider-module.ts) checks per-user `auth_profiles` first,
// then this row, then `process.env` — so per-user BYOK still wins.
//
// `:agentId` is in the path so the auth/admin gate matches the rest of this
// router; the secret itself is org-scoped, not per-agent (one z-ai key for the
// whole org). PUT is idempotent; same name overwrites.

// TODO(inference-providers): remove after resolver cutover
routes.put("/:agentId/providers/:providerId/api-key", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const { agentId, providerId } = c.req.param();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

	let body: { value?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	const value = typeof body.value === "string" ? body.value.trim() : "";
	if (!value) {
		return c.json(
			{ error: "Body must include a non-empty `value` string" },
			400,
		);
	}

	const ciphertext = encrypt(value);
	const name = providerOrgSecretName(providerId);
	const orgId = (c.get("organizationId") as string | undefined) ?? null;
	if (!orgId) {
		return c.json({ error: "Organization context not available" }, 500);
	}

	const sql = getDb();
	await sql`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
    VALUES (${orgId}, ${name}, ${ciphertext}, now(), now())
    ON CONFLICT (organization_id, name) DO UPDATE SET
      ciphertext = EXCLUDED.ciphertext,
      updated_at = now()
  `;
	// Metadata-only: provider keys are audited but never snapshotted (the
	// writer forces `state` to null for this kind regardless).
	emitConfigChange(c, {
		resourceKind: "provider-key",
		resourceId: `${providerId}`,
		op: "updated",
		summary: `Org API key for provider '${providerId}' set`,
		state: null,
	});
	return c.json({ success: true, name });
});

// ── Update agent config (settings) ───────────────────────────────────────────

const GUARDRAIL_STAGES = new Set(["input", "output", "pre-tool", "egress"]);

/**
 * Validate a `guardrailsInline` payload before it is persisted to agent
 * settings. Returns a human-readable error string on the first invalid entry,
 * or `null` when the payload is absent or fully valid. Persisting an entry with
 * an invalid `stage` would crash the guardrail aggregator at message time, so
 * we reject malformed input at the write boundary instead.
 */
export function validateGuardrailsInline(value: unknown): string | null {
	if (value === undefined) return null;
	if (!Array.isArray(value)) return "guardrailsInline must be an array";
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (typeof entry !== "object" || entry === null) {
			return `guardrailsInline[${i}] must be an object`;
		}
		const g = entry as Record<string, unknown>;
		if (typeof g.name !== "string" || g.name.trim() === "") {
			return `guardrailsInline[${i}].name must be a non-empty string`;
		}
		if (typeof g.enabled !== "boolean") {
			return `guardrailsInline[${i}].enabled must be a boolean`;
		}
		if (typeof g.stage !== "string" || !GUARDRAIL_STAGES.has(g.stage)) {
			return `guardrailsInline[${i}].stage must be one of: input, output, pre-tool, egress`;
		}
		if (typeof g.policy !== "string" || g.policy.trim() === "") {
			return `guardrailsInline[${i}].policy must be a non-empty string`;
		}
		if (g.model !== undefined && typeof g.model !== "string") {
			return `guardrailsInline[${i}].model must be a string`;
		}
		if (
			g.tools !== undefined &&
			(!Array.isArray(g.tools) || g.tools.some((t) => typeof t !== "string"))
		) {
			return `guardrailsInline[${i}].tools must be an array of strings`;
		}
		if (
			g.domains !== undefined &&
			(!Array.isArray(g.domains) ||
				g.domains.some((d) => typeof d !== "string"))
		) {
			return `guardrailsInline[${i}].domains must be an array of strings`;
		}
	}
	return null;
}

routes.patch("/:agentId/config", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const { agentId } = c.req.param();
	const updates = await c.req.json();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

	// Validate inline guardrail shape before it is persisted. An invalid `stage`
	// (or missing name/policy) would otherwise be written verbatim and then crash
	// the guardrail aggregator mid-message (it indexes `seen[stage]`).
	const guardrailError = validateGuardrailsInline(
		(updates as { guardrailsInline?: unknown }).guardrailsInline,
	);
	if (guardrailError) {
		return c.json(
			{ error: "invalid_guardrail", error_description: guardrailError },
			400,
		);
	}

	// Custom guardrails are LLM judges and need a model. With no gateway default
	// (`EGRESS_JUDGE_MODEL` unset), every inline guardrail must carry its own
	// `model` — otherwise it would fail closed at runtime with no model to call.
	const judgeDefault = process.env.EGRESS_JUDGE_MODEL?.trim();
	if (
		!judgeDefault &&
		Array.isArray((updates as { guardrailsInline?: unknown }).guardrailsInline)
	) {
		const inline = (
			updates as { guardrailsInline: Array<{ name?: string; model?: string }> }
		).guardrailsInline;
		const missing = inline.find(
			(g) => typeof g?.model !== "string" || g.model.trim() === "",
		);
		if (missing) {
			return c.json(
				{
					error: "guardrail_model_required",
					error_description: `Custom guardrail "${missing.name ?? "(unnamed)"}" needs a model: the gateway has no default judge model (EGRESS_JUDGE_MODEL is unset).`,
				},
				400,
			);
		}
	}

	// Auth profiles aren't part of the agent settings row — they're
	// user-scoped and live in `user_auth_profiles` with secrets in the secret
	// store. Pull them out of the settings patch and persist them through the
	// proper path; otherwise an api-key typed into the UI is silently dropped.
	const { authProfiles, ...settingsUpdates } = updates as {
		authProfiles?: AuthProfile[];
	} & Record<string, unknown>;

	// Atomic cutover: the legacy model fields are GONE. An old client (pre-PR4
	// CLI, stale web build) that still sends them would have its restricted
	// declaration silently dropped to `models = NULL` = allow-all — a silent
	// access widening. Reject loudly so the operator upgrades instead.
	for (const legacyField of LEGACY_MODEL_FIELDS) {
		if (legacyField in settingsUpdates) {
			return c.json(
				{
					error: "legacy_model_field",
					error_description:
						`This server no longer accepts "${legacyField}". The agent's model configuration is now a single ordered "models" list of explicit "<provider>/<model>" refs. Upgrade your client (CLI / web) and send "models" instead.`,
					field: legacyField,
				},
				400,
			);
		}
	}

	// ATOMICITY (#7): validate the `models` allow-list BEFORE mutating anything
	// else (auth profiles, settings row). A models-validation failure must leave
	// the PATCH a true no-op — reconciling auth profiles first and THEN 503-ing
	// on models would persist a credential change while claiming "nothing saved".
	if (settingsUpdates.models !== undefined) {
		const organizationId = c.get("organizationId") as string;
		let error: Record<string, unknown> | null;
		try {
			error = await validateModelsUpdate({
				models: settingsUpdates.models,
				organizationId,
				agentId,
				c,
			});
		} catch (err) {
			// FAIL CLOSED: the `models` list is an access gate, so a lookup/infra
			// failure while validating it must REJECT the write — never persist an
			// unvalidated allow-list (that could silently widen or misconfigure
			// access). Nothing has been mutated yet, so this is a true no-op.
			logger.warn(
				{ agentId, err },
				"Failed to validate models list before saving agent settings — rejecting",
			);
			return c.json(
				{
					error: "models_validation_failed",
					error_description:
						"Could not validate the models list against the organization's providers. No change was saved; please retry.",
				},
				503,
			);
		}
		if (error) return c.json(error, 400);
		// Persist the trimmed refs, not the raw client payload.
		settingsUpdates.models = (settingsUpdates.models as string[]).map((m) =>
			m.trim(),
		);
	}

	if (Array.isArray(authProfiles)) {
		const user = c.get("user");
		if (!user?.id) {
			// Admin-PAT callers (`lobu apply`) manage declared-agent credentials
			// out of band; reject only if they actually tried to set one here.
			if (hasFreshCredential(authProfiles)) {
				return c.json(
					{ error: "Setting agent auth profiles requires a web session" },
					403,
				);
			}
		} else {
			try {
				await reconcileAgentAuthProfiles(agentId, user.id, authProfiles);
			} catch (error) {
				return c.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Failed to persist auth profiles",
					},
					503,
				);
			}
		}
	}

	await configStore.updateSettings(agentId, settingsUpdates);
	// Snapshot the merged settings row as stored (the store merges partial
	// patches server-side), so the audit state reflects what took effect.
	const merged = await configStore.getSettings(agentId);
	emitConfigChange(c, {
		resourceKind: "agent-settings",
		resourceId: agentId,
		op: "updated",
		summary: `Agent '${agentId}' settings updated`,
		state: merged ? { ...merged } : null,
		changedFields: Object.keys(settingsUpdates),
	});
	return c.json({ success: true });
});

// ============================================================
// ── Inference providers (org-owned per-modality custom upstreams) ─────────────
//
// Org-scoped credential rows in `inference_providers` (slug-referenced by
// agents). ONE api key per row; a row with any custom base_url is
// org-key-only across every modality. `capabilities` is per-modality config
// `{ "<modality>": { base_url?, model?, models_endpoint? } }`. The org comes
// from the router-level orgContext middleware (`c.get('organizationId')`); the
// `:agentId`-free paths keep these purely org-scoped. Reads use `mcpAuth`
// alone; mutations require the session/admin-PAT gate.

function requireOrgId(c: any): string | Response {
	const orgId = c.get("organizationId") as string | undefined;
	if (!orgId)
		return c.json({ error: "Organization context not available" }, 500);
	return orgId;
}

/**
 * Validate a full `capabilities` map ({ modality: block, … }). Returns an
 * error string on the first invalid modality/block, or null when valid.
 */
function validateCapabilitiesMap(value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "capabilities must be an object";
	}
	for (const [modality, block] of Object.entries(value)) {
		const err = validateCapabilityBlock(modality, block);
		if (err) return err;
	}
	return null;
}

export { routes as agentRoutes };
