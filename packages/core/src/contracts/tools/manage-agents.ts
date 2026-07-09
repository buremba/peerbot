import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

export const ManageAgentsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list", {
        description: "List org agents (marks the system agent).",
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
      Type.Literal("set_system_agent", {
        description: "Point the org system_agent_id at an agent.",
      }),
    ],
    { description: "Action to perform" }
  ),

  agent_id: Type.Optional(
    Type.String({
      description:
        '[get/create/update/delete/set_system_agent] Agent ID (lowercase slug, e.g. "builder").',
    })
  ),
  name: Type.Optional(
    Type.String({ description: "[create/update] Display name for the agent." })
  ),
  description: Type.Optional(
    Type.String({ description: "[create/update] Agent description." })
  ),
  identity_md: Type.Optional(
    Type.String({
      description: "[create/update] Agent identity / system prompt (Markdown).",
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
  is_system_agent: boolean;
}

export type ManageAgentsResult =
  | { action: "list"; agents: AgentRecord[] }
  | { action: "get"; agent: AgentRecord }
  | { action: "create"; agent_id: string; created: boolean }
  | {
      action: "update";
      agent_id: string;
      updated_fields: string[];
      /** Fields a stale approval skipped because another writer changed them first. */
      skipped_fields?: string[];
    }
  | { action: "delete"; agent_id: string; deleted: boolean }
  | { action: "set_system_agent"; system_agent_id: string }
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
   * Pre-image of the fields this update proposes to change, captured when the
   * update was queued. On approve, applyUpdate only overwrites a field whose
   * live value still equals its pre-image — so a stale approval never clobbers a
   * newer human edit to that field. Present only for queued `update` proposals.
   */
  base?: {
    name?: string | null;
    description?: string | null;
    identity_md?: string | null;
  };
}
