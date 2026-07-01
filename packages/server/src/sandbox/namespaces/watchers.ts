/**
 * ClientSDK `watchers` namespace TYPES + contract-generated runtime.
 *
 * The runtime methods (names, action routing, input glue) are GENERATED from
 * `tools/contracts/watchers.ts` — edit the contract, not this file, to change
 * behavior. This module contributes the typed facade (`WatchersNamespace` and
 * its input types) and binds the heavy handler imports the pure contract
 * cannot hold.
 */

import type { Env } from "../../index";
import { buildContractNamespace, watchersCapability } from "../../tools/contracts";
import {
	listWatchers,
	type ManageWatchersArgs,
	manageWatchers,
} from "../../tools/admin/manage_watchers";
import { getWatcher } from "../../tools/get_watchers";
import type { ToolContext } from "../../tools/registry";

type WatcherId = string | number;
type Source = { name: string; query: string };
type WatcherActionInput = Omit<ManageWatchersArgs, "action" | "watcher_id"> & {
	watcher_id?: WatcherId;
};

/**
 * Per-watcher device-worker CLI execution settings (mirrors the
 * `watchers.execution_config` jsonb and the manage_watchers TypeBox schema).
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
	slug?: string;
	name?: string;
	description?: string;
	keying_config?: Record<string, unknown>;
	classifiers?: Record<string, unknown>;
	reactions_guidance?: string;
	agent_id?: string;
	scheduler_client_id?: string;
	model_config?: Record<string, unknown>;
	execution_config?: WatcherExecutionConfig;
	tags?: string[];
}

export interface WatcherUpdateInput {
	watcher_id: WatcherId;
	schedule?: string;
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
	/** Raw escape hatch for any manage_watchers action. Prefer named methods. */
	manage(input: ManageWatchersArgs): Promise<unknown>;
	list(filter?: WatcherListFilter): Promise<unknown>;
	get(watcher_id: WatcherId): Promise<unknown>;
	create(input: WatcherCreateInput): Promise<unknown>;
	update(input: WatcherUpdateInput): Promise<unknown>;
	createVersion(input: WatcherCreateVersionInput): Promise<unknown>;
	completeWindow(input: WatcherCompleteWindowInput): Promise<unknown>;
	trigger(watcher_id: WatcherId): Promise<unknown>;
	/** Delete one or more watchers. */
	delete(watcher_id: WatcherId | WatcherId[]): Promise<unknown>;
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

export function buildWatchersNamespace(
	ctx: ToolContext,
	env: Env,
): WatchersNamespace {
	return buildContractNamespace(
		watchersCapability,
		{
			manage_watchers: manageWatchers,
			list_watchers: listWatchers,
			get_watcher: getWatcher,
		},
		env,
		ctx,
	) as unknown as WatchersNamespace;
}
