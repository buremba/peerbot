import chalk from "chalk";
import { ApiError, ValidationError } from "../../memory/_lib/errors.js";
import { printError, printText } from "../../memory/_lib/output.js";
import {
  type ApplyClient,
  type RemoteAgent,
  type RemoteConnection,
  resolveApplyClient,
} from "./client.js";
import {
  computeDiff,
  type DiffPlan,
  type DiffRow,
  type RemoteSnapshot,
} from "./diff.js";
import { type DesiredState, loadDesiredState } from "./desired-state.js";
import { confirmPlan } from "./prompt.js";
import { renderMissingSecrets, renderPlan, renderProgress } from "./render.js";

export interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
  yes?: boolean;
  only?: "agents" | "memory";
  org?: string;
  url?: string;
  storePath?: string;
  /** Test seam — inject a stubbed fetch. */
  fetchImpl?: typeof fetch;
}

// ── Required-secrets check ─────────────────────────────────────────────────

/**
 * v1 secret check: every `$VAR` referenced in lobu.toml must be present in
 * the apply runner's environment. The file-loader already substitutes envs
 * in-place during gateway boot, so this is the same set of names operators
 * must satisfy at runtime — surfacing it pre-mutation gives the operator
 * a cleaner failure than a silent empty-string config push.
 *
 * Plan §7 reserves cloud-side secret-list cross-checks for v3.
 */
function checkRequiredSecrets(state: DesiredState): { missing: string[] } {
  const missing = state.requiredSecrets.filter(
    (name) => process.env[name] === undefined || process.env[name] === ""
  );
  return { missing };
}

// ── Snapshot ───────────────────────────────────────────────────────────────

async function fetchRemoteSnapshot(
  client: ApplyClient,
  state: DesiredState,
  only?: "agents" | "memory"
): Promise<RemoteSnapshot> {
  const agents: RemoteAgent[] =
    only === "memory" ? [] : await client.listAgents();
  const agentSettings = new Map<
    string,
    Awaited<ReturnType<ApplyClient["getAgentSettings"]>>
  >();
  const connectionsByAgent = new Map<string, RemoteConnection[]>();

  if (only !== "memory") {
    const desiredAgentIds = state.agents.map((a) => a.metadata.agentId);
    const remoteAgentIds = new Set(agents.map((a) => a.agentId));
    // Only GET settings for agents that exist; new agents have no remote
    // settings to compare against.
    const targetAgentIds = desiredAgentIds.filter((id) =>
      remoteAgentIds.has(id)
    );
    for (const agentId of targetAgentIds) {
      agentSettings.set(agentId, await client.getAgentSettings(agentId));
      connectionsByAgent.set(agentId, await client.listConnections(agentId));
    }
  }

  const entityTypes = only === "agents" ? [] : await client.listEntityTypes();
  const relationshipTypes =
    only === "agents" ? [] : await client.listRelationshipTypes();

  return {
    agents,
    agentSettings,
    connectionsByAgent,
    entityTypes,
    relationshipTypes,
  };
}

// ── Apply executor ─────────────────────────────────────────────────────────

interface ApplyContext {
  client: ApplyClient;
  state: DesiredState;
  plan: DiffPlan;
}

/**
 * Execute the plan in dependency order. Plan §footgun-7: agents → settings →
 * connections → entity types → relationship types. No retry loop, no
 * topological sort. First failure prints partial progress and re-throws.
 */
async function executePlan(ctx: ApplyContext): Promise<void> {
  const rowsByKind = (kind: DiffRow["kind"]) =>
    ctx.plan.rows.filter(
      (row) => row.kind === kind && row.verb !== "noop" && row.verb !== "drift"
    );

  // 1) Agents
  for (const row of rowsByKind("agent")) {
    if (row.kind !== "agent") continue;
    if (!row.desired) continue;
    const desired = ctx.state.agents.find((a) => a.metadata.agentId === row.id);
    if (!desired) continue;
    await ctx.client.upsertAgent(desired.metadata);
    printText(renderProgress(row.verb, "agent", row.id));
  }

  // 2) Settings
  for (const row of rowsByKind("settings")) {
    if (row.kind !== "settings") continue;
    const desired = ctx.state.agents.find((a) => a.metadata.agentId === row.id);
    if (!desired) continue;
    await ctx.client.patchAgentSettings(row.id, desired.settings);
    printText(
      renderProgress(
        row.verb,
        "settings",
        row.id,
        row.changedFields ? `(${row.changedFields.join(", ")})` : undefined
      )
    );
  }

  // 3) Connections
  for (const row of rowsByKind("connection")) {
    if (row.kind !== "connection") continue;
    const desired = row.desired;
    if (!desired) continue;
    const result = await ctx.client.upsertConnection(
      row.agentId,
      desired.stableId,
      {
        platform: desired.type,
        ...(desired.name ? { name: desired.name } : {}),
        config: desired.config,
      }
    );
    const detail = result.willRestart
      ? "(restarted)"
      : result.noop
        ? "(noop on server)"
        : undefined;
    printText(
      renderProgress(row.verb, "connection", `${row.agentId}/${row.id}`, detail)
    );
  }

  // 4) Entity types
  for (const row of rowsByKind("entity-type")) {
    if (row.kind !== "entity-type") continue;
    if (!row.desired) continue;
    await ctx.client.upsertEntityType(row.desired);
    printText(renderProgress(row.verb, "entity-type", row.id));
  }

  // 5) Relationship types
  for (const row of rowsByKind("relationship-type")) {
    if (row.kind !== "relationship-type") continue;
    if (!row.desired) continue;
    await ctx.client.upsertRelationshipType(row.desired);
    printText(renderProgress(row.verb, "relationship-type", row.id));
  }
}

// ── Top-level command ──────────────────────────────────────────────────────

export async function applyCommand(opts: ApplyOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const { state, configPath } = await loadDesiredState({ cwd });

  printText(chalk.dim(`Config: ${configPath}`));

  // Required secrets gate: fail before any network mutation.
  const { missing } = checkRequiredSecrets(state);
  if (missing.length > 0) {
    printError(renderMissingSecrets(missing));
    throw new ValidationError(
      `${missing.length} required secret${missing.length === 1 ? "" : "s"} missing — see above.`
    );
  }

  const { client, orgSlug } = await resolveApplyClient({
    url: opts.url,
    org: opts.org,
    storePath: opts.storePath,
    fetchImpl: opts.fetchImpl,
  });
  printText(chalk.dim(`Org: ${orgSlug}`));

  const remote = await fetchRemoteSnapshot(client, state, opts.only);
  const plan = computeDiff(state, remote, { only: opts.only });

  printText(renderPlan(plan));

  if (opts.dryRun) {
    printText(chalk.dim("\nDry run — no changes applied."));
    return;
  }

  if (plan.counts.create === 0 && plan.counts.update === 0) {
    printText(chalk.green("\nNothing to apply."));
    return;
  }

  // Build a plain-text summary for the inquirer prompt — chalk-decorated
  // text confuses some terminals when re-printed by the prompt library.
  const { create, update, noop, drift } = plan.counts;
  const summaryLine = `${create} create, ${update} update, ${noop} noop, ${drift} drift`;
  const approved = await confirmPlan({
    yes: opts.yes ?? false,
    summaryLine,
  });
  if (!approved) {
    printText(chalk.dim("\nCancelled."));
    return;
  }

  printText(chalk.bold("\nApplying:"));
  try {
    await executePlan({ client, state, plan });
    printText(chalk.green("\nApply complete."));
  } catch (err) {
    if (err instanceof ApiError) {
      printError(`\n${err.message}`);
    } else if (err instanceof Error) {
      printError(`\n${err.message}`);
    } else {
      printError(`\n${String(err)}`);
    }
    printError(
      "Apply halted on first failure. Re-run `lobu apply` once the underlying issue is resolved — every endpoint is idempotent."
    );
    throw err;
  }
}
