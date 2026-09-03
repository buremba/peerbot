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
	AutomationClaimNextWindowResult,
	AutomationExecutionConfig,
	AutomationSource,
	AutomationTrigger,
	AutomationTriggerResult,
	ListAutomationsArgs,
	ManageAutomationsResult,
} from "@lobu/core/contracts/tools/manage-automations";
import type { AgentKind } from "@lobu/core/contracts/worker/device-automation";
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

type AutomationPendingApprovalResult = Extract<
	ManageAutomationsResult,
	{ status: "pending_approval" }
>;

/** Canonical create receipt; successful creates always return automation_id. */
export type AutomationCreateResult =
	| Extract<ManageAutomationsResult, { action: "create" }>
	| (Omit<AutomationPendingApprovalResult, "action"> & { action: "create" });

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
	managed_agent_id?: string | null;
	device_worker_id?: string;
	agent_kind?: AgentKind;
	model_config?: Record<string, unknown>;
	execution_config?: AutomationExecutionConfig;
	tags?: string[];
}

export interface AutomationUpdateInput {
	automation_id: AutomationId;
	triggers?: AutomationTrigger[];
	managed_agent_id?: string | null;
	device_worker_id?: string | null;
	agent_kind?: AgentKind | null;
	model_config?: Record<string, unknown>;
	/** `null` clears a previously-saved config back to NULL/defaults. */
	execution_config?: AutomationExecutionConfig | null;
}

export interface AutomationCompleteWindowInput {
	automation_id: AutomationId;
	/** JWT obtained from knowledge.read for this Automation run/window. */
	window_token?: string;
	/** Multiple page JWTs obtained from knowledge.read for the same Automation run/window. */
	window_tokens?: string[];
	extracted_data: Record<string, unknown>;
	client_id?: string;
	model?: string;
	/** Automation run id from the dispatch prompt or Automation list. */
	run_id: number;
	run_metadata?: Record<string, unknown>;
	template_version_id?: number;
}

export interface AutomationClaimNextWindowInput {
	automation_id: AutomationId;
	lease_seconds?: number;
	limit?: number;
	/** Existing lease run id when fetching the next source page. */
	run_id?: number;
	before_occurred_at?: string;
	before_id?: number;
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
	run_id: number;
	corrections: Array<{
		field_path: string;
		mutation?: "set" | "remove" | "add";
		value?: unknown;
		note?: string;
	}>;
}

export interface AutomationGetFeedbackInput {
	automation_id: AutomationId;
	run_id?: number;
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
	create(input: AutomationCreateInput): Promise<AutomationCreateResult>;
	update(input: AutomationUpdateInput): Promise<unknown>;
	createVersion(input: AutomationCreateVersionInput): Promise<unknown>;
	completeWindow(input: AutomationCompleteWindowInput): Promise<unknown>;
	claimNextWindow(input: AutomationClaimNextWindowInput): Promise<AutomationClaimNextWindowResult>;
	trigger(input: { automation_id: AutomationId }): Promise<AutomationTriggerResult>;
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
	const { manage, method } = createActionCaller(manageAutomations, env, ctx, "automations");

	return {
		manage,
		list: method("list"),
		get(input) {
			return getAutomation(
				input as never,
				env,
				ctx,
			) as Promise<unknown>;
		},
		create: method("create"),
		update: method("update"),
		createVersion: method("create_version"),
		completeWindow: method("complete_window"),
		claimNextWindow: method("claim_next_window"),
		trigger: method("trigger"),
		delete: method("delete"),
		setReactionScript: method("set_reaction_script"),
		getVersions: method("get_versions", {
			mapArgs: (automation_id) => ({
				automation_id: idArg(
					"automations.getVersions",
					"automation_id",
					automation_id,
					"string",
				),
			}),
		}),
		getVersionDetails: method("get_version_details", {
			mapArgs: normalizeVersionDetailsInput,
		}),
		getComponentReference: method("get_component_reference"),
		submitFeedback: method("submit_feedback"),
		getFeedback: method("get_feedback"),
		createFromVersion: method("create_from_version"),
	};
}
