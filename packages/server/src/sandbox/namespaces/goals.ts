/**
 * ClientSDK `goals` namespace. Thin wrapper over `manageGoals`.
 *
 * Goals are top-level handles that group watchers under a single user-facing
 * intent (e.g. "Keep my CRM clean"). See `manage_goals.ts` for the action
 * surface.
 */

import type { Env } from "../../index";
import { manageGoals } from "../../tools/admin/manage_goals";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

type GoalId = number;
type GoalStatus = "active" | "paused" | "archived";

export interface GoalCreateInput {
  slug: string;
  name: string;
  description?: string;
  status?: GoalStatus;
  template_key?: string;
  metadata?: Record<string, unknown>;
}

export interface GoalUpdateInput {
  goal_id?: GoalId;
  slug?: string;
  name?: string;
  description?: string | null;
  status?: GoalStatus;
  template_key?: string | null;
  metadata?: Record<string, unknown>;
  replace_metadata?: boolean;
}

export interface GoalsListFilter {
  status?: GoalStatus;
  limit?: number;
  offset?: number;
}

export interface GoalLookup {
  goal_id?: GoalId;
  slug?: string;
}

export interface GoalsNamespace {
  /** Raw escape hatch for any manage_goals action. */
  manage(input: Record<string, unknown>): Promise<unknown>;
  create(input: GoalCreateInput): Promise<unknown>;
  update(input: GoalUpdateInput): Promise<unknown>;
  get(input: GoalLookup): Promise<unknown>;
  list(filter?: GoalsListFilter): Promise<unknown>;
  archive(input: GoalLookup): Promise<unknown>;
  delete(input: GoalLookup): Promise<unknown>;
}

export function buildGoalsNamespace(ctx: ToolContext, env: Env): GoalsNamespace {
  const { manage, action } = createActionCaller(manageGoals, env, ctx);

  return {
    manage,
    create: (input) => action("create", input),
    update: (input) => action("update", input),
    get: (input) => action("get", input),
    list: (filter) => action("list", filter ?? {}),
    archive: (input) => action("archive", input),
    delete: (input) => action("delete", input),
  };
}
