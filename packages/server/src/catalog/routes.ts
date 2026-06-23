import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import type { Env } from "../index";
import { orgContext } from "../lobu/stores/org-context";
import {
	listAgentInstalled,
	listOrgInstalled,
	parseKindsParam,
} from "./installed";
import { listCatalogEntries } from "./load";
import {
	AGENT_INSTALLED_KINDS,
	type AgentInstalledKind,
	CATALOG_KINDS,
	type CatalogKind,
	ORG_INSTALLED_KINDS,
	type OrgInstalledKind,
} from "./types";

const globalCatalogRoutes = new Hono();

globalCatalogRoutes.get("/", async (c) => {
	const kinds = parseKindsParam(c.req.query("kinds"), CATALOG_KINDS);
	const all = await listCatalogEntries(kinds as CatalogKind[]);
	const catalogs: Record<
		string,
		{ kind: CatalogKind; entries: typeof all.connectors }
	> = {};
	for (const kind of kinds) {
		catalogs[kind] = { kind, entries: all[kind] };
	}
	return c.json({ catalogs });
});

const orgInstalledRoutes = new Hono<{ Bindings: Env }>();

orgInstalledRoutes.use("*", mcpAuth);
orgInstalledRoutes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

orgInstalledRoutes.get("/", async (c) => {
	const kinds = parseKindsParam(c.req.query("kinds"), ORG_INSTALLED_KINDS);
	const installed = await listOrgInstalled(
		c.get("organizationId")!,
		kinds as OrgInstalledKind[],
		{
			organizationId: c.get("organizationId")!,
			userId: c.get("user")?.id ?? null,
			memberRole: c.get("memberRole") ?? null,
			isAuthenticated: Boolean(c.get("user")),
		},
	);
	return c.json({ installed });
});

orgInstalledRoutes.get("/agents/:agentId/installed", async (c) => {
	const kinds = parseKindsParam(c.req.query("kinds"), AGENT_INSTALLED_KINDS);
	const { agentId } = c.req.param();
	const installed = await listAgentInstalled(
		agentId,
		kinds as AgentInstalledKind[],
	);
	return c.json({ installed });
});

export { globalCatalogRoutes, orgInstalledRoutes };
