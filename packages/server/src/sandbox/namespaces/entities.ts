/**
 * ClientSDK `entities` namespace.
 *
 * Delegates to `manageEntity` with action-discriminated payloads. Per-call auth
 * checks fire inside the handler; this wrapper does not duplicate them.
 */

import type { Env } from "../../index";
import { manageEntity } from "../../tools/admin/manage_entity";
import type { ToolContext } from "../../tools/registry";
import { search } from "../../tools/search";
import { createActionCaller } from "./action-call";

export interface EntityListFilter {
	entity_type?: string;
	search?: string;
	limit?: number;
	offset?: number;
	sort_by?: string;
	sort_order?: "asc" | "desc";
	category?: string;
	main_market?: string;
	market?: string;
}

export interface EntityCreateInput {
	entity_type: string;
	name: string;
	slug?: string;
	content?: string;
	parent_id?: number;
	metadata?: Record<string, unknown>;
	enabled_classifiers?: string[];
	domain?: string;
	category?: string;
	platform_type?: string;
	main_market?: string;
	market?: string;
	link?: string;
}

export interface EntityUpdateInput {
	entity_id: number;
	name?: string;
	slug?: string;
	content?: string;
	metadata?: Record<string, unknown>;
	enabled_classifiers?: string[];
	domain?: string;
	category?: string;
	platform_type?: string;
	main_market?: string;
	market?: string;
	link?: string;
	/** Optional note explaining a human correction; stored on the per-field
	 *  ownership marker for the metadata fields this update sets. */
	field_note?: string;
	/** Metadata field names whose current value the human approves as-is:
	 *  no value change, but each becomes human-owned. */
	affirm_fields?: string[];
}

export interface EntityLinkInput {
	from_entity_id: number;
	to_entity_id: number;
	relationship_type_slug: string;
	source?: "ui" | "llm" | "feed" | "api";
	confidence?: number;
	metadata?: Record<string, unknown>;
}

export interface EntitiesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(filter?: EntityListFilter): Promise<unknown>;
	get(input: {
		entity_id: number;
		include_deleted?: boolean;
	}): Promise<unknown>;
	create(input: EntityCreateInput): Promise<unknown>;
	update(input: EntityUpdateInput): Promise<unknown>;
	delete(input: {
		entity_id: number;
		force_delete_tree?: boolean;
		/** Preflight only: report what would be removed/detached, mutate nothing. */
		dry_run?: boolean;
	}): Promise<unknown>;
	link(input: EntityLinkInput): Promise<unknown>;
	unlink(input: {
		from_entity_id: number;
		to_entity_id: number;
		relationship_type_slug: string;
	}): Promise<unknown>;
	updateLink(input: {
		from_entity_id: number;
		to_entity_id: number;
		relationship_type_slug: string;
		metadata?: Record<string, unknown>;
	}): Promise<unknown>;
	listLinks(input: {
		entity_id: number;
		direction?: "outbound" | "inbound" | "both";
		relationship_type_slug?: string;
		confidence_min?: number;
		include_deleted?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<unknown>;
	search(query: string, options?: { limit?: number }): Promise<unknown>;
}

export function buildEntitiesNamespace(
	ctx: ToolContext,
	env: Env,
): EntitiesNamespace {
	const { manage, method } = createActionCaller(manageEntity, env, ctx, "entities");

	return {
		manage,
		list: method("list"),
		get: method("get"),
		create: method("create"),
		update: method("update"),
		delete: method("delete"),
		link: method("link"),
		unlink: method("unlink"),
		updateLink: method("update_link"),
		listLinks: method("list_links"),
		search(query, options) {
			return search(
				{ query, limit: options?.limit } as never,
				env,
				ctx,
			) as Promise<unknown>;
		},
	};
}
