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
import { createActionCaller, idArg } from "./action-call";

export interface EntitySchemaAddRuleInput {
	slug: string;
	source_entity_type_slug: string;
	target_entity_type_slug: string;
	relationship_type_slug?: string;
	description?: string;
}

export interface EntitySchemaNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	listTypes(input?: { list_scope?: "accessible" | "organization" }): Promise<unknown>;
	getType(slug: string): Promise<unknown>;
	createType(input: {
		slug: string;
		name: string;
		description?: string;
		icon?: string;
		color?: string;
		metadata_schema?: Record<string, unknown>;
		event_kinds?: Record<string, unknown> | null;
		/**
		 * Make the type derived (a SQL view); `null`/omit ⇒ a stored type. With
		 * `connection`, the view runs LIVE against that connection's external DB
		 * (read-only pushdown) instead of the org's internal tables.
		 */
		backing?: { sql: string; connection?: string } | null;
		/** Declared metric contract (eventSets/measures/dimensions/segments); `null` clears it. */
		metrics_config?: Record<string, unknown> | null;
	}): Promise<unknown>;
	updateType(input: {
		slug: string;
		name?: string;
		description?: string;
		icon?: string;
		color?: string;
		metadata_schema?: Record<string, unknown>;
		event_kinds?: Record<string, unknown> | null;
		/** Set/clear the derived view; omit to leave backing unchanged. With
		 *  `connection`, the view reads live from that external connection (pushdown). */
		backing?: { sql: string; connection?: string } | null;
		/** Set/clear declared metrics; `null` clears, omit to leave unchanged. */
		metrics_config?: Record<string, unknown> | null;
	}): Promise<unknown>;
	deleteType(input: { slug: string }): Promise<unknown>;
	auditType(slug: string): Promise<unknown>;

	listRelTypes(input?: { list_scope?: "accessible" | "organization" }): Promise<unknown>;
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
	deleteRelType(input: { slug: string }): Promise<unknown>;

	addRule(input: EntitySchemaAddRuleInput): Promise<unknown>;
	removeRule(input: { slug: string; rule_id: number }): Promise<unknown>;
	listRules(input: { slug: string }): Promise<unknown>;
}

export function buildEntitySchemaNamespace(
	ctx: ToolContext,
	env: Env,
): EntitySchemaNamespace {
	const { manage, method } = createActionCaller(
		manageEntitySchema,
		env,
		ctx,
		"entitySchema",
	);
	const entityMethod = (
		actionName: string,
		publicMethod: string,
		mapArgs: (...args: any[]) => object = (input) => input ?? {},
	) =>
		method(actionName, {
			publicMethod,
			mapArgs: (...args) => ({
				...mapArgs(...args),
				schema_type: "entity_type",
			}),
		});
	const relationshipMethod = (
		actionName: string,
		publicMethod: string,
		mapArgs: (...args: any[]) => object = (input) => input ?? {},
	) =>
		method(actionName, {
			publicMethod,
			mapArgs: (...args) => ({
				...mapArgs(...args),
				schema_type: "relationship_type",
			}),
		});

	return {
		manage,
		listTypes: entityMethod("list", "listTypes"),
		getType: entityMethod("get", "getType", (slug) => ({
			slug: idArg("entitySchema.getType", "slug", slug, "string"),
		})),
		createType: entityMethod("create", "createType"),
		updateType: entityMethod("update", "updateType"),
		deleteType: entityMethod("delete", "deleteType"),
		auditType: entityMethod("audit", "auditType", (slug) => ({
			slug: idArg("entitySchema.auditType", "slug", slug, "string"),
		})),

		listRelTypes: relationshipMethod("list", "listRelTypes"),
		getRelType: relationshipMethod("get", "getRelType", (slug) => ({
			slug: idArg("entitySchema.getRelType", "slug", slug, "string"),
		})),
		createRelType: relationshipMethod("create", "createRelType"),
		updateRelType: relationshipMethod("update", "updateRelType"),
		deleteRelType: relationshipMethod("delete", "deleteRelType"),

		addRule: relationshipMethod("add_rule", "addRule"),
		removeRule: relationshipMethod("remove_rule", "removeRule"),
		listRules: relationshipMethod("list_rules", "listRules"),
	};
}
