/**
 * ClientSDK `knowledge` namespace.
 *
 * Wraps `search_memory`, `saveContent` (save_memory),
 * `getContent` (read_knowledge), and `deleteContent` (delete_knowledge).
 * The SDK surface mirrors the MCP tool surface for consistency.
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
	content: string;
	semantic_type: string;
	metadata?: Record<string, unknown>;
	title?: string;
	slug?: string;
}

export interface KnowledgeReadInput {
	/** Fetch a single content event by id. */
	content_id?: number;
	/** Fetch knowledge for a watcher window (prompt rendering). */
	watcher_id?: number;
	since?: string;
	until?: string;
	limit?: number;
	before_occurred_at?: string;
	before_id?: number;
	entity_ids?: number[];
}

export type KnowledgeDeleteInput =
	| number
	| { event_id?: number; event_ids?: number[]; reason?: string };

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
				typeof input === "number" ? { event_id: input } : (input ?? {});
			return deleteContent(args as never, env, ctx) as Promise<unknown>;
		},
	};
}
