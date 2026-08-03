/**
 * ClientSDK `knowledge` namespace.
 *
 * Wraps the `search_memory`, `save_memory`, and `read_knowledge` handlers.
 * `deleteContent` is SDK-only, exposed as `client.knowledge.delete` rather
 * than as a registered MCP tool.
 */

import type { Env } from "../../index";
import { deleteContent } from "../../tools/delete_content";
import { getContent } from "../../tools/get_content";
import type { ToolContext } from "../../tools/registry";
import { saveContent } from "../../tools/save_content";
import { search } from "../../tools/search";

export interface KnowledgeSearchInput {
	query?: string;
	entity_type?: string;
	entity_id?: number;
	parent_id?: number;
	market?: string;
	category?: string;
	fuzzy?: boolean;
	min_similarity?: number;
	include_connections?: boolean;
	include_content?: boolean;
	limit?: number;
}

export interface KnowledgeSaveInput {
	entity_ids?: number[];
	content?: string;
	semantic_type: string;
	metadata?: Record<string, unknown>;
	title?: string;
	slug?: string;
	author?: string;
	payload_type?: "text" | "markdown" | "json_template" | "media" | "empty";
	source_url?: string;
	parent_event_id?: number;
	idempotency_key?: string;
	occurred_at?: string;
	behavior_source?: { behavior_id: number; window_id: number };
}

export interface KnowledgeReadInput {
	/** Fetch specific content events by id. */
	content_ids?: number[];
	/** Fetch structured knowledge for a Behavior window. */
	behavior_id?: number;
	since?: string;
	until?: string;
	limit?: number;
	before_occurred_at?: string;
	before_id?: number;
	entity_ids?: number[];
}

export type KnowledgeDeleteInput =
	| number
	| { content_id?: number; content_ids?: number[]; reason?: string };

export interface KnowledgeNamespace {
	search(input: KnowledgeSearchInput): Promise<unknown>;
	save(input: KnowledgeSaveInput): Promise<unknown>;
	read(input: KnowledgeReadInput): Promise<unknown>;
	delete(input: KnowledgeDeleteInput): Promise<unknown>;
}

export function buildKnowledgeNamespace(
	ctx: ToolContext,
	env: Env,
): KnowledgeNamespace {
	return {
		search(input) {
			return search(input as never, env, ctx) as Promise<unknown>;
		},
		save(input) {
			return saveContent(input as never, env, ctx) as Promise<unknown>;
		},
		read(input) {
			return getContent(input as never, env, ctx) as Promise<unknown>;
		},
		delete(input) {
			const args =
				typeof input === "number" ? { content_id: input } : (input ?? {});
			return deleteContent(args as never, env, ctx) as Promise<unknown>;
		},
	};
}
