/**
 * ClientSDK `knowledge` namespace.
 *
 * Wraps the `search_memory`, `save_memory`, and `read_knowledge` handlers.
 * `deleteContent` is SDK-only, exposed as `client.knowledge.delete` rather
 * than as a registered MCP tool.
 */

import type { DeleteContentArgs } from "@lobu/core/contracts/tools/delete-knowledge";
import type { SaveContentInput } from "@lobu/core/contracts/tools/save-memory";
import type { Env } from "../../index";
import { deleteContent } from "../../tools/delete_content";
import { getContent, type PublicGetContentArgs } from "../../tools/get_content";
import type { ToolContext } from "../../tools/registry";
import { saveContent } from "../../tools/save_content";
import { type PublicSearchArgs, search } from "../../tools/search";
import { createValidatedSdkMethod } from "../sdk-preflight";
import type {} from "./knowledge.typecheck";

/**
 * Derived from `SearchSchema`, not hand-listed: the hand-written version had
 * dropped `title`, `content_limit`, `metadata_filter`,
 * `include_public_catalogs` and `workspace`, advertising a narrower filter set
 * than `search_memory` actually accepts. Pinned by
 * `KnowledgeSearchInputContract` in `./knowledge.typecheck`.
 */
export type KnowledgeSearchInput = PublicSearchArgs;

/**
 * `client.knowledge.save` takes the `save_memory` contract's own input type,
 * declared once in core and shared with `@lobu/connector-sdk`. The hand-written
 * union here had drifted: it advertised a `slug` field the validator rejects
 * and omitted `supersedes_event_id`. Pinned by `KnowledgeSaveInputContract`
 * in `./knowledge.typecheck`.
 */
export type KnowledgeSaveInput = SaveContentInput;

/**
 * `client.knowledge.read` forwards straight to `getContent`, so its input IS
 * the tool's public schema. Hand-listing the fields drifted: it had grown to
 * omit real filters the handler accepts (`semantic_type`, `entity_types`,
 * `query`, …) while advertising `entity_ids`, which `getContent` only ever
 * reads off the ROW — never off the input — so a caller filtering by it got a
 * hard `unknown argument(s)` error from the argument validator, not unfiltered
 * results. Deriving the type keeps the two in lockstep.
 */
export type KnowledgeReadInput = PublicGetContentArgs;

export type KnowledgeDeleteInput = number | DeleteContentArgs;

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
	const prepareDelete = (input: KnowledgeDeleteInput) =>
		typeof input === "number" ? { content_id: input } : (input ?? {});
	return {
		search(input) {
			return search(input as never, env, ctx) as Promise<unknown>;
		},
		save: createValidatedSdkMethod(
			saveContent,
			[env, ctx],
			{
				path: "knowledge.save",
				prepareArgs: (input) => input,
			},
		),
		read(input) {
			return getContent(input as never, env, ctx) as Promise<unknown>;
		},
		delete: createValidatedSdkMethod(
			deleteContent,
			[env, ctx],
			{
				path: "knowledge.delete",
				prepareArgs: prepareDelete,
			},
		),
	};
}
