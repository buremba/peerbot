import { type Static, Type } from "@sinclair/typebox";
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
	action: Type.Literal("list_catalog", {
		description:
			"List available (manifest) catalog entries — connectors, skills, watcher templates. Each connector entry's `detail.source_uri` can be passed to `manage_connections` action `install_connector`.",
	}),
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
	action: Type.Literal("list_installed", {
		description:
			"List installed kinds for the org (connectors, watchers) and/or agent (skills, providers, guardrails, channels). Pass `include_catalog: true` to merge available catalog entries with `installed`/`installable` flags.",
	}),
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

/**
 * Result of `manage_catalog` — discriminated union (on `action`, plus an error
 * variant). TypeBox-first: `Static<>` derives the TS type from the same schema
 * exposed as the tool's `outputSchema`.
 *
 * The connector entries under `list_catalog` are typed so that
 * `detail.source_uri` is structurally visible — that's the field that feeds
 * into `manage_connections` action `install_connector`, and making it
 * machine-traceable on the wire is the point of this schema. Skills/watchers
 * stay `Type.Unknown()` (looser shapes, not part of the install link).
 */
const CatalogConnectorEntrySchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	version: Type.Optional(Type.String()),
	description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	detail: Type.Object(
		{
			source_uri: Type.Optional(Type.String()),
			auth_schema: Type.Optional(Type.Unknown()),
			feeds_schema: Type.Optional(Type.Unknown()),
			actions_schema: Type.Optional(Type.Unknown()),
			options_schema: Type.Optional(Type.Unknown()),
			required_capability: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			favicon_domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			runtime: Type.Optional(Type.Unknown()),
			login_enabled: Type.Optional(Type.Boolean()),
		},
		// Catalog `detail` is open-ended (each connector may carry extras); don't
		// reject entries with fields beyond the ones enumerated above.
		{ additionalProperties: true },
	),
});

export const ManageCatalogResultSchema = Type.Union([
	Type.Object({ error: Type.String() }),
	Type.Object({
		action: Type.Literal("list_catalog"),
		catalogs: Type.Record(
			Type.String(),
			Type.Object({
				kind: Type.String(),
				entries: Type.Array(Type.Union([CatalogConnectorEntrySchema, Type.Unknown()])),
			})
		),
	}),
	Type.Object({
		action: Type.Literal("list_installed"),
		installed: Type.Record(Type.String(), Type.Unknown()),
	}),
]);
export type ManageCatalogResult = Static<typeof ManageCatalogResultSchema>;

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

async function handleListCatalog(args: ListCatalogArgs): Promise<ManageCatalogResult> {
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
): Promise<ManageCatalogResult> {
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
			? (["skills", "providers", "guardrails"] as AgentInstalledKind[])
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
