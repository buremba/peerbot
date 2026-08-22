import type { Env } from "../../index";
import type { ListCatalogArgs } from "@lobu/core/contracts/tools/manage-catalog";
import { manageCatalog } from "../../tools/admin/manage_catalog";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface CatalogNamespace {
	listCatalog(input?: Omit<ListCatalogArgs, "action">): Promise<unknown>;
	listInstalled(input?: {
		kinds?: string[];
		agent_id?: string;
	}): Promise<unknown>;
}

export function buildCatalogNamespace(
	ctx: ToolContext,
	env: Env
): CatalogNamespace {
	const { method } = createActionCaller(manageCatalog, env, ctx, "catalog");

	return {
		listCatalog: method("list_catalog", { publicMethod: "listCatalog" }),
		listInstalled: method("list_installed", { publicMethod: "listInstalled" }),
	};
}
