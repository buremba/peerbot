/**
 * ClientSDK `classifiers` namespace. Thin wrapper over `manageClassifiers`.
 *
 * Most CRUD actions use `classifier_id: number`; `classify` uses
 * `classifier_slug: string`. The namespace keeps those distinct.
 */

import type { Env } from "../../index";
import { manageClassifiers } from "../../tools/admin/manage_classifiers";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ClassifierCreateInput {
	/** Model to embed the label vectors under; defaults to the configured one. */
	embedding_model?: string;
	slug: string;
	name: string;
	description?: string;
	attribute_key: string;
	attribute_values?: Record<
		string,
		{
			description: string;
			examples: string[];
			embedding?: number[] | null;
		}
	>;
	entity_id?: number;
	/** Omit for an org-level classifier (the only kind `apply` and the
	 *  reconciliation job match); set to scope to a single Automation. */
	automation_id?: string;
	min_similarity?: number;
	fallback_value?: unknown;
	created_by?: string;
}

export interface ClassifierClassifyInput {
	classifier_slug: string;
	/** Single-mode update. */
	content_id?: number;
	value?: string | null;
	/** Batch mode. */
	classifications?: Array<{
		content_id: number;
		value: string | null;
		reasoning?: string;
	}>;
	source?: "llm" | "user";
	reasoning?: string;
}

/**
 * `apply` runs the classifier's embedding match over content ids you supply.
 * Unlike the reconciliation cron it needs no entity link, so it is the only way
 * to classify org-scoped feed content. Ids that produce no classification come
 * back with a reason (`not_in_organization` | `superseded` | `not_embedded` |
 * `below_threshold`) rather than as a silent shortfall.
 */
export interface ClassifierApplyInput {
	classifier_slug: string;
	content_ids: number[];
	/**
	 * Vector space to match in; defaults to the deployment's configured model.
	 * The classifier's label vectors must already live in this model too (embed
	 * them with `generateEmbeddings({ embedding_model })`), and so must the
	 * events — ids without a vector in this model come back `not_embedded`.
	 */
	embedding_model?: string;
}

export interface ClassifiersNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: { entity_id?: number; status?: string }): Promise<unknown>;
	create(input: ClassifierCreateInput): Promise<unknown>;
	generateEmbeddings(input: {
		classifier_id: number;
		force_regenerate?: boolean;
		/** Model to embed the label vectors under; defaults to the configured one. */
		embedding_model?: string;
	}): Promise<unknown>;
	delete(input: { classifier_id: number }): Promise<unknown>;
	classify(input: ClassifierClassifyInput): Promise<unknown>;
	apply(input: ClassifierApplyInput): Promise<unknown>;
}

export function buildClassifiersNamespace(
	ctx: ToolContext,
	env: Env,
): ClassifiersNamespace {
	const { manage, action } = createActionCaller(manageClassifiers, env, ctx, "classifiers");

	return {
		manage,
		list: (input) => action("list", input),
		create: (input) => action("create", input),
		generateEmbeddings: (input) => action("generate_embeddings", input),
		delete: (input) => action("delete", input),
		classify: (input) => action("classify", input),
		apply: (input) => action("apply", input),
	};
}
