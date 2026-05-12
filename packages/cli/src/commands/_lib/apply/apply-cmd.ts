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
  type DesiredConnectorDefinition,
  type DesiredState,
  loadDesiredState,
  resolveConnectorSchemas,
  validateAuthProfileAgainstConnector,
  validateConnectionAgainstConnector,
} from "./desired-state.js";
import { confirmCustomConnectors, confirmPlan } from "./prompt.js";
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

interface PendingAuthEntry {
  slug: string;
  kind: string;
  connectUrl?: string;
}

// ── Required-secrets check ─────────────────────────────────────────────────

function checkRequiredSecrets(state: DesiredState): { missing: string[] } {
  const missing = state.requiredSecrets.filter(
    (name) => process.env[name] === undefined || process.env[name] === ""
  );
  return { missing };
}

// ── source_url: confirmed-before-fetch, https-only, bounded fetch ──────────

const CONNECTOR_SOURCE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const CONNECTOR_SOURCE_FETCH_TIMEOUT_MS = 15_000;

async function materializeConnectorSource(
  defs: DesiredConnectorDefinition[],
  fetchImpl: typeof fetch
): Promise<void> {
  for (const def of defs) {
    if (def.sourceCode !== undefined || !def.sourceUrl) continue;
    let url: URL;
    try {
      url = new URL(def.sourceUrl);
    } catch {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url is not a valid URL: ${def.sourceUrl}`
      );
    }
    if (url.protocol !== "https:") {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url must use https (got ${url.protocol}//): ${def.sourceUrl}`
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      CONNECTOR_SOURCE_FETCH_TIMEOUT_MS
    );
    let res: Response;
    try {
      res = await fetchImpl(def.sourceUrl, { signal: controller.signal });
    } catch (err) {
      throw new ValidationError(
        `${def.sourceFile}: failed to fetch connector source_url ${def.sourceUrl} — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url ${def.sourceUrl} returned HTTP ${res.status} ${res.statusText}`
      );
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (
      contentType &&
      !/(text\/|application\/(typescript|javascript|x-typescript|octet-stream))/.test(
        contentType
      )
    ) {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url ${def.sourceUrl} returned unexpected content-type "${contentType}" — expected text/*, application/typescript, or application/javascript`
      );
    }
    const body = await res.text();
    if (body.length > CONNECTOR_SOURCE_MAX_BYTES) {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url ${def.sourceUrl} body is ${body.length} bytes — exceeds the ${CONNECTOR_SOURCE_MAX_BYTES}-byte cap`
      );
    }
    if (!body.trim()) {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url ${def.sourceUrl} returned an empty body`
      );
    }
    def.sourceCode = body;
  }
}

/**
 * Warn + require confirmation BEFORE the CLI fetches any `source_url` or
 * uploads any custom connector source for compilation on the gateway.
 *
 * SECURITY: `install_connector` compiles + imports + instantiates the connector
 * runtime class on the gateway. The server-side compiler currently runs with
 * full gateway env/fs/network and only blocks relative imports — this consent
 * gate is the operator's last line of defence. (TODO(security): sandbox the
 * server-side connector compiler — tracked separately, out of scope here.)
 */
async function confirmCustomConnectorSource(
  defs: DesiredConnectorDefinition[],
  yes: boolean
): Promise<void> {
  if (defs.length === 0) return;
  printText(
    chalk.yellow(
      `\n  ⚠ This project ships ${defs.length} custom connector source ${defs.length === 1 ? "definition" : "definitions"}:`
    )
  );
  for (const def of defs) {
    printText(
      chalk.yellow(
        def.sourceUrl
          ? `    - ${def.sourceFile} → fetches ${def.sourceUrl}`
          : `    - ${def.sourceFile}`
      )
    );
  }
  printText(
    chalk.yellow(
      "  `lobu apply` will fetch (https) and UPLOAD this source; the gateway will COMPILE and EXECUTE it.\n  Only proceed if you trust this code."
    )
  );
  const ok = await confirmCustomConnectors(yes);
  if (!ok) {
    throw new ValidationError("Cancelled — custom connectors not confirmed.");
  }
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

// ── Connector definition install (runs INSIDE executePlan, after confirm) ──

/**
 * Install/update the project's custom connector definitions, then any *bundled*
 * connectors referenced by an auth-profile / connection (the server only
 * resolves *installed* defs in `create_auth_profile` / `create_feed`, not the
 * catalog). Returns the fresh connector-definition catalog.
 */
async function installConnectorDefinitions(
  client: ApplyClient,
  state: DesiredState,
  catalog: RemoteConnectorDefinition[],
  plan: DiffPlan
): Promise<RemoteConnectorDefinition[]> {
  const installedKeys = new Set(
    catalog.filter((d) => d.installed).map((d) => d.key)
  );
  let mutated = false;

  // Iterate the plan's connector-definition rows so progress mirrors the plan.
  for (const row of plan.rows) {
    if (row.kind !== "connector-definition") continue;
    if (row.verb === "noop" || row.verb === "drift") continue;
    const def = row.desired;
    if (!def) continue;
    const result =
      def.sourceCode !== undefined
        ? await client.installConnector({ sourceCode: def.sourceCode })
        : await client.installConnector({ sourceUrl: def.sourceUrl });
    mutated = true;
    printText(
      renderProgress(
        row.verb,
        "connector-definition",
        result.connectorKey || def.key || def.sourceFile,
        result.updated ? "(installed)" : "(unchanged)"
      )
    );
  }

  // Bundled connectors referenced by an auth-profile / connection.
  const catalogByKey = new Map(
    catalog.filter((d) => d.installable && d.source_uri).map((d) => [d.key, d])
  );
  const referenced = new Set<string>([
    ...state.connectors.authProfiles.map((p) => p.connector),
    ...state.connectors.connections.map((c) => c.connector),
  ]);
  for (const key of [...referenced].sort()) {
    if (installedKeys.has(key)) continue;
    const entry = catalogByKey.get(key);
    if (!entry?.source_uri) continue; // custom local-only — handled above
    const result = await client.installConnector({
      sourceUri: entry.source_uri,
    });
    mutated = true;
    printText(
      renderProgress(
        "create",
        "connector-definition",
        result.connectorKey || key,
        result.updated ? "(installed bundled)" : "(bundled — unchanged)"
      )
    );
  }

  return mutated ? await client.listConnectorDefinitions(true) : catalog;
}

// ── Connector config validation (against a given catalog) ──────────────────

function validateConnectorState(
  state: DesiredState,
  connectorDefinitions: RemoteConnectorDefinition[]
): void {
  const defByKey = new Map<string, RemoteConnectorDefinition>(
    connectorDefinitions.map((d) => [d.key, d])
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

async function executePlan(
  ctx: ApplyContext,
  pendingAuth: PendingAuthEntry[]
): Promise<void> {
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

  // 7) Connector definitions (install — happens AFTER the plan was confirmed),
  //    then refetch the catalog and validate connection/feed config against the
  //    now-current schemas (so an updated custom connector's new schema is what
  //    the connection config is checked against).
  const hasConnectorWork =
    ctx.state.connectors.definitions.length > 0 ||
    ctx.state.connectors.authProfiles.length > 0 ||
    ctx.state.connectors.connections.length > 0;
  if (hasConnectorWork) {
    const freshCatalog = await installConnectorDefinitions(
      ctx.client,
      ctx.state,
      ctx.remote.connectorDefinitions,
      ctx.plan
    );
    validateConnectorState(ctx.state, freshCatalog);
  }

  // 8) Auth profiles (create / update; interactive kinds → punch-list)
  for (const row of rowsByKind("auth-profile")) {
    if (row.kind !== "auth-profile") continue;
    const desired = ctx.state.connectors.authProfiles.find(
      (p) => p.slug === row.id
    );
    if (!desired) continue;
    const result =
      row.verb === "create"
        ? await ctx.client.createAuthProfile({
            slug: desired.slug,
            connector: desired.connector,
            kind: desired.kind,
            name: desired.name,
            credentials: desired.credentials,
          })
        : await ctx.client.updateAuthProfile({
            slug: desired.slug,
            name: desired.name,
            credentials: desired.credentials,
          });
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

  // 9) Connections, keyed by slug.
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
}

// Collect pending interactive-auth profiles from a (no-op) plan and re-issue a
// fresh connect URL — used both when "nothing to apply" and on partial failure.
async function collectPendingAuthFromPlan(
  client: ApplyClient,
  plan: DiffPlan,
  already: PendingAuthEntry[]
): Promise<PendingAuthEntry[]> {
  const out = [...already];
  for (const row of plan.rows) {
    if (row.kind !== "auth-profile" || !("needsAuth" in row) || !row.needsAuth)
      continue;
    if (!row.desired) continue;
    if (out.some((p) => p.slug === row.desired?.slug)) continue;
    let connectUrl: string | undefined;
    if (row.desired.kind === "oauth_account") {
      connectUrl = await client
        .reconnectAuthProfile(row.desired.slug)
        .catch(() => undefined);
    }
    out.push({
      slug: row.desired.slug,
      kind: row.desired.kind,
      ...(connectUrl ? { connectUrl } : {}),
    });
  }
  return out;
}

// ── Top-level command ──────────────────────────────────────────────────────

export async function applyCommand(opts: ApplyOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { state, configPath } = await loadDesiredState({
    cwd,
    ...(opts.only ? { only: opts.only } : {}),
  });

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

  // SECURITY (#4): confirm BEFORE fetching any `source_url` or uploading custom
  // connector source — `lobu apply --dry-run` should never hit a manifest URL.
  if (!opts.dryRun) {
    await confirmCustomConnectorSource(
      state.connectors.definitions,
      opts.yes ?? false
    );
    await materializeConnectorSource(state.connectors.definitions, fetchImpl);
  }

  // Snapshot remote state. Connector-def rows in the plan are computed against
  // this (current/stale) catalog — "create" when the key isn't installed,
  // "update" when it is. Connector defs are NOT installed here; that happens in
  // `executePlan`, AFTER plan confirmation.
  const remote = await fetchRemoteSnapshot(client, state, opts.only);

  // Validate connection/auth-profile config against the catalog we have now.
  // Connectors that only exist locally (not yet installed) are skipped — the
  // server validates those on install / create_feed, and `executePlan`
  // re-validates against the fresh post-install catalog.
  validateConnectorState(state, remote.connectorDefinitions);

  const plan = computeDiff(state, remote, { only: opts.only });
  printText(renderPlan(plan));

  if (opts.dryRun) {
    printText(
      chalk.dim(
        "\nDry run — no changes applied. (Connector-definition install + post-install schema validation are skipped in dry-run.)"
      )
    );
    return;
  }

  const hasPendingAuth = plan.rows.some(
    (r) => r.kind === "auth-profile" && "needsAuth" in r && r.needsAuth
  );

  if (plan.counts.create === 0 && plan.counts.update === 0 && !hasPendingAuth) {
    printText(chalk.green("\nNothing to apply."));
    return;
  }

  const { create, update, noop, drift } = plan.counts;
  const summaryLine = `${create} create, ${update} update, ${noop} noop, ${drift} drift${hasPendingAuth ? " + pending auth" : ""}`;
  const approved = await confirmPlan({
    yes: opts.yes ?? false,
    summaryLine,
  });
  if (!approved) {
    printText(chalk.dim("\nCancelled."));
    return;
  }

  const pendingAuth: PendingAuthEntry[] = [];
  let applyErr: unknown;
  if (plan.counts.create > 0 || plan.counts.update > 0) {
    printText(chalk.bold("\nApplying:"));
    try {
      await executePlan({ client, state, plan, remote }, pendingAuth);
      printText(chalk.green("\nApply complete."));
    } catch (err) {
      applyErr = err;
      printError(`\n${err instanceof Error ? err.message : String(err)}`);
      printError(
        "Apply halted on first failure. Re-run `lobu apply` once the underlying issue is resolved — every endpoint is idempotent."
      );
    }
  }

  // Always render the punch-list — even on partial failure, so the operator
  // keeps the connect URLs and the informational notes.
  const finalPending = await collectPendingAuthFromPlan(
    client,
    plan,
    pendingAuth
  );
  const punchList = renderPostApplyPunchList({
    pendingAuth: finalPending,
    notes: plan.notes,
  });
  if (punchList) printText(punchList);

  if (applyErr) throw applyErr;
}
