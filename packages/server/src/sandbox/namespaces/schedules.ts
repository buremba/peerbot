/**
 * ClientSDK `schedules` namespace. Thin wrapper over `manageSchedules`.
 */

import type { Env } from "../../index";
import { manageSchedules } from "../../tools/admin/manage_schedules";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface SchedulesListInput {
	agent_id?: string;
	user_id?: string;
	action_type?: string;
	include_paused?: boolean;
}

export interface SchedulesCreateInput {
	description: string;
	run_at: string;
	cron?: string;
	payload: Record<string, unknown>;
	source_run_id?: number;
	source_event_id?: number;
	source_thread_id?: string;
}

export interface SchedulesUpdateInput {
	id: string;
	description?: string;
	run_at?: string;
	cron?: string | null;
	prompt?: string;
	model?: string;
}

export interface SchedulesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: SchedulesListInput): Promise<unknown>;
	create(input: SchedulesCreateInput): Promise<unknown>;
	update(input: SchedulesUpdateInput): Promise<unknown>;
	pause(input: { id: string; paused?: boolean }): Promise<unknown>;
	cancel(id: string): Promise<unknown>;
}

export function buildSchedulesNamespace(
	ctx: ToolContext,
	env: Env,
): SchedulesNamespace {
	const { manage, action } = createActionCaller(manageSchedules, env, ctx);

	return {
		manage,
		list: (input) => action("list", input ?? {}),
		create: (input) => action("create", input),
		update: (input) => action("update", input),
		pause: (input) => action("pause", input),
		cancel: (id) => action("cancel", { id }),
	};
}