import type { Env } from "../../index";
import { manageCatalog } from "../../tools/admin/manage_catalog";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface CatalogNamespace {
	listCatalog(input?: {
		kinds?: Array<"connectors" | "skills">;
	}): Promise<unknown>;
	listInstalled(input?: {
		kinds?: string[];
		agent_id?: string;
	}): Promise<unknown>;
}

export function buildCatalogNamespace(
	ctx: ToolContext,
	env: Env,
): CatalogNamespace {
	const { action } = createActionCaller(manageCatalog, env, ctx);

	return {
		listCatalog: (input) => action("list_catalog", input ?? {}),
		listInstalled: (input) => action("list_installed", input ?? {}),
	};
}
