import { Type } from "@sinclair/typebox";
import { listAgentInstalled, listOrgInstalled } from "../../catalog/installed";
import { listCatalogEntries } from "../../catalog/load";
import { buildCatalogListResponse } from "../../catalog/responses";
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
			Type.Union([
				Type.Literal("connectors"),
				Type.Literal("skills"),
				Type.Literal("watchers"),
			]),
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
	include_catalog: Type.Optional(
		Type.Boolean({
			description:
				"Merge global catalog entries for connectors (org) or skills (agent).",
		}),
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
	include_catalog?: boolean;
};

async function handleListCatalog(args: ListCatalogArgs): Promise<unknown> {
	const kinds = args.kinds?.length ? args.kinds : [...CATALOG_KINDS];
	const all = await listCatalogEntries(kinds);
	return {
		action: "list_catalog",
		...buildCatalogListResponse(kinds, all),
	};
}

async function handleListInstalled(
	args: ListInstalledArgs,
	ctx: ToolContext,
): Promise<unknown> {
	const requestedKinds = args.kinds?.length ? args.kinds : undefined;
	const isAgentKind = (k: string): k is AgentInstalledKind =>
		(AGENT_INSTALLED_KINDS as readonly string[]).includes(k);
	const isOrgKind = (k: string): k is OrgInstalledKind =>
		(ORG_INSTALLED_KINDS as readonly string[]).includes(k);

	const agentKinds = (requestedKinds ?? []).filter(isAgentKind);
	const orgKinds = (requestedKinds ?? []).filter(isOrgKind);
	const unknownKinds = (requestedKinds ?? []).filter(
		(k) => !isAgentKind(k) && !isOrgKind(k),
	);
	if (unknownKinds.length > 0) {
		return {
			error: `Unsupported installed kind(s): ${unknownKinds.join(", ")}`,
		};
	}
	if (!args.agent_id && agentKinds.length > 0) {
		return {
			error: "`agent_id` is required for agent-scoped installed kinds.",
		};
	}

	const resolvedOrgKinds = requestedKinds
		? orgKinds
		: args.agent_id
			? []
			: (["connectors"] as OrgInstalledKind[]);
	const resolvedAgentKinds = requestedKinds
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

	const listOptions = { includeCatalog: Boolean(args.include_catalog) };

	if (resolvedOrgKinds.length > 0) {
		Object.assign(
			installed,
			await listOrgInstalled(
				ctx.organizationId,
				resolvedOrgKinds,
				ctx,
				listOptions,
			),
		);
	}

	if (args.agent_id && resolvedAgentKinds.length > 0) {
		Object.assign(
			installed,
			await listAgentInstalled(args.agent_id, resolvedAgentKinds, listOptions),
		);
	}

	return { action: "list_installed", installed };
}

const manageCatalogTool = defineActionTool("manage_catalog", {
	list_catalog: action(ListCatalogAction, (args) =>
		handleListCatalog(args as ListCatalogArgs),
	),
	list_installed: action(ListInstalledAction, (args, ctx) =>
		handleListInstalled(args as ListInstalledArgs, ctx),
	),
});

export const manageCatalog = manageCatalogTool.run;
