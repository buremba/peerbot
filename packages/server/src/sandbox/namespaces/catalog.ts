import type { ActionInput } from "@lobu/core/contracts/tools/action-input";
import type { ManageCatalogArgs } from "@lobu/core/contracts/tools/manage-catalog";
import type { Env } from "../../index";
import { manageCatalog } from "../../tools/admin/manage_catalog";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export type CatalogListCatalogInput = ActionInput<
	ManageCatalogArgs,
	"list_catalog"
>;
export type CatalogListInstalledInput = ActionInput<
	ManageCatalogArgs,
	"list_installed"
>;

export interface CatalogNamespace {
	listCatalog(input?: CatalogListCatalogInput): Promise<unknown>;
	listInstalled(input?: CatalogListInstalledInput): Promise<unknown>;
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
