/**
 * ClientSDK `watchers` namespace. Thin, action-complete wrapper over
 * `manageBehaviors` + `listWatchers` + `getWatcher`.
 *
 * Keep this surface in sync with `ManageBehaviorsSchema`: every
 * `manage_behaviors.action` should either have a named SDK method below or be
 * reachable via `watchers.manage({ action, ... })`.
 */

import type { Env } from "../../index";
import {
	listWatchers,
	type ManageBehaviorsArgs,
	manageBehaviors,
} from "../../tools/admin/manage_behaviors";
import { getWatcher } from "../../tools/get_watchers";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

type WatcherId = string;
type Source = { name: string; query: string };
type WatcherActionInput = Omit<ManageBehaviorsArgs, "action" | "watcher_id"> & {
	watcher_id?: WatcherId;
};

/**
 * Per-watcher device-worker CLI execution settings (mirrors the
 * `watchers.execution_config` jsonb and the manage_behaviors TypeBox schema).
 * Every field is optional; omitted fields fall back to dispatcher/CLI defaults.
 */
interface WatcherExecutionConfig {
	/** Wall-clock cap in seconds for the device-worker CLI run (default 600). */
	timeout_seconds?: number;
	/** Per-run dollar ceiling (claude: --max-budget-usd). */
	max_budget_usd?: number;
	/** Model alias/id passed to the CLI (--model). */
	model?: string;
	/** Tool permission mode (claude: --permission-mode). */
	permission_mode?:
		| "acceptEdits"
		| "auto"
		| "bypassPermissions"
		| "default"
		| "dontAsk"
		| "plan";
	/** Reasoning effort (claude: --effort). */
	effort?: "low" | "medium" | "high";
}

export interface WatcherListFilter {
	entity_id?: number;
	status?: "active" | "paused" | "draft";
	limit?: number;
	offset?: number;
}

export interface WatcherCreateInput {
	/** Attach the watcher to an entity. Omit for an org-scoped/global watcher. */
	entity_id?: number;
	prompt: string;
	sources?: Source[];
	schedule?: string;
	/** IANA zone the schedule is evaluated in; omit for server time (UTC). */
	timezone?: string;
	slug?: string;
	name?: string;
	description?: string;
	keying_config?: Record<string, unknown>;
	classifiers?: Record<string, unknown>;
	reactions_guidance?: string;
	reaction_script?: string;
	agent_id?: string;
	scheduler_client_id?: string;
	model_config?: Record<string, unknown>;
	execution_config?: WatcherExecutionConfig;
	tags?: string[];
}

export interface WatcherUpdateInput {
	watcher_id: WatcherId;
	schedule?: string;
	/** IANA zone for the schedule; null clears it (server time). */
	timezone?: string | null;
	agent_id?: string;
	scheduler_client_id?: string;
	model_config?: Record<string, unknown>;
	/** `null` clears a previously-saved config back to NULL/defaults. */
	execution_config?: WatcherExecutionConfig | null;
	sources?: Source[];
}

export interface WatcherCompleteWindowInput {
	watcher_id: WatcherId;
	/** JWT obtained from read_knowledge(watcher_id, since, until). */
	window_token?: string;
	/** Multiple page JWTs obtained from read_knowledge for the same watcher window. */
	window_tokens?: string[];
	extracted_data: Record<string, unknown>;
	replace_existing?: boolean;
	client_id?: string;
	model?: string;
	run_metadata?: Record<string, unknown>;
	template_version_id?: number;
}

export interface WatcherCreateVersionInput extends WatcherActionInput {
	watcher_id: WatcherId;
}

export interface WatcherVersionDetailsInput {
	watcher_id: WatcherId;
	version?: number;
}

export interface WatcherSubmitFeedbackInput {
	watcher_id: WatcherId;
	window_id: number;
	corrections: Array<{
		field_path: string;
		mutation?: "set" | "remove" | "add";
		value?: unknown;
		note?: string;
	}>;
}

export interface WatcherGetFeedbackInput {
	watcher_id: WatcherId;
	window_id?: number;
	limit?: number;
}

export interface WatcherCreateFromVersionInput {
	version_id: number;
	entity_ids: number[];
	name_pattern?: string;
}

export interface WatchersNamespace {
	/** Raw escape hatch for any manage_behaviors action. Prefer named methods. */
	manage(input: ManageBehaviorsArgs): Promise<unknown>;
	list(filter?: WatcherListFilter): Promise<unknown>;
	get(input: { watcher_id: WatcherId }): Promise<unknown>;
	create(input: WatcherCreateInput): Promise<unknown>;
	update(input: WatcherUpdateInput): Promise<unknown>;
	createVersion(input: WatcherCreateVersionInput): Promise<unknown>;
	completeWindow(input: WatcherCompleteWindowInput): Promise<unknown>;
	trigger(input: { watcher_id: WatcherId }): Promise<unknown>;
	/** Delete one or more watchers. */
	delete(input: { watcher_ids: WatcherId[] }): Promise<unknown>;
	setReactionScript(input: {
		watcher_id: WatcherId;
		/** TypeScript source. Empty string removes it. */
		reaction_script: string;
	}): Promise<unknown>;
	getVersions(watcher_id: WatcherId): Promise<unknown>;
	getVersionDetails(
		input: WatcherId | WatcherVersionDetailsInput,
	): Promise<unknown>;
	getComponentReference(): Promise<unknown>;
	submitFeedback(input: WatcherSubmitFeedbackInput): Promise<unknown>;
	getFeedback(input: WatcherGetFeedbackInput): Promise<unknown>;
	createFromVersion(input: WatcherCreateFromVersionInput): Promise<unknown>;
}

function normalizeVersionDetailsInput(
	input: WatcherId | WatcherVersionDetailsInput,
): { watcher_id: string; version?: number } {
	if (typeof input === "string") {
		return { watcher_id: input };
	}
	return input;
}

export function buildWatchersNamespace(
	ctx: ToolContext,
	env: Env,
): WatchersNamespace {
	const { manage, action } = createActionCaller(manageBehaviors, env, ctx, "watchers");

	return {
		manage: (input) => manage(input as Record<string, unknown>),
		list: (filter) =>
			listWatchers((filter ?? {}) as never, env, ctx) as Promise<unknown>,
		get(input) {
			return getWatcher(
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
		getVersions: (watcher_id) => action("get_versions", { watcher_id }),
		getVersionDetails: (input) =>
			action("get_version_details", normalizeVersionDetailsInput(input)),
		getComponentReference: () => action("get_component_reference"),
		submitFeedback: (input) => action("submit_feedback", input),
		getFeedback: (input) => action("get_feedback", input),
		createFromVersion: (input) => action("create_from_version", input),
	};
}
