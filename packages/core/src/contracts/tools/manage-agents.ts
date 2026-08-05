import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

export const ManageAgentsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list", {
        description: "List org agents.",
      }),
      Type.Literal("get", { description: "Fetch one agent." }),
      Type.Literal("create", {
        description:
          "Create an agent owned by the caller (queued for approval).",
      }),
      Type.Literal("update", {
        description: "Patch agent fields (queued for approval).",
      }),
      Type.Literal("delete", {
        description: "Delete an agent (queued for approval).",
      }),
    ],
    { description: "Action to perform" }
  ),

  agent_id: Type.Optional(
    Type.String({
      description:
        '[get/create/update/delete] Agent ID (lowercase slug, e.g. "support").',
    })
  ),
  // Editable fields carry an `x-lobu-field` annotation — the single source of
  // truth the field engine loops over to drive create/update/proposal/pre-image
  // (so adding a field is one annotated entry, not edits in seven places). The
  // `store` routes the write: `column` = an `agents` table column; `model` =
  // the settings row's `models[0]`.
  name: Type.Optional(
    Type.String({
      description: "[create/update] Display name for the agent.",
      "x-lobu-field": { store: "column" },
    })
  ),
  description: Type.Optional(
    Type.String({
      description: "[create/update] Agent description.",
      "x-lobu-field": { store: "column" },
    })
  ),
  identity_md: Type.Optional(
    Type.String({
      description: "[create/update] Agent identity / system prompt (Markdown).",
      "x-lobu-field": { store: "column" },
    })
  ),
  default_model: Type.Optional(
    Type.String({
      description:
        '[create/update] Default model as an explicit "<provider>/<model>" ref (e.g. "anthropic/claude-sonnet-5"). Validated against the org\'s connected providers. Without it the agent inherits the org default model; if the org has none the agent is not runnable. Pass an empty string to clear it and fall back to the org default.',
      "x-lobu-field": { store: "model", emptyClears: true },
    })
  ),
});

// ============================================
// Type Definitions
// ============================================

export type ManageAgentsArgs = Static<typeof ManageAgentsSchema>;

export interface AgentRecord {
  id: string;
  name: string;
  description: string | null;
  owner_platform: string | null;
  owner_user_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Where an agent's effective model came from, so a caller can tell a runnable
 * agent from one that only works because the org happens to have a default
 * (and would break if that default changed). Returned by `get`.
 *
 *   - `agent`: the agent pins its own `default_model` (`models[0]`).
 *   - `org_default`: the agent pins nothing; it inherits the org default model.
 *   - `none`: the agent pins nothing AND the org has no default — NOT runnable.
 */
export type ModelSource = "agent" | "org_default" | "none";

export interface AgentModelInfo {
  /** The effective model ref that would be used, or null when none resolves. */
  effective_model: string | null;
  /** Which layer supplied `effective_model`. */
  source: ModelSource;
  /** True when no model resolves — the agent cannot run until one is set. */
  not_runnable: boolean;
}

export type ManageAgentsResult =
  | { action: "list"; agents: AgentRecord[] }
  | { action: "get"; agent: AgentRecord; model: AgentModelInfo }
  | {
      action: "create";
      agent_id: string;
      created: boolean;
      /**
       * The agent's model after create. `not_runnable: true` is the actionable
       * signal that no model resolved (no `default_model` given and no org
       * default) — set one with a `default_model` on create/update.
       */
      model: AgentModelInfo;
    }
  | {
      action: "update";
      agent_id: string;
      updated_fields: string[];
      /** Fields a stale approval skipped because another writer changed them first. */
      skipped_fields?: string[];
      /** The agent's model after update (present when the effective model is known). */
      model?: AgentModelInfo;
    }
  | { action: "delete"; agent_id: string; deleted: boolean }
  | {
      action: "create" | "update" | "delete";
      run_id: number;
      event_id?: number;
      status: "pending_approval";
      message: string;
      // The proposed change + current agent row, so the worker can forward an
      // approval card (run_id + diff) into the chat without a second fetch.
      proposal: ManageAgentsProposal;
      current: Record<string, unknown> | null;
    };

/** Proposed mutation held in `runs.action_input` for a builder-gate run. */
export interface ManageAgentsProposal {
  action: "create" | "update" | "delete";
  agent_id: string;
  name?: string;
  description?: string;
  identity_md?: string;
  /**
   * Default model ref for the agent (`models[0]`). Empty string clears it back
   * to the org default. Validated at request time against the org's providers,
   * so an unapprovable proposal is rejected before the card is shown.
   */
  default_model?: string;
  /**
   * Pre-image of the fields this update proposes to change, captured when the
   * update was queued. On approve, applyUpdate only overwrites a field whose
   * live value still equals its pre-image — so a stale approval never clobbers a
   * newer human edit to that field. Present only for queued `update` proposals.
   */
  base?: {
    name?: string | null;
    description?: string | null;
    identity_md?: string | null;
    /** Pre-image of `models[0]` (the default model ref), or null when unset. */
    default_model?: string | null;
  };
}
