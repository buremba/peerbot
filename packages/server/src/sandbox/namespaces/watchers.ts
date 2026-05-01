/**
 * ClientSDK `watchers` namespace. Thin, action-complete wrapper over
 * `manageWatchers` + `listWatchers` + `getWatcher`.
 *
 * Keep this surface in sync with `ManageWatchersSchema`: every
 * `manage_watchers.action` should either have a named SDK method below or be
 * reachable via `watchers.manage({ action, ... })`.
 */

import type { Env } from "../../index";
import {
  listWatchers,
  manageWatchers,
  type ManageWatchersArgs,
} from "../../tools/admin/manage_watchers";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

type WatcherId = string | number;
type Source = { name: string; query: string };
type WatcherActionInput = Omit<ManageWatchersArgs, "action" | "watcher_id"> & {
  watcher_id?: WatcherId;
};

export interface WatcherListFilter {
  entity_id?: number;
  status?: "active" | "paused" | "draft";
  limit?: number;
  offset?: number;
}

export interface WatcherCreateInput {
  entity_id: number;
  prompt: string;
  extraction_schema: Record<string, unknown>;
  sources?: Source[];
  schedule?: string;
  slug?: string;
  name?: string;
  description?: string;
  json_template?: Record<string, unknown>;
  keying_config?: Record<string, unknown>;
  classifiers?: Record<string, unknown>;
  condensation_prompt?: string;
  condensation_window_count?: number;
  reactions_guidance?: string;
  agent_id?: string;
  scheduler_client_id?: string;
  model_config?: Record<string, unknown>;
  tags?: string[];
}

export interface WatcherUpdateInput {
  watcher_id: WatcherId;
  schedule?: string;
  agent_id?: string;
  scheduler_client_id?: string;
  model_config?: Record<string, unknown>;
  sources?: Source[];
}

export interface WatcherCompleteWindowInput {
  watcher_id: WatcherId;
  /** JWT obtained from read_knowledge(watcher_id, since, until). */
  window_token: string;
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

export interface WatcherUpgradeInput {
  watcher_id: WatcherId;
  target_version?: number;
  version?: number;
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
  upgrade(input: WatcherUpgradeInput): Promise<unknown>;
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
  getVersionDetails(input: WatcherId | WatcherVersionDetailsInput): Promise<unknown>;
  getComponentReference(): Promise<unknown>;
  submitFeedback(input: WatcherSubmitFeedbackInput): Promise<unknown>;
  getFeedback(input: WatcherGetFeedbackInput): Promise<unknown>;
  createFromVersion(input: WatcherCreateFromVersionInput): Promise<unknown>;
}

function asWatcherIdString(v: WatcherId): string {
  return typeof v === "number" ? String(v) : v;
}

function normalizeWatcherId<T extends { watcher_id?: WatcherId }>(
  input: T,
): Omit<T, "watcher_id"> & { watcher_id?: string } {
  return {
    ...input,
    ...(input.watcher_id !== undefined
      ? { watcher_id: asWatcherIdString(input.watcher_id) }
      : {}),
  };
}

function normalizeVersionDetailsInput(
  input: WatcherId | WatcherVersionDetailsInput,
): { watcher_id: string; version?: number } {
  if (typeof input === "string" || typeof input === "number") {
    return { watcher_id: asWatcherIdString(input) };
  }
  return normalizeWatcherId(input) as { watcher_id: string; version?: number };
}

export function buildWatchersNamespace(
  ctx: ToolContext,
  env: Env,
): WatchersNamespace {
  const { manage, action } = createActionCaller(manageWatchers, env, ctx);

  return {
    manage: (input) => manage(input as Record<string, unknown>),
    list: (filter) => listWatchers((filter ?? {}) as never, env, ctx) as Promise<unknown>,
    async get(watcher_id) {
      const { getWatcher } = await import("../../tools/get_watchers");
      return getWatcher(
        { watcher_id: asWatcherIdString(watcher_id) } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    create: (input) => action("create", input),
    update: (input) => action("update", normalizeWatcherId(input)),
    createVersion: (input) => action("create_version", normalizeWatcherId(input)),
    upgrade: (input) => action("upgrade", normalizeWatcherId(input)),
    completeWindow: (input) => action("complete_window", normalizeWatcherId(input)),
    trigger: (watcher_id) => action("trigger", { watcher_id: asWatcherIdString(watcher_id) }),
    delete(watcher_id) {
      const watcher_ids = Array.isArray(watcher_id)
        ? watcher_id.map(asWatcherIdString)
        : [asWatcherIdString(watcher_id)];
      return action("delete", { watcher_ids });
    },
    setReactionScript: (input) => action("set_reaction_script", normalizeWatcherId(input)),
    getVersions: (watcher_id) =>
      action("get_versions", { watcher_id: asWatcherIdString(watcher_id) }),
    getVersionDetails: (input) => action("get_version_details", normalizeVersionDetailsInput(input)),
    getComponentReference: () => action("get_component_reference"),
    submitFeedback: (input) => action("submit_feedback", normalizeWatcherId(input)),
    getFeedback: (input) => action("get_feedback", normalizeWatcherId(input)),
    createFromVersion: (input) => action("create_from_version", input),
  };
}
