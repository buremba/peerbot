/**
 * ClientSDK `viewTemplates` namespace. Thin wrapper over `manageViewTemplates`.
 *
 * `resource_id` can be a string (entity_type slug) or a number (entity id)
 * depending on `resource_type`. The handler stores the whole template as a
 * single `json_template` object — callers may nest a `data_sources` key
 * inside it when they want SQL-backed sources.
 */

import type {
	ViewTemplateGetInput,
	ViewTemplateRemoveTabInput,
	ViewTemplateRollbackInput,
	ViewTemplateSetInput,
} from "@lobu/core/contracts/tools/manage-view-templates";
import type { Env } from "../../index";
import { manageViewTemplates } from "../../tools/admin/manage_view_templates";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ViewTemplatesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	get(input: ViewTemplateGetInput): Promise<unknown>;
	set(input: ViewTemplateSetInput): Promise<unknown>;
	rollback(input: ViewTemplateRollbackInput): Promise<unknown>;
	removeTab(input: ViewTemplateRemoveTabInput): Promise<unknown>;
}

export function buildViewTemplatesNamespace(
	ctx: ToolContext,
	env: Env,
): ViewTemplatesNamespace {
	const { manage, method } = createActionCaller(
		manageViewTemplates,
		env,
		ctx,
		"viewTemplates",
	);

	return {
		manage,
		get: method("get"),
		set: method("set"),
		rollback: method("rollback"),
		removeTab: method("remove_tab"),
	};
}
