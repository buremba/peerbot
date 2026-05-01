/**
 * ClientSDK `classifiers` namespace. Thin wrapper over `manageClassifiers`.
 *
 * Most CRUD actions use `classifier_id: number`; `classify` uses
 * `classifier_slug: string`. The namespace keeps those distinct.
 */

import type { Env } from "../../index";
import { manageClassifiers } from "../../tools/admin/manage_classifiers";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ClassifierCreateInput {
  slug: string;
  name: string;
  description?: string;
  attribute_key: string;
  attribute_values?: Record<string, unknown>;
  entity_id?: number;
  watcher_id: number;
  min_similarity?: number;
  fallback_value?: unknown;
  created_by?: string;
}

export interface ClassifierCreateVersionInput {
  classifier_id: number;
  name?: string;
  description?: string;
  attribute_values?: Record<string, unknown>;
  min_similarity?: number;
  fallback_value?: unknown;
  change_notes?: string;
  set_as_current?: boolean;
  created_by?: string;
}

export interface ClassifierClassifyInput {
  classifier_slug: string;
  /** Single-mode update. */
  content_id?: number;
  value?: string | null;
  /** Batch mode. */
  classifications?: Array<{
    content_id: number;
    value: string | null;
    reasoning?: string;
  }>;
  source?: "llm" | "user";
  reasoning?: string;
}

export interface ClassifiersNamespace {
  manage(input: Record<string, unknown>): Promise<unknown>;
  list(input?: { entity_id?: number; status?: string }): Promise<unknown>;
  create(input: ClassifierCreateInput): Promise<unknown>;
  createVersion(input: ClassifierCreateVersionInput): Promise<unknown>;
  getVersions(classifier_id: number): Promise<unknown>;
  setCurrentVersion(input: {
    classifier_id: number;
    version: number;
  }): Promise<unknown>;
  generateEmbeddings(input: {
    classifier_id: number;
    force_regenerate?: boolean;
  }): Promise<unknown>;
  delete(classifier_id: number): Promise<unknown>;
  classify(input: ClassifierClassifyInput): Promise<unknown>;
}

export function buildClassifiersNamespace(
  ctx: ToolContext,
  env: Env,
): ClassifiersNamespace {
  const { manage, action } = createActionCaller(manageClassifiers, env, ctx);

  return {
    manage,
    list: (input) => action("list", input),
    create: (input) => action("create", input),
    createVersion: (input) => action("create_version", input),
    getVersions: (classifier_id) =>
      action("get_versions", { classifier_id }),
    setCurrentVersion: (input) => action("set_current_version", input),
    generateEmbeddings: (input) => action("generate_embeddings", input),
    delete: (classifier_id) => action("delete", { classifier_id }),
    classify: (input) => action("classify", input),
  };
}
