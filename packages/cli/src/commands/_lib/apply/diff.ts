import type { AgentSettings } from "@lobu/core";
import type {
  RemoteAgent,
  RemoteConnection,
  RemoteEntityType,
  RemoteRelationshipType,
} from "./client.js";
import type {
  DesiredAgent,
  DesiredConnection,
  DesiredEntityType,
  DesiredRelationshipType,
} from "./desired-state.js";

// ── Diff verbs ──────────────────────────────────────────────────────────────

export type DiffVerb = "create" | "update" | "noop" | "drift";

interface BaseRow {
  verb: DiffVerb;
  /** Stable identifier for matching messages and UI. */
  id: string;
}

export interface AgentDiffRow extends BaseRow {
  kind: "agent";
  desired?: DesiredAgent["metadata"];
  remote?: RemoteAgent;
  /** Field-level changes when verb === "update". */
  changedFields?: string[];
}

export interface SettingsDiffRow extends BaseRow {
  kind: "settings";
  desired?: Partial<AgentSettings>;
  changedFields?: string[];
}

export interface ConnectionDiffRow extends BaseRow {
  kind: "connection";
  agentId: string;
  desired?: DesiredConnection;
  remote?: RemoteConnection;
  changedFields?: string[];
  /** True when an update will restart the live worker — surfaced in the plan. */
  willRestart?: boolean;
}

export interface EntityTypeDiffRow extends BaseRow {
  kind: "entity-type";
  desired?: DesiredEntityType;
  remote?: RemoteEntityType;
  changedFields?: string[];
}

export interface RelationshipTypeDiffRow extends BaseRow {
  kind: "relationship-type";
  desired?: DesiredRelationshipType;
  remote?: RemoteRelationshipType;
  changedFields?: string[];
}

export type DiffRow =
  | AgentDiffRow
  | SettingsDiffRow
  | ConnectionDiffRow
  | EntityTypeDiffRow
  | RelationshipTypeDiffRow;

export interface DiffPlan {
  rows: DiffRow[];
  /** Aggregate counters for the summary line. */
  counts: { create: number; update: number; noop: number; drift: number };
}

// ── Equality helpers ───────────────────────────────────────────────────────

/**
 * Stable structural equality for JSON-shaped values. Sorts object keys before
 * stringifying so `{a:1,b:2}` and `{b:2,a:1}` compare equal.
 *
 * Returns false (i.e. "different") when either side is `undefined` and the
 * other isn't — but treats `[]` vs `undefined` and `{}` vs `undefined` as
 * **equal**, since empty containers carry no semantic state and the server
 * commonly omits them.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "null";
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "null";
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── Per-resource diff ──────────────────────────────────────────────────────

function diffAgent(
  desired: DesiredAgent["metadata"],
  remote: RemoteAgent | undefined
): AgentDiffRow {
  if (!remote) {
    return { kind: "agent", verb: "create", id: desired.agentId, desired };
  }
  const changed: string[] = [];
  if (desired.name !== remote.name) changed.push("name");
  if ((desired.description ?? "") !== (remote.description ?? "")) {
    changed.push("description");
  }
  if (changed.length === 0) {
    return {
      kind: "agent",
      verb: "noop",
      id: desired.agentId,
      desired,
      remote,
    };
  }
  return {
    kind: "agent",
    verb: "update",
    id: desired.agentId,
    desired,
    remote,
    changedFields: changed,
  };
}

/**
 * Compare desired settings against what's currently stored.
 *
 * Redacted-value handling: server never returns secret values in cleartext;
 * any string starting with `***` from the GET response is treated as opaque
 * and the diff records `<field>:redacted` instead of comparing values. The
 * AgentSettings shape currently has no redacted leaf strings, so this is a
 * forward-compatible guard rather than a hot path today.
 *
 * Field set: limited to the keys lobu.toml can express today. Settings that
 * only the UI mutates (e.g. `installedProviders[].installedAt`) are
 * excluded so unrelated UI activity doesn't show up as drift in the plan.
 */
const SETTINGS_FIELDS: Array<keyof AgentSettings> = [
  "networkConfig",
  "egressConfig",
  "nixConfig",
  "mcpServers",
  "skillsConfig",
  "toolsConfig",
  "guardrails",
  "preApprovedTools",
  "providerModelPreferences",
  "modelSelection",
  "soulMd",
  "userMd",
  "identityMd",
];

function diffSettings(
  agentId: string,
  desired: Partial<AgentSettings>,
  remote: AgentSettings | null
): SettingsDiffRow {
  const changed: string[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field in desired)) continue;
    if (!deepEqual(desired[field], remote?.[field])) {
      changed.push(field);
    }
  }
  // Special case: when the agent itself is being created, the matching settings
  // patch is always considered a "create" so the user sees both rows in the
  // plan. The caller is responsible for setting `verb: "create"` from outside
  // when needed; here we only key off field equality.
  if (changed.length === 0) {
    return { kind: "settings", verb: "noop", id: agentId, desired };
  }
  return {
    kind: "settings",
    verb: "update",
    id: agentId,
    desired,
    changedFields: changed,
  };
}

function diffConnection(
  agentId: string,
  desired: DesiredConnection,
  remote: RemoteConnection | undefined
): ConnectionDiffRow {
  if (!remote) {
    return {
      kind: "connection",
      verb: "create",
      id: desired.stableId,
      agentId,
      desired,
      willRestart: false,
    };
  }
  const changed: string[] = [];
  if (desired.type !== remote.platform) changed.push("type");
  if (!deepEqual(desired.config, remote.config ?? {})) changed.push("config");
  if (changed.length === 0) {
    return {
      kind: "connection",
      verb: "noop",
      id: desired.stableId,
      agentId,
      desired,
      remote,
    };
  }
  return {
    kind: "connection",
    verb: "update",
    id: desired.stableId,
    agentId,
    desired,
    remote,
    changedFields: changed,
    willRestart: changed.includes("config") || changed.includes("type"),
  };
}

function diffEntityType(
  desired: DesiredEntityType,
  remote: RemoteEntityType | undefined
): EntityTypeDiffRow {
  if (!remote) {
    return { kind: "entity-type", verb: "create", id: desired.slug, desired };
  }
  const changed: string[] = [];
  if ((desired.name ?? "") !== (remote.name ?? "")) changed.push("name");
  if ((desired.description ?? "") !== (remote.description ?? "")) {
    changed.push("description");
  }
  if (!deepEqual(desired.required ?? [], remote.required ?? [])) {
    changed.push("required");
  }
  if (!deepEqual(desired.properties, remote.properties)) {
    changed.push("properties");
  }
  if (changed.length === 0) {
    return {
      kind: "entity-type",
      verb: "noop",
      id: desired.slug,
      desired,
      remote,
    };
  }
  return {
    kind: "entity-type",
    verb: "update",
    id: desired.slug,
    desired,
    remote,
    changedFields: changed,
  };
}

function diffRelationshipType(
  desired: DesiredRelationshipType,
  remote: RemoteRelationshipType | undefined
): RelationshipTypeDiffRow {
  if (!remote) {
    return {
      kind: "relationship-type",
      verb: "create",
      id: desired.slug,
      desired,
    };
  }
  const changed: string[] = [];
  if ((desired.name ?? "") !== (remote.name ?? "")) changed.push("name");
  if ((desired.description ?? "") !== (remote.description ?? "")) {
    changed.push("description");
  }
  if (!deepEqual(desired.rules ?? [], remote.rules ?? [])) {
    changed.push("rules");
  }
  if (changed.length === 0) {
    return {
      kind: "relationship-type",
      verb: "noop",
      id: desired.slug,
      desired,
      remote,
    };
  }
  return {
    kind: "relationship-type",
    verb: "update",
    id: desired.slug,
    desired,
    remote,
    changedFields: changed,
  };
}

// ── Top-level diff ─────────────────────────────────────────────────────────

export interface RemoteSnapshot {
  agents: RemoteAgent[];
  /** keyed by agentId */
  agentSettings: Map<string, AgentSettings | null>;
  /** keyed by agentId */
  connectionsByAgent: Map<string, RemoteConnection[]>;
  entityTypes: RemoteEntityType[];
  relationshipTypes: RemoteRelationshipType[];
}

export interface DesiredStateForDiff {
  agents: DesiredAgent[];
  memorySchema: {
    entityTypes: DesiredEntityType[];
    relationshipTypes: DesiredRelationshipType[];
  };
}

export interface ComputeDiffOptions {
  /** Limit the diff to a subset of resource kinds. */
  only?: "agents" | "memory";
}

export function computeDiff(
  desired: DesiredStateForDiff,
  remote: RemoteSnapshot,
  opts: ComputeDiffOptions = {}
): DiffPlan {
  const rows: DiffRow[] = [];
  const only = opts.only;

  if (only !== "memory") {
    const remoteByAgent = new Map(remote.agents.map((a) => [a.agentId, a]));
    const desiredAgentIds = new Set(
      desired.agents.map((a) => a.metadata.agentId)
    );

    for (const agent of desired.agents) {
      const remoteAgent = remoteByAgent.get(agent.metadata.agentId);
      rows.push(diffAgent(agent.metadata, remoteAgent));

      const settingsRow = diffSettings(
        agent.metadata.agentId,
        agent.settings,
        remote.agentSettings.get(agent.metadata.agentId) ?? null
      );
      // If the agent itself is new, escalate the matching settings row to
      // `create` — that's the operator's mental model: the settings are part
      // of the agent's creation, not a follow-up update.
      if (!remoteAgent && settingsRow.verb !== "noop") {
        rows.push({ ...settingsRow, verb: "create" });
      } else if (!remoteAgent) {
        // No desired-side fields set; still emit a create row so the plan
        // shows the apply step actually happens.
        rows.push({ ...settingsRow, verb: "create" });
      } else {
        rows.push(settingsRow);
      }

      const remoteConns =
        remote.connectionsByAgent.get(agent.metadata.agentId) ?? [];
      const remoteByStableId = new Map(remoteConns.map((c) => [c.id, c]));
      const desiredStableIds = new Set(
        agent.connections.map((c) => c.stableId)
      );

      for (const conn of agent.connections) {
        rows.push(
          diffConnection(
            agent.metadata.agentId,
            conn,
            remoteByStableId.get(conn.stableId)
          )
        );
      }
      for (const remoteConn of remoteConns) {
        if (!desiredStableIds.has(remoteConn.id)) {
          rows.push({
            kind: "connection",
            verb: "drift",
            id: remoteConn.id,
            agentId: agent.metadata.agentId,
            remote: remoteConn,
          });
        }
      }
    }

    // Drift: remote agents not in desired state. v1 reports, never deletes.
    for (const remoteAgent of remote.agents) {
      if (!desiredAgentIds.has(remoteAgent.agentId)) {
        rows.push({
          kind: "agent",
          verb: "drift",
          id: remoteAgent.agentId,
          remote: remoteAgent,
        });
      }
    }
  }

  if (only !== "agents") {
    const remoteEntityBySlug = new Map(
      remote.entityTypes.map((e) => [e.slug, e])
    );
    const desiredEntitySlugs = new Set(
      desired.memorySchema.entityTypes.map((e) => e.slug)
    );
    for (const entity of desired.memorySchema.entityTypes) {
      rows.push(diffEntityType(entity, remoteEntityBySlug.get(entity.slug)));
    }
    for (const remoteEntity of remote.entityTypes) {
      if (!desiredEntitySlugs.has(remoteEntity.slug)) {
        rows.push({
          kind: "entity-type",
          verb: "drift",
          id: remoteEntity.slug,
          remote: remoteEntity,
        });
      }
    }

    const remoteRelBySlug = new Map(
      remote.relationshipTypes.map((r) => [r.slug, r])
    );
    const desiredRelSlugs = new Set(
      desired.memorySchema.relationshipTypes.map((r) => r.slug)
    );
    for (const rel of desired.memorySchema.relationshipTypes) {
      rows.push(diffRelationshipType(rel, remoteRelBySlug.get(rel.slug)));
    }
    for (const remoteRel of remote.relationshipTypes) {
      if (!desiredRelSlugs.has(remoteRel.slug)) {
        rows.push({
          kind: "relationship-type",
          verb: "drift",
          id: remoteRel.slug,
          remote: remoteRel,
        });
      }
    }
  }

  const counts = { create: 0, update: 0, noop: 0, drift: 0 };
  for (const row of rows) counts[row.verb]++;

  return { rows, counts };
}
