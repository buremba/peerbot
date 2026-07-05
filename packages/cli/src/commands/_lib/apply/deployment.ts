/**
 * Deployment identity for `lobu apply`.
 *
 * Each apply run mints an `apply_id`, sends it as `x-lobu-apply-id` on every
 * mutation (the server stamps its config-audit events with it), and posts a
 * summary to `POST /api/<org>/deployments` at the end. Rollback stays
 * git-first: the summary records the config repo's HEAD SHA so the
 * Deployments UI can point at the commit to revert.
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
 * sha256 of the redacted, canonicalized desired state. Beyond the key-name
 * denylist, the fields that hold RESOLVED secret values in process memory are
 * stripped structurally: agent `providerKeys[].value`, org provider `apiKey`,
 * auth-profile `credentials`, and platform `config` values (resolved from
 * `$VAR`/`secret()` at map time). The hash identifies a config revision; two
 * applies of the same config (same secrets or not) hash identically because
 * secret VALUES never participate.
 */
export function computeManifestHash(state: DesiredState): string {
  const redacted = deepRedactSecrets({
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
  });
  return `sha256:${createHash("sha256").update(canonical(redacted)).digest("hex")}`;
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
    const kind = out[row.kind] ?? {};
    out[row.kind] = kind;
    kind[row.verb] = (kind[row.verb] ?? 0) + 1;
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
}
