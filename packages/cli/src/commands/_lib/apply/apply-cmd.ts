import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { resolveContext } from "../../../internal/context.js";
import { parseEnvContent } from "../../../internal/env-file.js";
import { printError, printText } from "../../../internal/output.js";
import { loadProjectLink } from "../../../internal/project-link.js";
import { ApiError, ValidationError } from "../../memory/_lib/errors.js";
import {
  type ApplyClient,
  type RemoteAgent,
  type RemoteConnectorDefinition,
  type RemoteFeed,
  type RemotePlatform,
  resolveApplyClient,
} from "./client.js";
import {
  type DesiredConnectorDefinition,
  type DesiredState,
  loadDesiredStateFromConfig,
  normalizeConnectionConfigScope,
  resolveConnectorSchemas,
  validateAuthProfileAgainstConnector,
  validateConnectionAgainstConnector,
} from "./desired-state.js";
import {
  computeDiff,
  type DiffPlan,
  type DiffRow,
  type RemoteSnapshot,
} from "./diff.js";
import {
  confirmCustomConnectors,
  confirmDeletions,
  confirmPlan,
} from "./prompt.js";
import {
  renderMissingSecrets,
  renderPlan,
  renderPostApplyPunchList,
  renderProgress,
} from "./render.js";
import { declaredConnectorKeys, referencedConnectorKeys } from "./shared.js";

interface ApplyOptions {
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

/** Deletes beyond this in one pruning apply trigger a second confirm. */
const BLAST_RADIUS_DELETE_THRESHOLD = 3;

// ── Required-secrets check ─────────────────────────────────────────────────

function checkRequiredSecrets(state: DesiredState): { missing: string[] } {
  const missing = state.requiredSecrets.filter(
    (name) => process.env[name] === undefined || process.env[name] === ""
  );
  return { missing };
}

/**
 * Merge `.env` values from the project dir into `process.env` (without
 * overriding values already set in the shell). Quietly noop if the file
 * doesn't exist or can't be parsed — `checkRequiredSecrets` will surface a
 * clear "Missing required secret" error downstream.
 */
async function loadProjectEnvFile(cwd: string): Promise<void> {
  const envPath = join(cwd, ".env");
  let raw: string;
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    return;
  }
  const vars = parseEnvContent(raw);
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ── source_url: confirmed-before-fetch, https-only, bounded fetch ──────────

const CONNECTOR_SOURCE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const CONNECTOR_SOURCE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Read a response body as a stream, counting *bytes* and aborting as soon as
 * the running total exceeds `maxBytes` — before buffering the rest. Decodes to
 * UTF-8 text only after the (bounded) body is in hand. Exported for testing.
 */
export async function readBoundedBody(
  res: Response,
  maxBytes: number,
  onOverflow: () => never
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (rare; e.g. a mock). Fall back to text() + a byte check.
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) onOverflow();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          onOverflow();
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // already released by cancel() — ignore
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

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
    // Single timer covering the whole exchange — connect AND body consumption.
    const timer = setTimeout(
      () => controller.abort(),
      CONNECTOR_SOURCE_FETCH_TIMEOUT_MS
    );
    let body: string;
    try {
      let res: Response;
      try {
        res = await fetchImpl(def.sourceUrl, { signal: controller.signal });
      } catch (err) {
        throw new ValidationError(
          `${def.sourceFile}: failed to fetch connector source_url ${def.sourceUrl} — ${err instanceof Error ? err.message : String(err)}`
        );
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
      try {
        body = await readBoundedBody(res, CONNECTOR_SOURCE_MAX_BYTES, () => {
          throw new ValidationError(
            `${def.sourceFile}: connector source_url ${def.sourceUrl} body exceeds the ${CONNECTOR_SOURCE_MAX_BYTES}-byte cap`
          );
        });
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError(
          `${def.sourceFile}: failed to read connector source_url ${def.sourceUrl} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      clearTimeout(timer);
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

/** True when the config declares any connector definition / auth profile / connection. */
function hasDesiredConnectors(state: DesiredState): boolean {
  return (
    state.connectors.definitions.length > 0 ||
    state.connectors.authProfiles.length > 0 ||
    state.connectors.connections.length > 0
  );
}

async function fetchRemoteSnapshot(
  client: ApplyClient,
  state: DesiredState,
  only?: "agents" | "memory",
  prune = false
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
  // View templates are fetched per-type, NOT streamed in the entity-type list
  // (the UI/bootstrap calls that endpoint). Fetch only for types the config
  // declares a template for — plus, under prune, every config type so an omitted
  // template can be detected as a removal. Bounded to config-present types.
  if (entityTypes.length > 0) {
    const desiredBySlug = new Map(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    for (const remote of entityTypes) {
      const desired = desiredBySlug.get(remote.slug);
      if (!desired) continue;
      if (desired.viewTemplate === undefined && !prune) continue;
      const tpl = await client.getEntityTypeViewTemplate(remote.slug);
      if (tpl) remote.viewTemplate = tpl;
    }
  }
  const relationshipTypes =
    only === "agents" ? [] : await client.listRelationshipTypes();
  // The relationship-type `list` action omits rules, so the diff would compare
  // desired rules against an always-empty remote and churn a perpetual "rules
  // changed" update. Hydrate rules for every type the config also declares —
  // including those the config declares with NO rules, so dropping all rules is
  // detected as a change (and reconciled away) rather than a silent noop.
  if (relationshipTypes.length > 0) {
    const desiredRelSlugs = new Set(
      state.memorySchema.relationshipTypes.map((r) => r.slug)
    );
    for (const remote of relationshipTypes) {
      if (!desiredRelSlugs.has(remote.slug)) continue;
      const rules = await client.listRelationshipTypeRules(remote.slug);
      remote.rules = rules.map((r) => ({ source: r.source, target: r.target }));
    }
  }
  const watchers = only === "agents" ? [] : await client.listWatchers();

  // Connectors run only on a full apply (`--only` skips them). A pruning config
  // also fetches them even when it declares none, so prune can delete a
  // connector definition whose last config reference was removed (otherwise an
  // empty desired-connectors set would skip the fetch entirely).
  const hasConnectors = hasDesiredConnectors(state);
  const fetchConnectors = !only && (hasConnectors || prune);
  const connectorDefinitions = fetchConnectors
    ? await client.listConnectors(true)
    : [];
  const authProfiles = fetchConnectors ? await client.listAuthProfiles() : [];
  const connections = fetchConnectors ? await client.listConnections() : [];
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

  // Org-owned inference providers are org-scoped (neither agents nor memory), so
  // only a full apply reconciles them. The list drives create/update/drift.
  const inferenceProviders =
    only === undefined ? await client.listInferenceProviders() : [];

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
    inferenceProviders,
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
  // Connector keys this project supplies its own source for — these must NEVER
  // be replaced by a bundled `source_uri` install, even if a bundled connector
  // shares the key. (`null` keys — auto-discovered `*.connector.ts` whose key
  // the server resolves at compile time — are added to this set below as soon
  // as `install_connector` returns the resolved key, so the bundled loop can't
  // race them either.)
  const locallySuppliedKeys = locallyDeclaredConnectorKeys(state);
  let mutated = false;

  // Iterate the plan's connector-definition rows so progress mirrors the plan.
  for (const row of plan.rows) {
    if (row.kind !== "connector-definition") continue;
    if (row.verb === "noop" || row.verb === "drift") continue;
    const def = row.desired;
    if (!def) continue;
    let result: Awaited<ReturnType<typeof client.installConnector>>;
    if (def.sourcePath) {
      // Local `*.connector.ts`: compile on the CLI, where the project's
      // node_modules is available, so esbuild can bundle the connector's
      // declared npm deps (the server only receives the artifact). Native deps
      // ride `runtime.nix.packages` and are provisioned at run time. Compile
      // `sourcePath` (the actual `.ts`), not `sourceFile` (an error-message
      // label that may point at a `type: connector` YAML doc).
      //
      // Lazy-imported (cached by the loader) so the heavy connector-compile
      // graph (esbuild + connector-worker + SDK) stays out of apply-cmd's
      // module-load path — see the dynamic-import allow-list in AGENTS.md.
      const { ensureProjectDepsInstalled } = await import(
        "../ensure-deps-installed.js"
      );
      const { compileConnectorFromFile } = await import(
        "../connector-loader.js"
      );
      ensureProjectDepsInstalled(def.sourcePath, printText);
      const compiledCode = await compileConnectorFromFile(def.sourcePath);
      result = await client.installConnector({
        sourceCode: compiledCode,
        compiled: true,
      });
    } else if (def.sourceCode !== undefined) {
      // `source_url` connector: source was fetched into `sourceCode` and has no
      // local project/node_modules to bundle against — upload it raw and let
      // the gateway compile it (the pre-existing path).
      result = await client.installConnector({ sourceCode: def.sourceCode });
    } else {
      result = await client.installConnector({ sourceUrl: def.sourceUrl });
    }
    if (result.connectorKey) {
      locallySuppliedKeys.add(result.connectorKey);
      installedKeys.add(result.connectorKey);
    }
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

  // Bundled connectors referenced by an auth-profile / connection — installed
  // ONLY if the org doesn't already have that key (installed in a prior apply
  // or just installed from local source above). A locally-supplied key is never
  // overwritten by the bundled `source_uri`.
  const catalogByKey = new Map(
    catalog.filter((d) => d.installable && d.source_uri).map((d) => [d.key, d])
  );
  const referenced = referencedConnectorKeys(state.connectors);
  for (const key of [...referenced].sort()) {
    if (installedKeys.has(key) || locallySuppliedKeys.has(key)) continue;
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

  return mutated ? await client.listConnectors(true) : catalog;
}

// ── Connector config validation (against a given catalog) ──────────────────

/**
 * Validate connection / auth-profile config against the connector definitions
 * the server knows about. When `skipSchemaForConnectorKeys` is given, those
 * connector keys (the locally-declared `*.connector.ts` / `type: connector`
 * ones) get only the structural checks here — full JSON-schema validation runs
 * later, after install + catalog refetch, against the *fresh* schemas. This
 * avoids rejecting a connection's config against a stale installed schema when
 * the same apply updates that connector.
 */
interface ValidateConnectorStateOptions {
  /**
   * Connector keys whose JSON-schema validation should be skipped in this pass
   * (the locally-declared ones in the *pre*-install pass — they're schema-
   * validated post-install against the fresh catalog).
   */
  skipSchemaForConnectorKeys?: ReadonlySet<string>;
  /**
   * When true (the *post*-install pass), every connector key referenced by a
   * desired auth profile or connection must be present in the catalog with
   * `installed === true` — otherwise a hard `ValidationError` before any
   * `executePlan` mutation. Catches a typo'd `connector:` ref, or a local
   * `*.connector.ts` whose compiled `definition.key` differs from what the
   * manifest assumed (so it never got installed under the expected key).
   */
  requireInstalled?: boolean;
}

export function validateConnectorState(
  state: DesiredState,
  connectorDefinitions: RemoteConnectorDefinition[],
  opts: ValidateConnectorStateOptions = {}
): string[] {
  const defByKey = new Map<string, RemoteConnectorDefinition>(
    connectorDefinitions.map((d) => [d.key, d])
  );
  const authProfilesBySlug = new Map(
    state.connectors.authProfiles.map((p) => [p.slug, p])
  );

  if (opts.requireInstalled) {
    const refs: Array<{ connector: string; ref: string }> = [
      ...state.connectors.authProfiles.map((p) => ({
        connector: p.connector,
        ref: `auth profile "${p.slug}"`,
      })),
      ...state.connectors.connections.map((c) => ({
        connector: c.connector,
        ref: `connection "${c.slug}"`,
      })),
    ];
    for (const { connector, ref } of refs) {
      const def = defByKey.get(connector);
      if (!def || def.installed !== true) {
        throw new ValidationError(
          `connector "${connector}" referenced by ${ref} is not installed in the org — check the \`connector\` key (and, for a local \`*.connector.ts\`, that its \`definition.key\` matches)`
        );
      }
    }
  }

  const schemasFor = (connectorKey: string) => {
    if (opts.skipSchemaForConnectorKeys?.has(connectorKey)) return null;
    const def = defByKey.get(connectorKey);
    return def ? resolveConnectorSchemas(def) : null;
  };
  for (const profile of state.connectors.authProfiles) {
    validateAuthProfileAgainstConnector(profile, schemasFor(profile.connector));
  }
  const warnings: string[] = [];
  for (const connection of state.connectors.connections) {
    const schemas = schemasFor(connection.connector);
    // Mirror the server's connection/feed scope split: demote any feed-scoped
    // key authored on the connection to a per-feed default so the server
    // accepts the connection, instead of failing the create with a generic
    // "Feed-scoped config belongs on feeds" rejection.
    //
    // Only in the pre-diff pass. The post-install pass (requireInstalled) runs
    // AFTER computeDiff has built the create/update rows from `row.desired`, so
    // mutating state here would not reach the plan — it would silently drop the
    // demoted key from the applied feed rows. Locally-declared connectors
    // (schema-skipped pre-diff, validated only post-install) therefore aren't
    // demoted; a feed-scoped key left on such a connection still fails loudly
    // at the server, exactly as before this feature.
    if (!opts.requireInstalled) {
      const demoted = normalizeConnectionConfigScope(connection, schemas);
      if (demoted.length > 0) {
        warnings.push(
          `connection "${connection.slug}": feed-scoped key(s) [${demoted.join(", ")}] were set on the connection — moved to its feed config(s). Declare connector sync settings on the feed, not the connection.`
        );
      }
    }
    validateConnectionAgainstConnector(connection, authProfilesBySlug, schemas);
  }
  return warnings;
}

// Connector keys declared locally (`*.connector.ts` / `type: connector`).
// We don't know the key for an auto-discovered `*.connector.ts` until the
// server compiles it — those have `key === null` — so they can't be in the
// skip set; their connections are validated only after install (when the key
// is known and the def is in the refreshed catalog).
export function locallyDeclaredConnectorKeys(state: DesiredState): Set<string> {
  return declaredConnectorKeys(state.connectors.definitions);
}

// ── Apply executor ─────────────────────────────────────────────────────────

interface ApplyContext {
  client: ApplyClient;
  state: DesiredState;
  plan: DiffPlan;
  remote: RemoteSnapshot;
}

/**
 * Push provider API keys as org-shared `agent_secrets` rows so the worker can
 * inject them at runtime without a per-user auth profile. Idempotent (PUT):
 * same value → 200, different value → rotation. Walks all desired agents (not
 * just those with a settings diff) — the secret value isn't part of the
 * settings JSON, so a row can need a key even when every resource is noop (e.g.
 * first apply after the gateway picked up support, or a key-only `.env`
 * change/rotation). Callers invoke this AFTER executePlan (so a just-created
 * agent exists before its `/agents/<id>/providers/...` key push), and also in
 * the all-noop / key-only branch (no agent creates there). Kept outside
 * `executePlan` so both paths can call it without double-pushing.
 */
export async function pushProviderApiKeys(
  client: ApplyClient,
  agents: DesiredState["agents"]
): Promise<void> {
  for (const desired of agents) {
    for (const { providerId, value } of desired.providerKeys) {
      await client.setProviderApiKey(
        desired.metadata.agentId,
        providerId,
        value
      );
      printText(
        chalk.dim(`  ↻ provider-key ${desired.metadata.agentId}/${providerId}`)
      );
    }
  }
}

export async function executePlan(
  ctx: ApplyContext,
  pendingAuth: PendingAuthEntry[]
): Promise<void> {
  const rowsByKind = (kind: DiffRow["kind"]) =>
    ctx.plan.rows.filter(
      (row) => row.kind === kind && row.verb !== "noop" && row.verb !== "drift"
    );

  // 0) Connector definitions FIRST — install/update them (the plan was already
  //    confirmed), refetch the catalog, then re-validate connection/feed config
  //    against the now-current schemas. Doing this before any other resource
  //    means a post-install schema rejection halts apply before mutating
  //    anything unrelated.
  if (hasDesiredConnectors(ctx.state)) {
    const freshCatalog = await installConnectorDefinitions(
      ctx.client,
      ctx.state,
      ctx.remote.connectorDefinitions,
      ctx.plan
    );
    for (const warning of validateConnectorState(ctx.state, freshCatalog, {
      requireInstalled: true,
    })) {
      printText(chalk.yellow(`Warning: ${warning}`));
    }
  }

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

  // 3) Platforms — upsert only the platforms the diff flagged (create / config
  // change / key removal). The diff treats an opaque remote secret (`***` /
  // `secret://`) as unchanged while the key is still declared (see
  // platformConfigChanged), so a stable config is a true noop and the live
  // worker is NOT restarted on every apply. The flip side — rotating a secret
  // VALUE in place can't be detected from the opaque round-trip and so isn't
  // auto-pushed here; that needs a secret-aware compare on the server's upsert
  // (owletto) and is tracked as a follow-up. A REMOVED key IS detected (it's
  // absent from desired) and applied.
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

  // 3b) Declarative channel bindings — reconcile after the platform upserts
  // above so the connection rows exist. Runs for every agent/platform that
  // declares `channels` (the server reconcile is idempotent), independent of
  // whether the platform's config changed in this plan.
  for (const agent of ctx.state.agents) {
    for (const platform of agent.platforms) {
      if (!platform.channels || platform.channels.length === 0) continue;
      const res = await ctx.client.syncPlatformChannels(
        agent.metadata.agentId,
        platform.stableId,
        platform.channels
      );
      const detail =
        res.removed.length > 0
          ? `(${res.bound.length} bound, ${res.removed.length} unbound)`
          : `(${res.bound.length} bound)`;
      printText(
        `  ${chalk.cyan("↻")} ${chalk.bold("channels")} ${agent.metadata.agentId}/${platform.stableId} ${chalk.dim(detail)}`
      );
    }
  }

  // 4) Entity types
  for (const row of rowsByKind("entity-type")) {
    if (row.kind !== "entity-type") continue;
    if (!row.desired) continue;
    await ctx.client.upsertEntityType(row.desired);
    // View template is a separate, version-appending tool. Reconcile it only on
    // create (when declared) or a flagged change — never every run, so the
    // version history doesn't churn. Declared ⇒ set; omitted-under-prune ⇒ clear.
    const tpl = row.desired.viewTemplate;
    const templateChanged =
      row.verb === "create"
        ? tpl !== undefined
        : (row.changedFields?.includes("viewTemplate") ?? false);
    if (templateChanged) {
      if (tpl !== undefined) {
        await ctx.client.setEntityTypeViewTemplate(row.desired.slug, tpl);
      } else {
        await ctx.client.clearEntityTypeViewTemplate(row.desired.slug);
      }
    }
    printText(renderProgress(row.verb, "entity-type", row.id));
  }

  // 5) Relationship types
  for (const row of rowsByKind("relationship-type")) {
    if (row.kind !== "relationship-type") continue;
    if (!row.desired) continue;
    await ctx.client.upsertRelationshipType(row.desired);
    printText(renderProgress(row.verb, "relationship-type", row.id));
  }

  // 6) Watchers — create (full payload + reaction script) or update (scalar
  //    row fields via `update`, version-bound fields via `create_version`,
  //    reaction script via `set_reaction_script`). Drift detection lives in
  //    `diffWatcher`; this loop just routes to the right admin action.
  const remoteWatcherBySlug = new Map(
    ctx.remote.watchers.map((w) => [w.slug, w])
  );
  for (const row of rowsByKind("watcher")) {
    if (row.kind !== "watcher") continue;
    if (!row.desired) continue;
    const w = row.desired;
    let watcherId: string | undefined;
    if (row.verb === "create") {
      const created = await ctx.client.createWatcher({
        slug: w.slug,
        agentId: w.agent,
        name: w.name,
        description: w.description,
        prompt: w.prompt,
        schedule: w.schedule,
        sources: w.sources,
        reactions_guidance: w.reactionsGuidance,
        device_worker_id: w.deviceWorkerId,
        scheduler_client_id: w.schedulerClientId,
        notification_channel: w.notificationChannel,
        notification_priority: w.notificationPriority,
        min_cooldown_seconds: w.minCooldownSeconds,
        tags: w.tags,
        agent_kind: w.agentKind,
        keying_config: w.keyingConfig,
        classifiers: w.classifiers,
      });
      watcherId = created.watcher_id;
    } else if (row.verb === "update") {
      const remote = remoteWatcherBySlug.get(w.slug);
      watcherId = remote?.watcher_id;
      if (!watcherId) {
        throw new ApiError(
          `update watcher "${w.slug}" failed: remote row is missing watcher_id (refetch may be stale)`
        );
      }
      const versionBound = new Set(row.versionBoundFields ?? []);
      const changed = new Set(row.changedFields ?? []);
      const scalarChanges = [...changed].filter(
        (f) => !versionBound.has(f) && f !== "reaction_script"
      );
      // a) Scalar fields → manage_watchers update
      if (scalarChanges.length > 0) {
        await ctx.client.updateWatcher({
          watcher_id: watcherId,
          ...(scalarChanges.includes("schedule")
            ? { schedule: w.schedule ?? null }
            : {}),
          ...(scalarChanges.includes("agent_id") ? { agent_id: w.agent } : {}),
          ...(scalarChanges.includes("device_worker_id")
            ? { device_worker_id: w.deviceWorkerId ?? null }
            : {}),
          ...(scalarChanges.includes("scheduler_client_id")
            ? { scheduler_client_id: w.schedulerClientId ?? null }
            : {}),
          ...(scalarChanges.includes("notification_channel") &&
          w.notificationChannel
            ? { notification_channel: w.notificationChannel }
            : {}),
          ...(scalarChanges.includes("notification_priority") &&
          w.notificationPriority
            ? { notification_priority: w.notificationPriority }
            : {}),
          ...(scalarChanges.includes("min_cooldown_seconds") &&
          w.minCooldownSeconds !== undefined
            ? { min_cooldown_seconds: w.minCooldownSeconds }
            : {}),
          ...(scalarChanges.includes("tags") && w.tags ? { tags: w.tags } : {}),
          ...(scalarChanges.includes("agent_kind")
            ? { agent_kind: w.agentKind ?? null }
            : {}),
        });
      }
      // b) Version-bound fields → manage_watchers create_version (server
      //    inherits unset fields from the previous version row, but we always
      //    send the desired-side values for the changed keys).
      if (row.versionBoundFields && row.versionBoundFields.length > 0) {
        await ctx.client.createWatcherVersion({
          watcher_id: watcherId,
          ...(versionBound.has("prompt") ? { prompt: w.prompt } : {}),
          ...(versionBound.has("sources") && w.sources !== undefined
            ? { sources: w.sources }
            : {}),
          ...(versionBound.has("reactions_guidance") &&
          w.reactionsGuidance !== undefined
            ? { reactions_guidance: w.reactionsGuidance }
            : {}),
          ...(versionBound.has("keying_config") && w.keyingConfig !== undefined
            ? { keying_config: w.keyingConfig }
            : {}),
          ...(versionBound.has("classifiers") && w.classifiers !== undefined
            ? { classifiers: w.classifiers }
            : {}),
        });
      }
    }
    // c) Reaction script — push when declared (idempotent server-side, no
    //    drift signal available because it's not returned by list_watchers).
    if (w.reactionScript && watcherId) {
      await ctx.client.setReactionScript(
        watcherId,
        w.reactionScript.sourceCode
      );
    }
    printText(
      renderProgress(
        row.verb,
        "watcher",
        row.id,
        row.changedFields ? `(${row.changedFields.join(", ")})` : undefined
      )
    );
  }

  // Auth profiles (create / update; interactive kinds → punch-list)
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
        // Always pass — server treats undefined as "leave alone", null as
        // "unpin to server", and a uuid as "move to that device".
        deviceWorkerId: desired.deviceWorkerId ?? null,
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
        ...(desired.deviceWorkerId
          ? { deviceWorkerId: desired.deviceWorkerId }
          : {}),
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

  // 10b) Org-owned inference providers. Create the row if new, then reconcile
  //      each declared capability modality (idempotent PUT) and — because the
  //      API key is write-only and can't be diffed — re-push a declared key on
  //      every apply (a matching value is a server-side no-op). Drift rows
  //      (remote providers absent from the config) are never auto-deleted:
  //      dropping an org credential is destructive, so it's UI/API-only.
  for (const row of rowsByKind("inference-provider")) {
    if (row.kind !== "inference-provider") continue;
    if (row.verb === "drift") continue;
    const provider = row.desired;
    if (!provider) continue;

    if (row.verb === "create") {
      await ctx.client.createInferenceProvider({
        slug: provider.slug,
        kind: provider.kind,
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        apiKey: provider.apiKey,
        capabilities: provider.capabilities,
      });
      // Create already persisted the key + capabilities; nothing else to push.
      printText(renderProgress(row.verb, "inference-provider", row.id));
      continue;
    }

    // Update: push only the modalities that changed, then rotate the key.
    for (const modality of row.capabilityModalities ?? []) {
      await ctx.client.updateInferenceProviderCapabilities(
        provider.slug,
        modality,
        provider.capabilities[modality] ?? {}
      );
    }
    if (row.keyDeclared) {
      await ctx.client.rotateInferenceProviderKey(
        provider.slug,
        provider.apiKey
      );
    }
    printText(renderProgress(row.verb, "inference-provider", row.id));
  }

  // 11) Prune — delete definitions absent from a pruning config. Runs
  //     LAST and in reverse-dependency order so a rel-type that references an
  //     entity type is gone before the entity type. Connections + data
  //     instances are never in the delete set (computeDiff only emits delete
  //     rows for definitions). The server refuses an entity-type delete while
  //     instances exist, so the data stays safe.
  await deleteRemovedDefinitions(ctx);
}

/**
 * Execute the plan's `delete` rows (prune). Steps run in
 * reverse-dependency order — a rel-type rule references entity types, so
 * rel-types delete before entity types; connectors uninstall last. Halts apply
 * on first failure (idempotent re-run).
 */
async function deleteRemovedDefinitions(ctx: ApplyContext): Promise<void> {
  const deletes = ctx.plan.rows.filter((r) => r.verb === "delete");
  if (deletes.length === 0) return;
  const watcherIdBySlug = new Map(
    ctx.remote.watchers.map((w) => [w.slug, w.watcher_id])
  );
  const steps: Array<[DiffRow["kind"], (id: string) => Promise<void>]> = [
    [
      "watcher",
      async (id) => {
        const wid = watcherIdBySlug.get(id);
        if (!wid) {
          throw new ApiError(
            `delete watcher "${id}": remote watcher_id missing`
          );
        }
        await ctx.client.deleteWatcher(wid);
      },
    ],
    ["relationship-type", (id) => ctx.client.deleteRelationshipType(id)],
    ["entity-type", (id) => ctx.client.deleteEntityType(id)],
    ["connector-definition", (id) => ctx.client.uninstallConnector(id)],
  ];
  for (const [kind, run] of steps) {
    for (const row of deletes) {
      if (row.kind !== kind) continue;
      await run(row.id);
      printText(renderProgress("delete", kind, row.id));
    }
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
    const desired = row.desired;
    if (out.some((p) => p.slug === desired.slug)) continue;
    if (desired.kind === "oauth_account") {
      // A successful reconnect implies the profile exists remotely (and yields
      // a fresh connect URL). If it fails, the profile may not exist (a failed
      // create in a partial apply) — don't tell the operator to go finish auth
      // for something that isn't there; just skip it.
      const connectUrl = await client
        .reconnectAuthProfile(desired.slug)
        .catch(() => undefined);
      if (!connectUrl) continue;
      out.push({ slug: desired.slug, kind: desired.kind, connectUrl });
      continue;
    }
    // browser_session (no reconnect endpoint): include only if the profile row
    // actually exists remotely.
    const exists = await client
      .getAuthProfileBySlug(desired.slug)
      .catch(() => null);
    if (!exists) continue;
    out.push({ slug: desired.slug, kind: desired.kind });
  }
  return out;
}

// ── Top-level command ──────────────────────────────────────────────────────

/** "office-bot" → "Office Bot" — default display name for a bootstrapped org. */
function slugToTitle(slug: string): string {
  return (
    slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || slug
  );
}

export async function applyCommand(opts: ApplyOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Auto-load `.env` from the project dir so secret()/$VAR refs in
  // lobu.config.ts resolve without the user having to `set -a; source .env`.
  // Mirrors `lobu dev`. Existing process.env values win (don't clobber shell).
  await loadProjectEnvFile(cwd);

  // Load desired state from the TypeScript entrypoint (lobu.config.ts).
  const loadArgs = { cwd, ...(opts.only ? { only: opts.only } : {}) };
  const { state, configPath, warnings } =
    await loadDesiredStateFromConfig(loadArgs);

  printText(chalk.dim(`Config: ${configPath}`));
  for (const warning of warnings) {
    printText(chalk.yellow(`Warning: ${warning}`));
  }

  // Required secrets gate: fail before any network mutation.
  const { missing } = checkRequiredSecrets(state);
  if (missing.length > 0) {
    printError(renderMissingSecrets(missing));
    throw new ValidationError(
      `${missing.length} required secret${missing.length === 1 ? "" : "s"} missing — see above.`
    );
  }

  // Org slug resolution: explicit --org ▸ active-session org ▸ `org` from
  // defineConfig. The config slug is the declarative default — if no org with
  // that slug exists yet, `lobu apply` offers to provision it (below).
  const { client, orgSlug, apiBaseUrl } = await resolveApplyClient({
    url: opts.url,
    org: opts.org ?? state.memory?.org,
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

  // Check the resolved org exists / the operator is a member. `lobu apply`
  // can't create an org headlessly — that needs a logged-in browser session —
  // so a missing org stops here with a link to create it. `listOrgs()` failing
  // (old server, or a token the userinfo endpoint rejects) → null → skip the
  // check and let the normal flow surface any org error.
  const myOrgs = await client.listOrgs().catch(() => null);
  // Resolve strictly by the slug we will actually mutate (the client targets
  // `orgSlug` in every URL). Do NOT fall back to organizationId as an alternate
  // org — that could prune a different org than the one being applied.
  const resolvedOrg = myOrgs?.find((o) => o.slug === orgSlug);
  // If the config pins `organizationId`, the slug must resolve to that exact
  // org — otherwise it's a stale/copied config pointed at someone else's org,
  // and (with prune on) could prune the wrong org. Hard-stop.
  if (
    resolvedOrg &&
    state.memory?.organizationId &&
    resolvedOrg.id !== state.memory.organizationId
  ) {
    printError(
      [
        "",
        `Org slug "${orgSlug}" resolves to org id ${resolvedOrg.id}, but lobu.config.ts pins organizationId ${state.memory.organizationId}.`,
        "This usually means the config was copied from another project or the slug was reused.",
        "Fix `org`/`organizationId` in defineConfig (or pass the right --org) before applying.",
      ].join("\n")
    );
    throw new ValidationError(
      `org "${orgSlug}" (id ${resolvedOrg.id}) does not match pinned organizationId ${state.memory.organizationId}`
    );
  }
  if (myOrgs !== null && !resolvedOrg) {
    const orgName = state.memory?.name ?? slugToTitle(orgSlug);
    const createUrl = `${apiBaseUrl}/orgs/new?slug=${encodeURIComponent(orgSlug)}&name=${encodeURIComponent(orgName)}`;
    printError(
      [
        "",
        `Organization "${orgSlug}" not found, or you're not a member.`,
        "",
        `  Create it:  ${createUrl}`,
        `  (or:        \`lobu org create ${orgSlug}\`)`,
        "",
        "then re-run `lobu apply`. (Or target an existing org with `--org <slug>`.)",
      ].join("\n")
    );
    throw new ValidationError(`organization "${orgSlug}" not found`);
  }

  // Prune is config-declared (`defineConfig({ prune: true })`): when on, apply
  // deletes any org-owned definition (entity/relationship type, watcher,
  // connector definition) that's absent from the config — INCLUDING ones added
  // via the dashboard/API. Data, connections, auth profiles, and agents are
  // never pruned. The blast-radius confirm below is the safety net.
  const prune = state.prune;
  if (prune) {
    printText(
      chalk.yellow(
        "Prune is on: apply will DELETE any org-owned definition (entity/relationship type, watcher, connector) that is not in this config — including ones created in the UI."
      )
    );
  }

  // Team org consistency comes from `defineConfig({ org, organizationId })` in
  // lobu.config.ts (committed) plus the `.lobu/project.json` link — apply does
  // not rewrite the config file.

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
  const remote = await fetchRemoteSnapshot(client, state, opts.only, prune);

  // Validate connection/auth-profile config against the catalog we have now,
  // but SKIP schema validation for connector keys declared locally — those
  // might update an already-installed schema in this same apply, so they're
  // schema-validated later (post-install, against the fresh catalog) inside
  // `executePlan`. Structural checks (auth-slug existence, connector match)
  // still run here for every connection.
  for (const warning of validateConnectorState(
    state,
    remote.connectorDefinitions,
    {
      skipSchemaForConnectorKeys: locallyDeclaredConnectorKeys(state),
    }
  )) {
    printText(chalk.yellow(`Warning: ${warning}`));
  }

  const plan = computeDiff(state, remote, {
    only: opts.only,
    prune,
    ...(resolvedOrg?.id ? { orgId: resolvedOrg.id } : {}),
  });
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

  // Provider API keys live outside the resource diff (the secret value isn't
  // serialized into any plan row), so a key-only `.env` change produces an
  // all-noop plan. Detect declared keys so the apply isn't short-circuited and
  // the keys aren't silently dropped.
  const hasProviderKeys = state.agents.some((a) => a.providerKeys.length > 0);

  if (
    plan.counts.create === 0 &&
    plan.counts.update === 0 &&
    plan.counts.delete === 0 &&
    !hasPendingAuth
  ) {
    // Nothing in the resource diff — but a declared provider key still needs to
    // be pushed (idempotent PUT). This is the key-only `.env` change path.
    if (hasProviderKeys) {
      printText(chalk.bold("\nApplying provider keys:"));
      await pushProviderApiKeys(client, state.agents);
      printText(chalk.green("\nProvider keys applied; nothing else to apply."));
    } else {
      printText(chalk.green("\nNothing to apply."));
    }
    return;
  }

  const { create, update, noop, drift, delete: del } = plan.counts;
  const deletePart = del > 0 ? `, ${del} delete` : "";
  const summaryLine = `${create} create, ${update} update, ${noop} noop, ${drift} drift${deletePart}${hasPendingAuth ? " + pending auth" : ""}`;
  const approved = await confirmPlan({
    yes: opts.yes ?? false,
    summaryLine,
  });
  if (!approved) {
    printText(chalk.dim("\nCancelled."));
    return;
  }

  // Blast-radius gate: a large prune gets a second explicit confirm beyond the
  // plan approval above.
  if (del > BLAST_RADIUS_DELETE_THRESHOLD) {
    const okToDelete = await confirmDeletions(del, opts.yes ?? false);
    if (!okToDelete) {
      printText(chalk.dim("\nCancelled."));
      return;
    }
  }

  const hasResourceWork =
    plan.counts.create > 0 || plan.counts.update > 0 || plan.counts.delete > 0;

  const pendingAuth: PendingAuthEntry[] = [];
  let applyErr: unknown;
  try {
    // Resources FIRST: executePlan does `upsertAgent` for created agents, and
    // `setProviderApiKey` targets `/agents/<id>/providers/...` — pushing keys
    // before the agent exists 404s on a first apply. So run the plan, then push
    // keys. (The all-noop / key-only short-circuit above pushes keys directly:
    // there are no agent creates there, so the agents already exist remotely.)
    if (hasResourceWork) {
      printText(chalk.bold("\nApplying:"));
      await executePlan({ client, state, plan, remote }, pendingAuth);
    }
    // Provider keys live outside the resource diff (idempotent PUT), so push
    // them on any confirmed apply (including a pending-auth-only plan). Done
    // here, not inside executePlan, so the all-noop short-circuit above can push
    // them too without double-pushing.
    if (hasProviderKeys) {
      printText(chalk.bold("\nApplying provider keys:"));
      await pushProviderApiKeys(client, state.agents);
    }
    if (hasResourceWork) {
      printText(chalk.green("\nApply complete."));
    }
  } catch (err) {
    applyErr = err;
    printError(`\n${err instanceof Error ? err.message : String(err)}`);
    printError(
      "Apply halted on first failure. Re-run `lobu apply` once the underlying issue is resolved — every endpoint is idempotent."
    );
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
