/**
 * ClientSDK `agents` namespace. Thin wrapper over `manageAgents`.
 */

import type { Env } from "../../index";
import { manageAgents } from "../../tools/admin/manage_agents";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface AgentsCreateInput {
	agent_id: string;
	name?: string;
	description?: string;
	identity_md?: string;
}

export interface AgentsUpdateInput {
	agent_id: string;
	name?: string;
	description?: string;
	identity_md?: string;
}

export interface AgentsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(): Promise<unknown>;
	get(agent_id: string): Promise<unknown>;
	create(input: AgentsCreateInput): Promise<unknown>;
	update(input: AgentsUpdateInput): Promise<unknown>;
	delete(agent_id: string): Promise<unknown>;
	setSystemAgent(agent_id: string): Promise<unknown>;
}

export function buildAgentsNamespace(
	ctx: ToolContext,
	env: Env,
): AgentsNamespace {
	const { manage, action } = createActionCaller(manageAgents, env, ctx);

	return {
		manage,
		list: () => action("list", {}),
		get: (agent_id) => action("get", { agent_id }),
		create: (input) => action("create", input),
		update: (input) => action("update", input),
		delete: (agent_id) => action("delete", { agent_id }),
		setSystemAgent: (agent_id) =>
			action("set_system_agent", { agent_id }),
	};
}