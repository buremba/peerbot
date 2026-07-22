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
import type { DiffPlan, DiffRow } from "./diff.js";
import { canonical } from "./diff.js";
import type { DesiredState } from "./desired-state.js";

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
 * memory — agent `providerKeys[].value`, org provider `apiKey`, auth-profile
 * `credentials`, and platform `config` values (resolved from `$VAR`/`secret()`
 * at map time) — then deep-redact by key-name denylist. Shared by the
 * manifest hash and the stored deployment snapshot: a snapshot NEVER carries
 * a secret value, so `lobu rollback` structurally cannot re-apply one.
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
      // Platform config values are resolved plaintext at this point; deep-
      // redact (not wholesale) so a NON-secret config change (e.g. a channel
      // id) still changes the manifest hash. A secret under a key the
      // denylist misses only perturbs the hash input — sha256 doesn't reveal
      // it, so the cost is hash-changes-on-rotation for that field, not a leak.
      platforms: agent.platforms.map((p) => ({
        ...(p as unknown as Record<string, unknown>),
        config: deepRedactSecrets(
          (p as unknown as { config?: unknown }).config ?? null
        ),
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
}

/**
 * Build the stored deployment snapshot. `connectorVersions` maps each
 * config-declared connector key to the version active AFTER this apply
 * (`install_connector` responses / the refreshed catalog) — the pins
 * `lobu rollback` repoints to via `rollback_connector_version`.
 */
export function buildDeploymentManifest(
  state: DesiredState,
  connectorVersions: Record<string, string>
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
  };
}

export type CountsByKind = Record<
  string,
  { create?: number; update?: number; delete?: number }
>;

/**
 * Map an internal DiffRow kind to the public `counts_by_kind` wire key.
 * Diff rows still use `watcher`; the deployments API public discriminator is
 * `behavior` (product rename). Display labels live in render.ts; this is the
 * wire boundary only.
 */
function wireCountsKind(kind: DiffRow["kind"]): string {
  return kind === "watcher" ? "behavior" : kind;
}

/** Per-resource-kind create/update/delete tallies for the summary payload. */
export function buildCountsByKind(rows: DiffRow[]): CountsByKind {
  const out: CountsByKind = {};
  for (const row of rows) {
    if (row.verb !== "create" && row.verb !== "update" && row.verb !== "delete")
      continue;
    const key = wireCountsKind(row.kind);
    const bucket = out[key] ?? {};
    out[key] = bucket;
    bucket[row.verb] = (bucket[row.verb] ?? 0) + 1;
  }
  return out;
}

export interface DeploymentSummary {
  apply_id: string;
  status: "succeeded" | "partial_failure";
  counts: DiffPlan["counts"];
  counts_by_kind: CountsByKind;
  manifest_hash: string;
  git_sha: string | null;
  git_dirty: boolean | null;
  cli_version: string | null;
  error?: string;
  /** Self-contained snapshot for `lobu rollback` (absent on legacy CLIs). */
  manifest?: DeploymentManifest;
  /** Set on rollback deployments: the deployment this one restored. */
  rollback_of?: string;
}
