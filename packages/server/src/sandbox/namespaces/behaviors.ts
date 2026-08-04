/**
 * ClientSDK `behaviors` namespace. Thin, action-complete wrapper over
 * `manageBehaviors` + `getBehavior`.
 *
 * Keep this surface in sync with `ManageBehaviorsSchema`: every
 * `manage_behaviors.action` should either have a named SDK method below or be
 * reachable via `behaviors.manage({ action, ... })`.
 */

import type { Env } from "../../index";
import type {
	BehaviorExecutionConfig,
	BehaviorSource,
	BehaviorTrigger,
	ListBehaviorsArgs,
} from "@lobu/core/contracts/tools/manage-behaviors";
import {
	type ManageBehaviorsArgs,
	manageBehaviors,
} from "../../tools/admin/manage_behaviors";
import { getBehavior } from "../../tools/get_behavior";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

type BehaviorId = string;
type BehaviorActionInput = Omit<ManageBehaviorsArgs, "action" | "behavior_id"> & {
	behavior_id?: BehaviorId;
};

export type BehaviorListFilter = ListBehaviorsArgs;

export interface BehaviorCreateInput {
	/** Attach the Behavior to an entity. Omit for an org-scoped/global Behavior. */
	entity_id?: number;
	prompt: string;
	sources?: BehaviorSource[];
	triggers?: BehaviorTrigger[];
	slug?: string;
	name?: string;
	description?: string;
	outputs?: Record<string, unknown>;
	classifiers?: Record<string, unknown>;
	reactions_guidance?: string;
	reaction_script?: string;
	agent_id?: string;
	model_config?: Record<string, unknown>;
	execution_config?: BehaviorExecutionConfig;
	tags?: string[];
}

export interface BehaviorUpdateInput {
	behavior_id: BehaviorId;
	triggers?: BehaviorTrigger[];
	agent_id?: string;
	model_config?: Record<string, unknown>;
	/** `null` clears a previously-saved config back to NULL/defaults. */
	execution_config?: BehaviorExecutionConfig | null;
}

export interface BehaviorCompleteWindowInput {
	behavior_id: BehaviorId;
	/** JWT obtained from read_knowledge(behavior_id, since, until). */
	window_token?: string;
	/** Multiple page JWTs obtained from read_knowledge for the same Behavior window. */
	window_tokens?: string[];
	extracted_data: Record<string, unknown>;
	replace_existing?: boolean;
	client_id?: string;
	model?: string;
	/** Optional Behavior run id for completion/provenance (from the dispatch prompt). */
	behavior_run_id?: number;
	run_metadata?: Record<string, unknown>;
	template_version_id?: number;
}

export interface BehaviorCreateVersionInput extends BehaviorActionInput {
	behavior_id: BehaviorId;
}

export interface BehaviorVersionDetailsInput {
	behavior_id: BehaviorId;
	version?: number;
}

export interface BehaviorSubmitFeedbackInput {
	behavior_id: BehaviorId;
	window_id: number;
	corrections: Array<{
		field_path: string;
		mutation?: "set" | "remove" | "add";
		value?: unknown;
		note?: string;
	}>;
}

export interface BehaviorGetFeedbackInput {
	behavior_id: BehaviorId;
	window_id?: number;
	limit?: number;
}

export interface BehaviorCreateFromVersionInput {
	version_id: number;
	entity_ids: number[];
	name_pattern?: string;
}

export interface BehaviorsNamespace {
	/** Raw escape hatch for any manage_behaviors action. Prefer named methods. */
	manage(input: ManageBehaviorsArgs): Promise<unknown>;
	list(filter?: BehaviorListFilter): Promise<unknown>;
	get(input: { behavior_id: BehaviorId }): Promise<unknown>;
	create(input: BehaviorCreateInput): Promise<unknown>;
	update(input: BehaviorUpdateInput): Promise<unknown>;
	createVersion(input: BehaviorCreateVersionInput): Promise<unknown>;
	completeWindow(input: BehaviorCompleteWindowInput): Promise<unknown>;
	trigger(input: { behavior_id: BehaviorId }): Promise<unknown>;
	/** Delete one or more Behaviors. */
	delete(input: { behavior_ids: BehaviorId[] }): Promise<unknown>;
	setReactionScript(input: {
		behavior_id: BehaviorId;
		/** TypeScript source. Empty string removes it. */
		reaction_script: string;
	}): Promise<unknown>;
	getVersions(behavior_id: BehaviorId): Promise<unknown>;
	getVersionDetails(
		input: BehaviorId | BehaviorVersionDetailsInput,
	): Promise<unknown>;
	getComponentReference(): Promise<unknown>;
	submitFeedback(input: BehaviorSubmitFeedbackInput): Promise<unknown>;
	getFeedback(input: BehaviorGetFeedbackInput): Promise<unknown>;
	createFromVersion(input: BehaviorCreateFromVersionInput): Promise<unknown>;
}

function normalizeVersionDetailsInput(
	input: BehaviorId | BehaviorVersionDetailsInput,
): { behavior_id: string; version?: number } {
	if (typeof input === "string") {
		return { behavior_id: input };
	}
	return input;
}

export function buildBehaviorsNamespace(
	ctx: ToolContext,
	env: Env,
): BehaviorsNamespace {
	const { manage, action } = createActionCaller(manageBehaviors, env, ctx, "behaviors");

	return {
		manage: (input) => manage(input as Record<string, unknown>),
		list: (filter) => action("list", filter ?? {}),
		get(input) {
			return getBehavior(
				input as never,
				env,
				ctx,
			) as Promise<unknown>;
		},
		create: (input) => action("create", input),
		update: (input) => action("update", input),
		createVersion: (input) => action("create_version", input),
		completeWindow: (input) => action("complete_window", input),
		trigger: (input) => action("trigger", input),
		delete: (input) => action("delete", input),
		setReactionScript: (input) => action("set_reaction_script", input),
		getVersions: (behavior_id) =>
			action("get_versions", {
				behavior_id: idArg(
					"behaviors.getVersions",
					"behavior_id",
					behavior_id,
					"string",
				),
			}),
		getVersionDetails: (input) =>
			action("get_version_details", normalizeVersionDetailsInput(input)),
		getComponentReference: () => action("get_component_reference"),
		submitFeedback: (input) => action("submit_feedback", input),
		getFeedback: (input) => action("get_feedback", input),
		createFromVersion: (input) => action("create_from_version", input),
	};
}
