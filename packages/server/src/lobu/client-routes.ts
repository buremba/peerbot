import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { OAuthClientsStore } from "../auth/oauth/clients";
import { getDb, pgTextArray } from "../db/client";
import type { Env } from "../index";
import { revokeInMemoryMcpSessionsForClient } from "../mcp-handler";
import { orgContext } from "./stores/org-context";

const routes = new Hono<{ Bindings: Env }>();

type MessagingClientRecord = {
	id: string;
	kind: "messaging";
	title: string;
	identifier: string | null;
	platform: string;
	assignedAgentId: string;
	assignedAgentName: string;
	status: string;
	authState: string;
	lastSeenAt: number;
	userAgent: null;
	capabilities: null;
	externalUrl: string | null;
	linkedUserName: null;
	linkedUserEmail: null;
	/** True for Lobu's own surfaces (CLI, Mac/iOS bridges) — never for messaging clients. */
	firstParty: false;
	details: {
		connectionId: string | null;
		description: string | null;
		connectionMetadata: Record<string, unknown> | null;
	};
};

/**
 * Software ids Lobu's own surfaces register with — the exact, non-spoofable
 * signal for first-party clients. (Keep in sync with the CLI / bridge clients.)
 */
const LOBU_FIRST_PARTY_SOFTWARE_IDS = new Set([
	"lobu-cli",
	"lobu",
	"lobu-mac-bridge",
	"lobu-ios-bridge",
	"lobu-bridge",
]);

/**
 * Recognises Lobu's first-party surfaces (CLI, Mac/iOS bridges) so the UI can
 * fold them into a "your devices & tools" group instead of listing them
 * alongside third-party MCP apps. Prefers the exact software-id allowlist;
 * the "Lobu …" client-name check is a best-effort fallback for clients that
 * register without a known software id (and could in theory be spoofed — this
 * is a display category, not an access boundary).
 */
function isFirstPartyLobuClient(
	name: string | null,
	softwareId: string | null,
): boolean {
	const s = (softwareId ?? "").trim().toLowerCase();
	if (s && LOBU_FIRST_PARTY_SOFTWARE_IDS.has(s)) return true;
	const n = (name ?? "").trim().toLowerCase();
	return n === "lobu" || n.startsWith("lobu ") || n.startsWith("lobu-");
}

function withOrg(c: any, fn: () => Promise<Response>): Promise<Response> {
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return Promise.resolve(c.json({ error: "Organization required" }, 401));
	}
	return orgContext.run({ organizationId }, fn);
}

function withOrgAdmin(c: any, fn: () => Promise<Response>): Promise<Response> {
	return withOrg(c, async () => {
		const role = c.get("memberRole");
		if (role !== "owner" && role !== "admin") {
			return c.json(
				{ error: "Revoking a connected client requires an owner or admin." },
				403,
			);
		}
		return fn();
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (value instanceof Date) return value.getTime();
	return null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function externalUrlForMessagingIdentity(
	platform: string,
	identifier?: string | null,
): string | null {
	if (!identifier) return null;

	if (platform === "telegram") {
		const normalized = identifier.replace(/^@/, "").trim();
		if (/^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(normalized)) {
			return `https://t.me/${normalized}`;
		}
	}

	if (platform === "whatsapp") {
		const digits = identifier.replace(/[^\d]/g, "");
		if (digits) {
			return `https://wa.me/${digits}`;
		}
	}

	return null;
}

/**
 * Messaging clients = rows in `agent_users` (one per platform user that has
 * messaged an agent). Each `(agent_id, platform, user_id)` is a single
 * messaging client visible to admins.
 */
async function listMessagingClients(options: {
	organizationId: string;
	agentId?: string | null;
}): Promise<MessagingClientRecord[]> {
	const sql = getDb();
	const rows = (await sql`
    SELECT
      au.agent_id,
      au.platform,
      au.user_id,
      au.created_at,
      a.name AS agent_name
    FROM agent_users au
    JOIN agents a
      ON a.organization_id = au.organization_id AND a.id = au.agent_id
    WHERE au.organization_id = ${options.organizationId}
      ${options.agentId ? sql`AND au.agent_id = ${options.agentId}` : sql``}
    ORDER BY au.created_at DESC
  `) as Array<{
		agent_id: string;
		platform: string;
		user_id: string;
		created_at: unknown;
		agent_name: string;
	}>;

	return rows.map((row) => {
		const lastSeenAt = asTimestamp(row.created_at) ?? Date.now();
		const platform = row.platform || "messaging";
		return {
			id: `${row.agent_id}:${row.platform}:${row.user_id}`,
			kind: "messaging" as const,
			title: row.user_id || `${platform} user`,
			identifier: row.user_id,
			platform,
			assignedAgentId: row.agent_id,
			assignedAgentName: row.agent_name,
			status: "linked",
			authState: "linked",
			lastSeenAt,
			userAgent: null,
			capabilities: null,
			externalUrl: externalUrlForMessagingIdentity(platform, row.user_id),
			linkedUserName: null,
			linkedUserEmail: null,
			firstParty: false as const,
			details: {
				connectionId: null,
				description: null,
				connectionMetadata: null,
			},
		};
	});
}

export async function countRuntimeMessagingClientsByAgent(
	organizationId: string,
): Promise<Map<string, Set<string>>> {
	const clients = await listMessagingClients({ organizationId });
	const counts = new Map<string, Set<string>>();

	for (const client of clients) {
		let ids = counts.get(client.assignedAgentId);
		if (!ids) {
			ids = new Set<string>();
			counts.set(client.assignedAgentId, ids);
		}
		ids.add(client.id);
	}

	return counts;
}

routes.get("/", mcpAuth, async (c) => {
	return withOrg(c, async () => {
		const organizationId = c.get("organizationId") as string;
		const agentId = c.req.query("agentId")?.trim() || null;
		const sql = getDb();
		const oauthClientsStore = new OAuthClientsStore(sql);
		const oauthClients =
			await oauthClientsStore.listClientsByOrganization(organizationId);

		const referencedAgentIds = new Set<string>();
		for (const client of oauthClients) {
			const metadata = asRecord(client.metadata);
			const lastAgentId =
				typeof metadata?.last_agent_id === "string"
					? metadata.last_agent_id
					: null;
			if (lastAgentId) referencedAgentIds.add(lastAgentId);
		}

		const agentNames = new Map<string, string>();
		if (referencedAgentIds.size > 0) {
			const rows = await sql`
        SELECT id, name
        FROM agents
        WHERE organization_id = ${organizationId}
          AND id = ANY(${pgTextArray([...referencedAgentIds])}::text[])
      `;
			for (const row of rows as Array<{ id: string; name: string }>) {
				agentNames.set(row.id, row.name);
			}
		}

		const mcpClients = oauthClients
			.map((client) => {
				const metadata = asRecord(client.metadata);
				const clientInfo = asRecord(metadata?.last_client_info);
				const capabilities = asRecord(metadata?.last_capabilities);
				const lastSeenAt =
					asTimestamp(metadata?.last_seen_at) ??
					client.client_id_issued_at * 1000;
				const assignedAgentId =
					typeof metadata?.last_agent_id === "string"
						? metadata.last_agent_id
						: null;

				if (agentId && assignedAgentId !== agentId) return null;

				const title =
					asNonEmptyString(clientInfo?.name) ||
					asNonEmptyString(client.client_name);
				const softwareId = asNonEmptyString(client.software_id);

				return {
					id: client.client_id,
					kind: "mcp" as const,
					title,
					registrationGroupKey:
						client.client_name && client.owner_user_id
							? JSON.stringify([
									client.client_name,
									client.owner_user_id,
									organizationId,
								])
							: client.client_id,
					identifier: client.client_id,
					platform: softwareId,
					assignedAgentId,
					assignedAgentName: assignedAgentId
						? (agentNames.get(assignedAgentId) ?? assignedAgentId)
						: null,
					status: client.active_token_count > 0 ? "connected" : "disconnected",
					authState: client.active_token_count > 0 ? "authorized" : "revoked",
					lastSeenAt,
					userAgent:
						typeof metadata?.last_user_agent === "string"
							? metadata.last_user_agent
							: null,
					capabilities,
					externalUrl:
						typeof client.client_uri === "string" &&
						client.client_uri.length > 0
							? client.client_uri
							: null,
					linkedUserName: client.user_name ?? null,
					linkedUserEmail: client.user_email ?? null,
					firstParty: isFirstPartyLobuClient(title, softwareId),
					details: {
						softwareVersion: client.software_version ?? null,
						redirectUris: client.redirect_uris,
						activeTokenCount: client.active_token_count,
						clientInfo,
					},
				};
			})
			.filter(
				(client): client is NonNullable<typeof client> => client !== null,
			);

		const messagingClients = await listMessagingClients({
			organizationId,
			agentId,
		});

		const clients = [...mcpClients, ...messagingClients].sort((a, b) => {
			const aSeen = a.lastSeenAt ?? 0;
			const bSeen = b.lastSeenAt ?? 0;
			return bSeen - aSeen;
		});

		return c.json({ clients });
	});
});

routes.delete("/mcp/:clientId", mcpAuth, async (c) => {
	return withOrgAdmin(c, async () => {
		const organizationId = c.get("organizationId") as string;
		const clientId = c.req.param("clientId");
		if (!clientId) {
			return c.json({ error: "Client ID is required" }, 400);
		}
		const sql = getDb();

		const rows = await sql`
	      SELECT
	        oc.id,
	        oc.client_name,
	        COALESCE(oc.user_id, org_token.user_id) AS owner_user_id
	      FROM oauth_clients oc
	      LEFT JOIN LATERAL (
	        SELECT ot.user_id
	        FROM oauth_tokens ot
	        WHERE ot.client_id = oc.id
	          AND ot.organization_id = ${organizationId}
	        -- Same ordering as listClientsByOrganization's owner pick (id breaks
	        -- created_at ties). If these two diverge, the page shows one owner
	        -- and Revoke kills a different one's grant.
	        ORDER BY ot.created_at DESC, ot.id DESC
	        LIMIT 1
	      ) org_token ON true
	      WHERE oc.id = ${clientId}
	        AND (
	          oc.organization_id = ${organizationId}
	          OR org_token.user_id IS NOT NULL
	        )
	      LIMIT 1
	    `;

		if (rows.length === 0) {
			return c.json({ error: "Client not found" }, 404);
		}

		const revokeAll = c.req.query("scope") === "all";
		let targetIds = [clientId];
		const target = rows[0] as {
			client_name: string | null;
			owner_user_id: string | null;
		};
		if (revokeAll && target.client_name && target.owner_user_id) {
			const siblings = await sql`
	        SELECT sibling.id
	        FROM oauth_clients sibling
	        LEFT JOIN LATERAL (
	          SELECT ot.user_id
	          FROM oauth_tokens ot
	          WHERE ot.client_id = sibling.id
	            AND ot.organization_id = ${organizationId}
	          ORDER BY ot.created_at DESC
	          LIMIT 1
	        ) org_token ON true
	        WHERE sibling.client_name = ${target.client_name}
	          AND COALESCE(sibling.user_id, org_token.user_id) = ${target.owner_user_id}
	          AND (
	            sibling.organization_id = ${organizationId}
	            OR org_token.user_id IS NOT NULL
	          )
	        ORDER BY sibling.id
	      `;
			const ids = (siblings as Array<{ id: string }>).map((r) => r.id);
			if (ids.length > 0) targetIds = ids;
		}

		// Scope the revocation to the owner we resolved and grouped on. One
		// registration can carry tokens for several people (RFC 7591 registration
		// is per-client, not per-user), so revoking org-wide would disconnect
		// bystanders who happen to share the app's registration.
		const clientsStore = new OAuthClientsStore(sql);
		for (const id of targetIds) {
			await clientsStore.revokeClientForOrganization(
				id,
				organizationId,
				target.owner_user_id,
			);
			await revokeInMemoryMcpSessionsForClient(
				id,
				organizationId,
				target.owner_user_id,
			);
		}
		return c.json({ success: true, revokedClientIds: targetIds });
	});
});

export { routes as clientRoutes };
