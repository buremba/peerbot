/**
 * ClientSDK `automations` namespace. Thin, action-complete wrapper over
 * `manageAutomations` + `getAutomation`.
 *
 * Keep this surface in sync with `ManageAutomationsSchema`: every
 * `manage_automations.action` should either have a named SDK method below or be
 * reachable via `automations.manage({ action, ... })`.
 */

import type { Env } from "../../index";
import type {
	AutomationExecutionConfig,
	AutomationSource,
	AutomationTrigger,
	ListAutomationsArgs,
} from "@lobu/core/contracts/tools/manage-automations";
import {
	type ManageAutomationsArgs,
	manageAutomations,
} from "../../tools/admin/manage_automations";
import { getAutomation } from "../../tools/get_automation";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

type AutomationId = string;
type AutomationActionInput = Omit<ManageAutomationsArgs, "action" | "automation_id"> & {
	automation_id?: AutomationId;
};

export type AutomationListFilter = ListAutomationsArgs;

export interface AutomationCreateInput {
	/** Attach the Automation to an entity. Omit for an org-scoped/global Automation. */
	entity_id?: number;
	prompt: string;
	sources?: AutomationSource[];
	triggers?: AutomationTrigger[];
	slug?: string;
	name?: string;
	description?: string;
	outputs?: Record<string, unknown>;
	classifiers?: Record<string, unknown>;
	reactions_guidance?: string;
	reaction_script?: string;
	agent_id?: string;
	model_config?: Record<string, unknown>;
	execution_config?: AutomationExecutionConfig;
	tags?: string[];
}

export interface AutomationUpdateInput {
	automation_id: AutomationId;
	triggers?: AutomationTrigger[];
	agent_id?: string;
	model_config?: Record<string, unknown>;
	/** `null` clears a previously-saved config back to NULL/defaults. */
	execution_config?: AutomationExecutionConfig | null;
}

export interface AutomationCompleteWindowInput {
	automation_id: AutomationId;
	/** JWT obtained from read_knowledge(automation_id, since, until). */
	window_token?: string;
	/** Multiple page JWTs obtained from read_knowledge for the same Automation window. */
	window_tokens?: string[];
	extracted_data: Record<string, unknown>;
	replace_existing?: boolean;
	client_id?: string;
	model?: string;
	/** Optional Automation run id for completion/provenance (from the dispatch prompt). */
	automation_run_id?: number;
	run_metadata?: Record<string, unknown>;
	template_version_id?: number;
}

export interface AutomationCreateVersionInput extends AutomationActionInput {
	automation_id: AutomationId;
}

export interface AutomationVersionDetailsInput {
	automation_id: AutomationId;
	version?: number;
}

export interface AutomationSubmitFeedbackInput {
	automation_id: AutomationId;
	window_id: number;
	corrections: Array<{
		field_path: string;
		mutation?: "set" | "remove" | "add";
		value?: unknown;
		note?: string;
	}>;
}

export interface AutomationGetFeedbackInput {
	automation_id: AutomationId;
	window_id?: number;
	limit?: number;
}

export interface AutomationCreateFromVersionInput {
	version_id: number;
	entity_ids: number[];
	name_pattern?: string;
}

export interface AutomationsNamespace {
	/** Raw escape hatch for any manage_automations action. Prefer named methods. */
	manage(input: ManageAutomationsArgs): Promise<unknown>;
	list(filter?: AutomationListFilter): Promise<unknown>;
	get(input: { automation_id: AutomationId }): Promise<unknown>;
	create(input: AutomationCreateInput): Promise<unknown>;
	update(input: AutomationUpdateInput): Promise<unknown>;
	createVersion(input: AutomationCreateVersionInput): Promise<unknown>;
	completeWindow(input: AutomationCompleteWindowInput): Promise<unknown>;
	trigger(input: { automation_id: AutomationId }): Promise<unknown>;
	/** Delete one or more Automations. */
	delete(input: { automation_ids: AutomationId[] }): Promise<unknown>;
	setReactionScript(input: {
		automation_id: AutomationId;
		/** TypeScript source. Empty string removes it. */
		reaction_script: string;
	}): Promise<unknown>;
	getVersions(automation_id: AutomationId): Promise<unknown>;
	getVersionDetails(
		input: AutomationId | AutomationVersionDetailsInput,
	): Promise<unknown>;
	getComponentReference(): Promise<unknown>;
	submitFeedback(input: AutomationSubmitFeedbackInput): Promise<unknown>;
	getFeedback(input: AutomationGetFeedbackInput): Promise<unknown>;
	createFromVersion(input: AutomationCreateFromVersionInput): Promise<unknown>;
}

function normalizeVersionDetailsInput(
	input: AutomationId | AutomationVersionDetailsInput,
): { automation_id: string; version?: number } {
	if (typeof input === "string") {
		return { automation_id: input };
	}
	return input;
}

export function buildAutomationsNamespace(
	ctx: ToolContext,
	env: Env,
): AutomationsNamespace {
	const { manage, action } = createActionCaller(manageAutomations, env, ctx, "automations");

	return {
		manage: (input) => manage(input as Record<string, unknown>),
		list: (filter) => action("list", filter ?? {}),
		get(input) {
			return getAutomation(
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
		getVersions: (automation_id) =>
			action("get_versions", {
				automation_id: idArg(
					"automations.getVersions",
					"automation_id",
					automation_id,
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
