/**
 * ClientSDK `schedules` namespace. Thin wrapper over `manageSchedules`.
 */

import type { ActionInput } from "@lobu/core/contracts/tools/action-input";
import type { ManageSchedulesArgs } from "@lobu/core/contracts/tools/manage-schedules";
import type { Env } from "../../index";
import { manageSchedules } from "../../tools/admin/manage_schedules";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export type SchedulesListInput = ActionInput<ManageSchedulesArgs, "list">;
export type SchedulesCreateInput = ActionInput<ManageSchedulesArgs, "create">;
export type SchedulesUpdateInput = ActionInput<ManageSchedulesArgs, "update">;
export type SchedulesPauseInput = ActionInput<ManageSchedulesArgs, "pause">;
export type SchedulesCancelInput = ActionInput<ManageSchedulesArgs, "cancel">;

export interface SchedulesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: SchedulesListInput): Promise<unknown>;
	create(input: SchedulesCreateInput): Promise<unknown>;
	update(input: SchedulesUpdateInput): Promise<unknown>;
	pause(input: SchedulesPauseInput): Promise<unknown>;
	cancel(input: SchedulesCancelInput): Promise<unknown>;
}

export function buildSchedulesNamespace(
	ctx: ToolContext,
	env: Env,
): SchedulesNamespace {
	const { manage, method } = createActionCaller(manageSchedules, env, ctx, "schedules");

	return {
		manage,
		list: method("list"),
		create: method("create"),
		update: method("update"),
		pause: method("pause"),
		cancel: method("cancel"),
	};
}
