/**
 * `lobu rollback <apply_id>` — restore a previous deployment from its stored
 * snapshot, through the SAME diff/preview/execute engine as `lobu apply`.
 *
 * A deployment's manifest is self-contained: the redacted desired state plus
 * retained connector-version pins ({key: version} → the org's own
 * `connector_versions` rows). Rollback therefore never re-uploads source,
 * never fetches URLs, and structurally cannot touch a secret:
 *
 *  - connectors: pointer flips via `rollback_connector_version` against the
 *    recorded pins — the bytes already live org-scoped server-side;
 *  - config resources: the snapshot state runs through computeDiff/executePlan
 *    with a plan preview and confirm, exactly like an apply;
 *  - secrets: the snapshot carries structural redaction sentinels, which
 *    sanitization converts to "keep current" (credentials undeclared, provider
 *    keys unpushed, sentinel-bearing platform configs pinned to their current
 *    remote values) — rollback restores INTENT, never rotates a secret.
 *
 * Completing a rollback pauses deployments for the org (Vercel-style paused
 * promotions): the next `lobu apply` refuses until `--resume`, so a CI run
 * can't silently re-promote the config that was just rolled back.
 */

import chalk from "chalk";
import { REDACTED_SENTINEL } from "@lobu/core";
import { printError, printText } from "../../../internal/output.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import { resolveApplyClient } from "./client.js";
import type { DesiredState } from "./desired-state.js";
import { computeDiff } from "./diff.js";
import { confirmPlan } from "./prompt.js";
import { renderPlan, renderProgress } from "./render.js";
import {
  buildCountsByKind,
  buildDeploymentManifest,
  collectGitInfo,
  computeManifestHash,
  mintApplyId,
} from "./deployment.js";
import {
  connectorVersionPins,
  executePlan,
  fetchRemoteSnapshot,
  type PendingAuthEntry,
  resolveBehaviorConnectionRefs,
} from "./apply-cmd.js";

interface RollbackOptions {
  applyId: string;
  cwd?: string;
  yes?: boolean;
  org?: string;
  url?: string;
  cliVersion?: string;
  fetchImpl?: typeof fetch;
}

/** True when any nested value equals the structural redaction sentinel. */
function containsSentinel(value: unknown): boolean {
  if (typeof value === "string") return value === REDACTED_SENTINEL;
  if (Array.isArray(value)) return value.some(containsSentinel);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsSentinel);
  }
  return false;
}

/**
 * Convert the snapshot's redaction sentinels into "keep current" semantics.
 * Returns the sanitized state plus operator-facing notes for anything pinned.
 */
export function sanitizeSnapshotState(
  raw: Record<string, unknown>,
  remotePlatformConfigs: Map<string, Record<string, unknown>>,
  remoteConnectionConfigs: Map<string, Record<string, unknown>> = new Map()
): { state: DesiredState; notes: string[] } {
  const notes: string[] = [];
  const state = structuredClone(raw) as unknown as DesiredState;

  // The key-name denylist redacts `requiredSecrets` (secret NAMES, not
  // values) into a sentinel string; a snapshot re-apply never gates on it.
  state.requiredSecrets = [];

  // Connector definitions ride the pins, not the diff: no source, no installs.
  state.connectors.definitions = [];

  for (const profile of state.connectors.authProfiles) {
    // Redacted credentials → undeclared → the diff never re-pushes them and
    // the profile keeps its live secrets (non-secret fields still reconcile).
    (profile as { credentials?: unknown }).credentials = undefined;
  }

  // Connection configs can carry denylisted keys (an api_key option, etc.):
  // same rule as platforms — pin the sentinel-bearing config to the live
  // remote value, or skip the connection when there is none to pin to.
  state.connectors.connections = state.connectors.connections.filter(
    (connection) => {
      const c = connection as unknown as {
        slug?: string;
        config?: Record<string, unknown>;
      };
      if (!containsSentinel(c.config)) return true;
      const remote = c.slug ? remoteConnectionConfigs.get(c.slug) : undefined;
      if (remote) {
        c.config = remote;
        notes.push(
          `connection ${c.slug}: secret-bearing config left at current values (rollback never rotates secrets)`
        );
        return true;
      }
      notes.push(
        `connection ${c.slug ?? "?"}: secret-bearing config and no live connection to pin to — skipped (re-declare it via lobu apply)`
      );
      return false;
    }
  );

  for (const agent of state.agents) {
    // Provider keys are write-only pushes; a snapshot has no values to push.
    agent.providerKeys = [];
    agent.platforms = agent.platforms.filter((platform) => {
      const p = platform as unknown as {
        platform?: string;
        config?: Record<string, unknown>;
      };
      if (!containsSentinel(p.config)) return true;
      // A sentinel inside platform config would be PUSHED verbatim by the
      // idempotent platform upsert, clobbering the live secret. Pin the whole
      // platform to its current remote config instead (diff → noop).
      const key = `${agent.metadata.agentId}:${p.platform ?? "?"}`;
      const remote = remotePlatformConfigs.get(key);
      if (remote) {
        p.config = remote;
        notes.push(
          `platform ${key}: secret-bearing config left at current values (rollback never rotates secrets)`
        );
        return true;
      }
      notes.push(
        `platform ${key}: secret-bearing config and no live platform to pin to — skipped (re-declare it via lobu apply)`
      );
      return false;
    });
  }

  state.providers = (state.providers ?? []).map((provider) => ({
    ...provider,
    // Empty key → keyDeclared=false → no rotate push; config reconciles.
    apiKey: "",
  }));

  return { state, notes };
}

export async function rollbackCommand(opts: RollbackOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const newApplyId = mintApplyId();
  const { client, orgSlug } = await resolveApplyClient({
    url: opts.url,
    org: opts.org,
    applyId: newApplyId,
    fetchImpl: opts.fetchImpl,
  });
  printText(chalk.dim(`Org: ${orgSlug}`));

  const deployment = await client.getDeployment(opts.applyId);
  if (!deployment) {
    throw new ValidationError(
      `Deployment ${opts.applyId} not found in org "${orgSlug}".`
    );
  }
  if (!deployment.manifest) {
    throw new ValidationError(
      [
        `Deployment ${opts.applyId} predates stored snapshots — no manifest to restore.`,
        deployment.gitSha
          ? `Roll back via git instead: revert to ${deployment.gitSha.slice(0, 12)} in your config repo and run \`lobu apply\`.`
          : "Roll back via git: revert the config repo to the matching commit and run `lobu apply`.",
      ].join("\n")
    );
  }

  const manifest = deployment.manifest;
  printText(
    chalk.bold(
      `\nRolling back to deployment ${opts.applyId}${deployment.createdAt ? ` (${deployment.createdAt})` : ""}`
    )
  );

  // ── Connector pins: pointer flips against retained versions ──────────────
  const catalog = await client.listConnectors(true);
  const activeByKey = new Map(
    catalog
      .filter((d) => d.installed && d.version)
      .map((d) => [d.key, d.version as string])
  );
  const repoints: Array<{ key: string; from: string | undefined; to: string }> =
    [];
  for (const [key, version] of Object.entries(
    manifest.connector_versions ?? {}
  )) {
    const current = activeByKey.get(key);
    if (current !== version) {
      repoints.push({ key, from: current, to: version });
    }
  }

  // ── Config resources: snapshot state through the standard diff ───────────
  // Two-pass sanitize: the first pass (no remote configs yet) yields a state
  // shaped well enough to fetch the remote snapshot; the second pins
  // sentinel-bearing platform configs to the live remote values it found.
  const prelim = sanitizeSnapshotState(manifest.state, new Map());
  const remote = await fetchRemoteSnapshot(
    client,
    prelim.state,
    undefined,
    false
  );
  const remotePlatformConfigs = new Map<string, Record<string, unknown>>();
  for (const [agentId, platforms] of remote.platformsByAgent) {
    for (const platform of platforms) {
      if (platform.config) {
        remotePlatformConfigs.set(
          `${agentId}:${platform.platform}`,
          platform.config
        );
      }
    }
  }
  const remoteConnectionConfigs = new Map<string, Record<string, unknown>>();
  for (const connection of remote.connections) {
    if (connection.config) {
      remoteConnectionConfigs.set(connection.slug, connection.config);
    }
  }
  const sanitized = sanitizeSnapshotState(
    manifest.state,
    remotePlatformConfigs,
    remoteConnectionConfigs
  );
  // Behaviors declare event triggers by connection SLUG; the API contract
  // wants integer ids — resolve against the live connections, exactly as
  // apply does.
  resolveBehaviorConnectionRefs(
    sanitized.state.watchers,
    new Map(remote.connections.map((c) => [c.slug, c.id])),
    false
  );
  const plan = computeDiff(sanitized.state, remote, {});

  // ── Preview ───────────────────────────────────────────────────────────────
  if (repoints.length > 0) {
    printText(chalk.bold("\nConnector rollbacks:"));
    for (const r of repoints) {
      printText(`  ↺ ${r.key}: ${r.from ?? "(not installed)"} → ${r.to}`);
    }
  }
  printText(renderPlan(plan));
  for (const note of sanitized.notes) {
    printText(chalk.yellow(`Note: ${note}`));
  }

  const totalChanges =
    repoints.length +
    plan.counts.create +
    plan.counts.update +
    plan.counts.delete;
  if (totalChanges === 0) {
    printText(
      chalk.green("\nAlready at this deployment — nothing to roll back.")
    );
    return;
  }

  const approved = await confirmPlan({
    yes: opts.yes ?? false,
    summaryLine: `${repoints.length} connector rollback${repoints.length === 1 ? "" : "s"}, ${plan.counts.create} create, ${plan.counts.update} update, ${plan.counts.delete} delete`,
  });
  if (!approved) {
    printText(chalk.dim("\nCancelled."));
    return;
  }

  // ── Execute: pins first (catalog correctness for everything after) ────────
  let rollbackErr: unknown;
  try {
    for (const r of repoints) {
      await client.rollbackConnectorVersion(r.key, r.to);
      printText(
        renderProgress(
          "update",
          "connector-definition",
          r.key,
          `(rolled back to ${r.to})`
        )
      );
    }
    const hasResourceWork =
      plan.counts.create > 0 ||
      plan.counts.update > 0 ||
      plan.counts.delete > 0;
    if (hasResourceWork) {
      printText(chalk.bold("\nApplying snapshot:"));
      const pendingAuth: PendingAuthEntry[] = [];
      await executePlan(
        { client, state: sanitized.state, plan, remote },
        pendingAuth
      );
    }
    printText(chalk.green("\nRollback complete."));
  } catch (err) {
    rollbackErr = err;
    printError(`\n${err instanceof Error ? err.message : String(err)}`);
    printError(
      "Rollback halted on first failure. Re-run once the underlying issue is resolved — every step is idempotent."
    );
  }

  // ── Record as a deployment + pause promotions ─────────────────────────────
  const gitInfo = collectGitInfo(cwd);
  try {
    await client.postDeploymentSummary({
      apply_id: newApplyId,
      status: rollbackErr ? "partial_failure" : "succeeded",
      counts: plan.counts,
      counts_by_kind: {
        ...buildCountsByKind(plan.rows),
        ...(repoints.length > 0
          ? { "connector-version": { update: repoints.length } }
          : {}),
      },
      manifest_hash: computeManifestHash(sanitized.state),
      git_sha: gitInfo.sha,
      git_dirty: gitInfo.dirty,
      cli_version: opts.cliVersion ?? null,
      rollback_of: opts.applyId,
      // Re-post the restored snapshot so rolling FORWARD to this deployment
      // works the same way. Pins reflect what the rollback set.
      manifest: buildDeploymentManifest(sanitized.state, {
        ...connectorVersionPins(sanitized.state, catalog),
        ...Object.fromEntries(repoints.map((r) => [r.key, r.to])),
        ...manifest.connector_versions,
      }),
    });
  } catch (err) {
    printText(
      chalk.yellow(
        `Warning: could not record the rollback deployment (${err instanceof Error ? err.message : String(err)}).`
      )
    );
  }

  if (!rollbackErr) {
    try {
      await client.setDeploymentPause({
        applyId: newApplyId,
        rollbackOf: opts.applyId,
      });
      printText(
        [
          "",
          chalk.yellow("Deployments are now PAUSED for this org."),
          "Reconcile your config repo (e.g. `git revert` the bad change), then run:",
          "  lobu apply --resume",
        ].join("\n")
      );
    } catch (err) {
      printText(
        chalk.yellow(
          `Warning: could not pause deployments (${err instanceof Error ? err.message : String(err)}) — a CI apply may re-promote the rolled-back config.`
        )
      );
    }
  }

  if (rollbackErr) throw rollbackErr;
}
