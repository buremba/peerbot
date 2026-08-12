/**
 * Deployment identity for `lobu apply`.
 *
 * Each apply run mints an `apply_id`, sends it as `x-lobu-apply-id` on every
 * mutation (the server stamps its config-audit events with it), and posts a
 * summary to `POST /api/<org>/deployments` at the end — including the
 * redacted desired-state snapshot (`manifest`) that makes the deployment
 * self-contained: `lobu rollback <apply_id>` re-applies it through the same
 * diff/execute engine, repointing connectors to their retained versions. The
 * summary still records the config repo's HEAD SHA so git-first rollback
 * (revert commit → re-apply) stays first-class for config-as-code orgs.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { deepRedactSecrets, REDACTED_SENTINEL } from "@lobu/core";
import type { DesiredState } from "./desired-state.js";
import type { DiffPlan, DiffRow, RemoteSnapshot } from "./diff.js";
import { canonical } from "./diff.js";

export function mintApplyId(): string {
  return `apl_${randomUUID()}`;
}

export interface GitInfo {
  sha: string | null;
  dirty: boolean | null;
}

/** HEAD SHA + dirty flag of the config repo; nulls outside a git work tree. */
export function collectGitInfo(cwd: string): GitInfo {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return { sha: sha || null, dirty: porcelain.length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

/**
 * Structurally redact the fields that hold RESOLVED secret values in process
 * memory — agent `providerKeys[].value`, org provider `apiKey`, and auth-profile
 * `credentials` (resolved from `$VAR`/`secret()` at map time) — then deep-redact
 * by key-name denylist. Shared by the manifest hash and the stored deployment
 * snapshot: a snapshot NEVER carries a secret value, so `lobu rollback`
 * structurally cannot re-apply one.
 */
export function redactDesiredState(
  state: DesiredState
): Record<string, unknown> {
  return deepRedactSecrets({
    ...state,
    agents: state.agents.map((agent) => ({
      ...agent,
      providerKeys: agent.providerKeys.map((k) => ({
        providerId: k.providerId,
        value: REDACTED_SENTINEL,
      })),
    })),
    providers: (state.providers ?? []).map((p) => ({
      ...p,
      apiKey: REDACTED_SENTINEL,
    })),
    connectors: {
      ...state.connectors,
      authProfiles: state.connectors.authProfiles.map((profile) => ({
        ...(profile as unknown as Record<string, unknown>),
        credentials: REDACTED_SENTINEL,
      })),
    },
  }) as Record<string, unknown>;
}

/**
 * sha256 of the redacted, canonicalized desired state. The hash identifies a
 * config revision; two applies of the same config (same secrets or not) hash
 * identically because secret VALUES never participate.
 */
export function computeManifestHash(state: DesiredState): string {
  return `sha256:${createHash("sha256")
    .update(canonical(redactDesiredState(state)))
    .digest("hex")}`;
}

export const SNAPSHOT_VERSION = 1;

export interface DeploymentManifest {
  version: typeof SNAPSHOT_VERSION;
  /**
   * The redacted desired state, minus connector source bytes: connector
   * definitions are stripped to declaration metadata, and the artifacts they
   * resolved to ride `connector_versions` below as retained
   * (org, key, version) pins — a deployment is self-contained without ever
   * embedding code or secrets.
   */
  state: Record<string, unknown>;
  /** Active connector version per declared key, recorded post-install. */
  connector_versions: Record<string, string>;
  /**
   * The attribution baseline for the three-way drift compare: the effective
   * entity/rel-type and Behavior state AFTER this apply (declared config
   * values + preserved unmanaged facets). Absent on legacy manifests — treated
   * as "no baseline" (block on remote mismatches, never auto-delete).
   */
  attribution?: {
    entityTypes: unknown[];
    relationshipTypes: unknown[];
    watchers: unknown[];
  };
  /**
   * Kind-qualified definition incarnation identities (`entity-type:12`,
   * `behavior:b7-…`) this config actually applied — the delete-eligible set.
   */
  owned?: string[];
}

export interface BaselineRecord {
  attribution: {
    entityTypes: unknown[];
    relationshipTypes: unknown[];
    watchers: unknown[];
  };
  owned: string[];
}

/** Parse the stored baseline; null for a legacy manifest (→ no-baseline block). */
export function loadBaselineFromManifest(manifest: {
  attribution?: DeploymentManifest["attribution"];
  owned?: DeploymentManifest["owned"];
} | null): BaselineRecord | null {
  if (!manifest?.attribution || !manifest.owned) return null;
  return {
    attribution: {
      entityTypes: manifest.attribution.entityTypes ?? [],
      relationshipTypes: manifest.attribution.relationshipTypes ?? [],
      watchers: manifest.attribution.watchers ?? [],
    },
    owned: manifest.owned,
  };
}

/**
 * The post-apply attribution snapshot + owned identities. Attribution records
 * the effective entity/rel/Behavior state AFTER a successful apply — config's
 * declared values merged with preserved unmanaged facets (eventKinds /
 * viewTemplate / schemaExtras the config never declared) from the pre-apply
 * remote — so `remote == attribution` means "unchanged since last apply".
 * `owned` records the incarnation ids of definitions this config applied
 * (delete-eligible); creates with no known id are conservatively omitted
 * (they block as drift instead of auto-deleting — fail-closed).
 */
export function buildAttributionAndOwned(
  state: DesiredState,
  remote: RemoteSnapshot
): BaselineRecord {
  const remoteEntityBySlug = new Map(remote.entityTypes.map((e) => [e.slug, e]));
  const entityTypes = state.memorySchema.entityTypes.map((d) => {
    const r = remoteEntityBySlug.get(d.slug);
    return {
      id: r?.id,
      slug: d.slug,
      name: d.name,
      description: d.description,
      required: d.required,
      properties: d.properties,
      backing: d.backing,
      metrics: d.metrics,
      eventKinds: d.eventKinds ?? r?.eventKinds,
      viewTemplate: d.viewTemplate ?? r?.viewTemplate,
      schemaExtras: {
        ...(r?.schemaExtras ?? {}),
        ...(d.resolutionPolicy
          ? { "x-lobu-resolution": d.resolutionPolicy }
          : {}),
      },
    };
  });
  const remoteRelBySlug = new Map(
    remote.relationshipTypes.map((r) => [r.slug, r])
  );
  const relationshipTypes = state.memorySchema.relationshipTypes.map((d) => {
    const r = remoteRelBySlug.get(d.slug);
    return {
      id: r?.id,
      slug: d.slug,
      name: d.name,
      description: d.description,
      rules: d.rules,
    };
  });
  const remoteWatcherBySlug = new Map(remote.watchers.map((w) => [w.slug, w]));
  const watchers = state.watchers.map((d) => {
    const r = remoteWatcherBySlug.get(d.slug);
    return {
      slug: d.slug,
      behavior_id: r?.behavior_id,
      name: d.name,
      description: d.description,
      prompt: d.prompt,
      triggers: d.triggers,
      skills: d.skillSnapshots ?? r?.skills,
      sources: d.sources,
      reactions_guidance: d.reactionsGuidance,
      device_worker_id: d.deviceWorkerId,
      notification_channel: d.notificationChannel,
      notification_priority: d.notificationPriority,
      min_cooldown_seconds: d.minCooldownSeconds,
      tags: d.tags,
      agent_kind: d.agentKind,
      outputs: d.outputs,
      classifiers: d.classifiers,
    };
  });
  const owned: string[] = [];
  for (const e of state.memorySchema.entityTypes) {
    const id = remoteEntityBySlug.get(e.slug)?.id;
    if (id !== undefined) owned.push(`entity-type:${id}`);
  }
  for (const r of state.memorySchema.relationshipTypes) {
    const id = remoteRelBySlug.get(r.slug)?.id;
    if (id !== undefined) owned.push(`relationship-type:${id}`);
  }
  for (const w of state.watchers) {
    const id = remoteWatcherBySlug.get(w.slug)?.behavior_id;
    if (id !== undefined) owned.push(`watcher:${id}`);
  }
  return {
    attribution: { entityTypes, relationshipTypes, watchers },
    owned,
  };
}

/**
 * Build the stored deployment snapshot. `connectorVersions` maps each
 * config-declared connector key to the version active AFTER this apply
 * (`install_connector` responses / the refreshed catalog) — the pins
 * `lobu rollback` repoints to via `rollback_connector_version`.
 */
export function buildDeploymentManifest(
  state: DesiredState,
  connectorVersions: Record<string, string>,
  baseline?: BaselineRecord
): DeploymentManifest {
  const redacted = redactDesiredState(state);
  const connectors = (redacted.connectors ?? {}) as Record<string, unknown>;
  const definitions = Array.isArray(connectors.definitions)
    ? (connectors.definitions as Array<Record<string, unknown>>)
    : [];
  return {
    version: SNAPSHOT_VERSION,
    state: {
      ...redacted,
      connectors: {
        ...connectors,
        // Keep the declaration shape for display/diff labels; drop the bytes.
        definitions: definitions.map(
          ({ sourceCode: _sourceCode, ...def }) => def
        ),
      },
    },
    connector_versions: connectorVersions,
    ...(baseline ? { attribution: baseline.attribution, owned: baseline.owned } : {}),
  };
}

export type CountsByKind = Record<
  string,
  { create?: number; update?: number; delete?: number }
>;

/** Per-resource-kind create/update/delete tallies for the summary payload. */
export function buildCountsByKind(rows: DiffRow[]): CountsByKind {
  const out: CountsByKind = {};
  for (const row of rows) {
    if (row.verb !== "create" && row.verb !== "update" && row.verb !== "delete")
      continue;
    const key = row.kind === "watcher" ? "behavior" : row.kind;
    const bucket = out[key] ?? {};
    out[key] = bucket;
    bucket[row.verb] = (bucket[row.verb] ?? 0) + 1;
  }
  return out;
}

export interface DeploymentSummary {
  apply_id: string;
  status: "succeeded" | "partial_failure" | "blocked";
  counts: DiffPlan["counts"];
  counts_by_kind: CountsByKind;
  manifest_hash: string;
  git_sha: string | null;
  git_dirty: boolean | null;
  cli_version: string | null;
  error?: string;
  /** Self-contained snapshot for `lobu rollback` (absent on legacy CLIs). */
  manifest?: DeploymentManifest;
  /** Blocking-drift candidates — present on `blocked` runs. */
  candidates?: {
    items: Array<{
      kind: string;
      slug: string;
      field?: string;
      action: "delete" | "revert";
    }>;
  };
  /** Set on rollback deployments: the deployment this one restored. */
  rollback_of?: string;
}
