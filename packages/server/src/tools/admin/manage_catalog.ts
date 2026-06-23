import { Type } from "@sinclair/typebox";
import { listAgentInstalled, listOrgInstalled } from "../../catalog/installed";
import { listCatalogEntries } from "../../catalog/load";
import {
	AGENT_INSTALLED_KINDS,
	type AgentInstalledKind,
	CATALOG_KINDS,
	type CatalogKind,
	ORG_INSTALLED_KINDS,
	type OrgInstalledKind,
} from "../../catalog/types";
import type { ToolContext } from "../registry";
import { action, defineActionTool } from "./action-tool";

export const ListCatalogAction = Type.Object({
	action: Type.Literal("list_catalog"),
	kinds: Type.Optional(
		Type.Array(
			Type.Union([Type.Literal("connectors"), Type.Literal("skills")]),
			{
				description: "Manifest catalog kinds. Defaults to all.",
			},
		),
	),
});

export const ListInstalledAction = Type.Object({
	action: Type.Literal("list_installed"),
	kinds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Installed kinds. Org: connectors, watchers. Agent: skills, providers, guardrails, channels.",
		}),
	),
	agent_id: Type.Optional(
		Type.String({ description: "Agent id — required for agent-scoped kinds." }),
	),
});

export const ManageCatalogSchema = Type.Union([
	ListCatalogAction,
	ListInstalledAction,
]);

export type ListCatalogArgs = {
	action: "list_catalog";
	kinds?: CatalogKind[];
};

export type ListInstalledArgs = {
	action: "list_installed";
	kinds?: string[];
	agent_id?: string;
};

async function handleListCatalog(args: ListCatalogArgs): Promise<unknown> {
	const kinds = args.kinds?.length ? args.kinds : [...CATALOG_KINDS];
	const all = await listCatalogEntries(kinds);
	const catalogs: Record<
		string,
		{ kind: CatalogKind; entries: (typeof all)["connectors"] }
	> = {};
	for (const kind of kinds) {
		catalogs[kind] = { kind, entries: all[kind] };
	}
	return { action: "list_catalog", catalogs };
}

async function handleListInstalled(
	args: ListInstalledArgs,
	ctx: ToolContext,
): Promise<unknown> {
	const agentKinds = (args.kinds ?? []).filter((k): k is AgentInstalledKind =>
		(AGENT_INSTALLED_KINDS as readonly string[]).includes(k),
	);
	const orgKinds = (args.kinds ?? []).filter((k): k is OrgInstalledKind =>
		(ORG_INSTALLED_KINDS as readonly string[]).includes(k),
	);

	const resolvedOrgKinds =
		orgKinds.length > 0
			? orgKinds
			: args.agent_id
				? []
				: (["connectors"] as OrgInstalledKind[]);
	const resolvedAgentKinds =
		agentKinds.length > 0
			? agentKinds
			: args.agent_id
				? ([
						"skills",
						"providers",
						"guardrails",
						"channels",
					] as AgentInstalledKind[])
				: [];

	const installed: Record<string, unknown> = {};

	if (resolvedOrgKinds.length > 0) {
		Object.assign(
			installed,
			await listOrgInstalled(ctx.organizationId, resolvedOrgKinds, ctx),
		);
	}

	if (args.agent_id && resolvedAgentKinds.length > 0) {
		Object.assign(
			installed,
			await listAgentInstalled(args.agent_id, resolvedAgentKinds),
		);
	}

	return { action: "list_installed", installed };
}

const manageCatalogTool = defineActionTool("manage_catalog", {
	list_catalog: action(ListCatalogAction, (_args, _ctx, _env) =>
		handleListCatalog(_args as ListCatalogArgs),
	),
	list_installed: action(ListInstalledAction, (args, ctx) =>
		handleListInstalled(args as ListInstalledArgs, ctx),
	),
});

export const manageCatalog = manageCatalogTool.run;
