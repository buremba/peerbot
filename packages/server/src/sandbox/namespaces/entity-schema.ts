/**
 * ClientSDK `entitySchema` namespace. Delegates to `manageEntitySchema`, which
 * is doubly discriminated by `schema_type` (entity_type vs relationship_type)
 * and `action`.
 *
 * Field names mirror the handler: plain `slug` for the type identifier,
 * `source_entity_type_slug` / `target_entity_type_slug` / `relationship_type_slug`
 * for add_rule.
 */

import type { Env } from "../../index";
import { manageEntitySchema } from "../../tools/admin/manage_entity_schema";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface EntitySchemaAddRuleInput {
  slug: string;
  source_entity_type_slug: string;
  target_entity_type_slug: string;
  relationship_type_slug?: string;
  description?: string;
}

export interface EntitySchemaNamespace {
  manage(input: Record<string, unknown>): Promise<unknown>;
  listTypes(): Promise<unknown>;
  getType(slug: string): Promise<unknown>;
  createType(input: {
    slug: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    metadata_schema?: Record<string, unknown>;
    event_kinds?: Record<string, unknown>;
  }): Promise<unknown>;
  updateType(input: {
    slug: string;
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    metadata_schema?: Record<string, unknown>;
    event_kinds?: Record<string, unknown>;
  }): Promise<unknown>;
  deleteType(slug: string): Promise<unknown>;
  auditType(slug: string): Promise<unknown>;

  listRelTypes(): Promise<unknown>;
  getRelType(slug: string): Promise<unknown>;
  createRelType(input: {
    slug: string;
    name: string;
    description?: string;
    inverse_type_slug?: string | null;
  }): Promise<unknown>;
  updateRelType(input: {
    slug: string;
    name?: string;
    description?: string;
    inverse_type_slug?: string | null;
  }): Promise<unknown>;
  deleteRelType(slug: string): Promise<unknown>;

  addRule(input: EntitySchemaAddRuleInput): Promise<unknown>;
  removeRule(input: { slug: string; rule_id: number }): Promise<unknown>;
  listRules(slug: string): Promise<unknown>;
}

export function buildEntitySchemaNamespace(
  ctx: ToolContext,
  env: Env,
): EntitySchemaNamespace {
  const { manage, action } = createActionCaller(manageEntitySchema, env, ctx);
  const callEntity = <T>(payload: Record<string, unknown>): Promise<T> =>
    action(payload.action as string, { schema_type: "entity_type", ...payload });
  const callRel = <T>(payload: Record<string, unknown>): Promise<T> =>
    action(payload.action as string, { schema_type: "relationship_type", ...payload });

  return {
    manage,
    listTypes: () => callEntity({ action: "list" }),
    getType: (slug) => callEntity({ action: "get", slug }),
    createType: (input) => callEntity({ action: "create", ...input }),
    updateType: (input) => callEntity({ action: "update", ...input }),
    deleteType: (slug) => callEntity({ action: "delete", slug }),
    auditType: (slug) => callEntity({ action: "audit", slug }),

    listRelTypes: () => callRel({ action: "list" }),
    getRelType: (slug) => callRel({ action: "get", slug }),
    createRelType: (input) => callRel({ action: "create", ...input }),
    updateRelType: (input) => callRel({ action: "update", ...input }),
    deleteRelType: (slug) => callRel({ action: "delete", slug }),

    addRule: (input) => callRel({ action: "add_rule", ...input }),
    removeRule: (input) => callRel({ action: "remove_rule", ...input }),
    listRules: (slug) => callRel({ action: "list_rules", slug }),
  };
}
