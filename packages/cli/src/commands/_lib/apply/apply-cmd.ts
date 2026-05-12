import chalk from "chalk";
import { resolveContext } from "../../../internal/context.js";
import { loadProjectLink } from "../../../internal/project-link.js";
import { ApiError, ValidationError } from "../../memory/_lib/errors.js";
import { printError, printText } from "../../memory/_lib/output.js";
import {
  type ApplyClient,
  type RemoteAgent,
  type RemoteConnectorDefinition,
  type RemoteFeed,
  type RemotePlatform,
  resolveApplyClient,
} from "./client.js";
import {
  computeDiff,
  type DiffPlan,
  type DiffRow,
  type RemoteSnapshot,
} from "./diff.js";
import {
  type DesiredState,
  loadDesiredState,
  resolveConnectorSchemas,
  validateAuthProfileAgainstConnector,
  validateConnectionAgainstConnector,
} from "./desired-state.js";
import { confirmPlan } from "./prompt.js";
import {
  renderMissingSecrets,
  renderPlan,
  renderPostApplyPunchList,
  renderProgress,
} from "./render.js";

export interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
  yes?: boolean;
  only?: "agents" | "memory";
  org?: string;
  url?: string;
  /** Bypass the project-link guard. */
  force?: boolean;
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
  const platformsByAgent = new Map<string, RemotePlatform[]>();

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
      platformsByAgent.set(agentId, await client.listPlatforms(agentId));
    }
  }

  const entityTypes = only === "agents" ? [] : await client.listEntityTypes();
  const relationshipTypes =
    only === "agents" ? [] : await client.listRelationshipTypes();
  const watchers = only === "agents" ? [] : await client.listWatchers();

  // Connectors run only on a full apply (`--only` skips them).
  const hasConnectors =
    state.connectors.definitions.length > 0 ||
    state.connectors.authProfiles.length > 0 ||
    state.connectors.connections.length > 0;
  const connectorDefinitions =
    only || !hasConnectors ? [] : await client.listConnectorDefinitions(true);
  const authProfiles =
    only || !hasConnectors ? [] : await client.listAuthProfiles();
  const connections =
    only || !hasConnectors ? [] : await client.listConnections();
  const feedsByConnectionId = new Map<number, RemoteFeed[]>();
  if (!only && hasConnectors) {
    const desiredConnSlugs = new Set(
      state.connectors.connections.map((c) => c.slug)
    );
    for (const conn of connections) {
      if (!desiredConnSlugs.has(conn.slug)) continue;
      feedsByConnectionId.set(conn.id, await client.listFeeds(conn.id));
    }
  }

  return {
    agents,
    agentSettings,
    platformsByAgent,
    entityTypes,
    relationshipTypes,
    watchers,
    connectorDefinitions,
    authProfiles,
    connections,
    feedsByConnectionId,
  };
}

// ── Connector validation ───────────────────────────────────────────────────

/**
 * Validate declared connections / auth profiles against the connector
 * definitions the server knows about (bundled catalog + installed custom).
 * Connectors that only exist as a local `.ts` not yet compiled by the server
 * are skipped — the server validates those at `install_connector` /
 * `create_feed` time. Schema mismatches throw `ValidationError`.
 */
function validateConnectorState(
  state: DesiredState,
  remote: RemoteSnapshot
): void {
  const defByKey = new Map<string, RemoteConnectorDefinition>(
    remote.connectorDefinitions.map((d) => [d.key, d])
  );
  const authProfilesBySlug = new Map(
    state.connectors.authProfiles.map((p) => [p.slug, p])
  );
  for (const profile of state.connectors.authProfiles) {
    const def = defByKey.get(profile.connector);
    validateAuthProfileAgainstConnector(
      profile,
      def ? resolveConnectorSchemas(def) : null
    );
  }
  for (const connection of state.connectors.connections) {
    const def = defByKey.get(connection.connector);
    validateConnectionAgainstConnector(
      connection,
      authProfilesBySlug,
      def ? resolveConnectorSchemas(def) : null
    );
  }
}

// ── Apply executor ─────────────────────────────────────────────────────────

interface ApplyContext {
  client: ApplyClient;
  state: DesiredState;
  plan: DiffPlan;
  remote: RemoteSnapshot;
}

interface PendingAuthEntry {
  slug: string;
  kind: string;
  connectUrl?: string;
}

/**
 * Execute the plan in dependency order:
 *   agents → settings → platforms → entity types → relationship types →
 *   watchers → connector definitions → auth profiles → connections (+ feeds)
 *
 * No retry loop, no topological sort. First failure prints partial progress
 * and re-throws. Returns the post-apply punch-list (pending interactive-auth
 * profiles + informational notes).
 */
async function executePlan(
  ctx: ApplyContext
): Promise<{ pendingAuth: PendingAuthEntry[] }> {
  const pendingAuth: PendingAuthEntry[] = [];
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
    if (row.verb === "create") {
      await ctx.client.upsertAgent(desired.metadata);
    } else {
      await ctx.client.patchAgentMetadata(row.id, {
        name: desired.metadata.name,
        description: desired.metadata.description,
      });
    }
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

  // 3) Platforms
  for (const row of rowsByKind("platform")) {
    if (row.kind !== "platform") continue;
    const desired = row.desired;
    if (!desired) continue;
    const result = await ctx.client.upsertPlatform(
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
      renderProgress(row.verb, "platform", `${row.agentId}/${row.id}`, detail)
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

  // 6) Watchers (create-only; drift ignored)
  for (const row of rowsByKind("watcher")) {
    if (row.kind !== "watcher") continue;
    if (!row.desired) continue;
    const w = row.desired;
    await ctx.client.createWatcher({
      slug: w.slug,
      name: w.name,
      description: w.description,
      prompt: w.prompt,
      extraction_schema: w.extractionSchema,
      schedule: w.schedule,
      sources: w.sources,
    });
    printText(renderProgress(row.verb, "watcher", row.id));
  }

  // 7) Connector definitions (idempotent install — server compiles the source)
  for (const row of rowsByKind("connector-definition")) {
    if (row.kind !== "connector-definition") continue;
    if (!row.desired) continue;
    const def = row.desired;
    const result = await ctx.client.installConnector(
      def.sourceCode !== undefined
        ? { sourceCode: def.sourceCode }
        : { sourceUrl: def.sourceUrl }
    );
    printText(
      renderProgress(
        "create",
        "connector-definition",
        result.connectorKey || def.key || def.sourceFile,
        result.updated ? "(installed)" : "(unchanged)"
      )
    );
  }

  // 7b) Bundled connectors referenced by an auth profile / connection must be
  //     installed into the org before `create_auth_profile` (which only finds
  //     installed defs, not the catalog). Install from the catalog's
  //     server-side source URI; skip ones already installed or custom.
  {
    const installedKeys = new Set(
      (ctx.remote.connectorDefinitions ?? [])
        .filter((d) => d.installed)
        .map((d) => d.key)
    );
    const catalogByKey = new Map(
      (ctx.remote.connectorDefinitions ?? [])
        .filter((d) => d.installable && d.source_uri)
        .map((d) => [d.key, d])
    );
    const referenced = new Set<string>([
      ...ctx.state.connectors.authProfiles.map((p) => p.connector),
      ...ctx.state.connectors.connections.map((c) => c.connector),
    ]);
    for (const key of [...referenced].sort()) {
      if (installedKeys.has(key)) continue;
      const catalog = catalogByKey.get(key);
      if (!catalog?.source_uri) continue; // custom local-only connector handled above
      const result = await ctx.client.installConnector({
        sourceUri: catalog.source_uri,
      });
      printText(
        renderProgress(
          "create",
          "connector-definition",
          result.connectorKey || key,
          result.updated ? "(installed bundled)" : "(bundled — unchanged)"
        )
      );
    }
  }

  // 8) Auth profiles (create / update; interactive kinds → punch-list)
  for (const row of rowsByKind("auth-profile")) {
    if (row.kind !== "auth-profile") continue;
    const desired = ctx.state.connectors.authProfiles.find(
      (p) => p.slug === row.id
    );
    if (!desired) continue;
    let result;
    if (row.verb === "create") {
      result = await ctx.client.createAuthProfile({
        slug: desired.slug,
        connector: desired.connector,
        kind: desired.kind,
        name: desired.name,
        credentials: desired.credentials,
      });
    } else {
      result = await ctx.client.updateAuthProfile({
        slug: desired.slug,
        name: desired.name,
        credentials: desired.credentials,
      });
    }
    if (
      (desired.kind === "oauth_account" ||
        desired.kind === "browser_session") &&
      result.status !== "active"
    ) {
      pendingAuth.push({
        slug: desired.slug,
        kind: desired.kind,
        ...(result.connectUrl ? { connectUrl: result.connectUrl } : {}),
      });
    }
    printText(renderProgress(row.verb, "auth-profile", row.id));
  }
  // Interactive-auth profiles that were unchanged but still pending — re-issue
  // a connect token so the operator gets a fresh URL.
  for (const row of ctx.plan.rows) {
    if (row.kind !== "auth-profile" || row.verb !== "noop") continue;
    if (!row.needsAuth || !row.desired) continue;
    if (pendingAuth.some((p) => p.slug === row.desired?.slug)) continue;
    let connectUrl: string | undefined;
    if (row.desired.kind === "oauth_account") {
      connectUrl = await ctx.client
        .reconnectAuthProfile(row.desired.slug)
        .catch(() => undefined);
    }
    pendingAuth.push({
      slug: row.desired.slug,
      kind: row.desired.kind,
      ...(connectUrl ? { connectUrl } : {}),
    });
  }

  // 9) Connections, keyed by slug. Track resolved connection IDs (existing or
  //    just-created) so feed sync can address them afterwards.
  const remoteConnBySlug = new Map(
    ctx.remote.connections.map((c) => [c.slug, c])
  );
  const connectionIdBySlug = new Map<string, number>(
    ctx.remote.connections.map((c) => [c.slug, c.id])
  );
  for (const row of rowsByKind("connection")) {
    if (row.kind !== "connection") continue;
    const desired = ctx.state.connectors.connections.find(
      (c) => c.slug === row.id
    );
    if (!desired) continue;
    const existing = remoteConnBySlug.get(desired.slug);
    if (existing && row.verb === "update") {
      const updated = await ctx.client.updateConnection(existing.id, {
        name: desired.name,
        authProfileSlug: desired.authProfileSlug ?? null,
        appAuthProfileSlug: desired.appAuthProfileSlug ?? null,
        config: desired.config ?? {},
      });
      connectionIdBySlug.set(desired.slug, updated.id);
    } else {
      const created = await ctx.client.createConnection({
        slug: desired.slug,
        connector: desired.connector,
        name: desired.name,
        authProfileSlug: desired.authProfileSlug,
        appAuthProfileSlug: desired.appAuthProfileSlug,
        config: desired.config,
      });
      connectionIdBySlug.set(desired.slug, created.id);
    }
    printText(renderProgress(row.verb, "connection", row.id));
  }

  // 10) Feeds (per connection — covers feeds whose connection itself was a noop)
  for (const row of rowsByKind("feed")) {
    if (row.kind !== "feed") continue;
    if (!row.desired) continue;
    const feed = row.desired;
    const connectionId = connectionIdBySlug.get(row.connectionSlug);
    if (connectionId === undefined) {
      throw new ApiError(
        `feed "${feed.feedKey}" references connection "${row.connectionSlug}" which has no remote ID — connection create may have failed`
      );
    }
    const existingConn = remoteConnBySlug.get(row.connectionSlug);
    const remoteFeed = existingConn
      ? (ctx.remote.feedsByConnectionId.get(existingConn.id) ?? []).find(
          (f) => f.feed_key === feed.feedKey
        )
      : undefined;
    if (remoteFeed && row.verb === "update") {
      await ctx.client.updateFeed(remoteFeed.id, {
        name: feed.name,
        schedule: feed.schedule,
        config: feed.config ?? {},
      });
    } else {
      await ctx.client.createFeed({
        connectionId,
        feedKey: feed.feedKey,
        name: feed.name,
        schedule: feed.schedule,
        config: feed.config,
      });
    }
    printText(renderProgress(row.verb, "feed", row.id));
  }

  return { pendingAuth };
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
    fetchImpl: opts.fetchImpl,
  });
  printText(chalk.dim(`Org: ${orgSlug}`));

  // Refuse if .lobu/project.json points at a different (context, org).
  const link = await loadProjectLink(cwd);
  if (link && !opts.force) {
    const activeContext = await resolveContext().catch(() => null);
    const contextMismatch =
      activeContext !== null && activeContext.name !== link.context;
    const orgMismatch = orgSlug !== link.org;
    if (contextMismatch || orgMismatch) {
      const detail: string[] = [];
      if (contextMismatch) {
        detail.push(
          `  context: linked=${link.context}, active=${activeContext.name}`
        );
      }
      if (orgMismatch) {
        detail.push(`  org:     linked=${link.org}, applying=${orgSlug}`);
      }
      printError(
        [
          "",
          "Project link mismatch — refusing to apply.",
          ...detail,
          "",
          "Run `lobu link --org <slug>` to update the link, or pass `--force` to override.",
        ].join("\n")
      );
      throw new ValidationError("project-link mismatch");
    }
  }

  const remote = await fetchRemoteSnapshot(client, state, opts.only);
  // Validate connector configs against the connector definitions the server
  // knows about — fails loud before any mutation.
  validateConnectorState(state, remote);
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
    const { pendingAuth } = await executePlan({ client, state, plan, remote });
    printText(chalk.green("\nApply complete."));
    const punchList = renderPostApplyPunchList({
      pendingAuth,
      notes: plan.notes,
    });
    if (punchList) printText(punchList);
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
