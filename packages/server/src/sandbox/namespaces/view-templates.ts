/**
 * ClientSDK `viewTemplates` namespace. Thin wrapper over `manageViewTemplates`.
 *
 * `resource_id` can be a string (entity_type slug) or a number (entity id)
 * depending on `resource_type`. The handler stores the whole template as a
 * single `json_template` object — callers may nest a `data_sources` key
 * inside it when they want SQL-backed sources.
 */

import type { Env } from "../../index";
import { manageViewTemplates } from "../../tools/admin/manage_view_templates";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

type ResourceType = "entity_type" | "entity";
type ResourceId = string | number;

export interface ViewTemplateSetInput {
  resource_type: ResourceType;
  resource_id: ResourceId;
  json_template: Record<string, unknown>;
  tab_name?: string;
  tab_order?: number;
  change_notes?: string;
}

export interface ViewTemplatesNamespace {
  manage(input: Record<string, unknown>): Promise<unknown>;
  get(input: {
    resource_type: ResourceType;
    resource_id: ResourceId;
    tab_name?: string;
  }): Promise<unknown>;
  set(input: ViewTemplateSetInput): Promise<unknown>;
  rollback(input: {
    resource_type: ResourceType;
    resource_id: ResourceId;
    /** Version number (not the row id) to roll back to. */
    version: number;
    tab_name?: string;
  }): Promise<unknown>;
  removeTab(input: {
    resource_type: ResourceType;
    resource_id: ResourceId;
    tab_name: string;
  }): Promise<unknown>;
}

export function buildViewTemplatesNamespace(
  ctx: ToolContext,
  env: Env,
): ViewTemplatesNamespace {
  const { manage, action } = createActionCaller(manageViewTemplates, env, ctx);

  return {
    manage,
    get: (input) => action("get", input),
    set: (input) => action("set", input),
    rollback: (input) => action("rollback", input),
    removeTab: (input) => action("remove_tab", input),
  };
}
