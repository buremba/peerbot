/**
 * `lobu export` — pull server state into apply-compatible files.
 *
 * Round-trips with `lobu apply`: every file written here is a valid input for
 * a future apply on the same (or another) org. Scope is intentionally narrow:
 * memory models (entity types, relationship types, watchers including
 * reaction scripts as sibling `.ts` files) and connectors (connections +
 * auth_profile placeholders). Agent config / lobu.toml / SOUL.md aren't
 * exported — those are author-time files that don't get edited in the UI.
 *
 * The default destination is `<cwd>/models/exported.yaml` +
 * `<cwd>/connectors/exported.yaml`. Both write paths are skipped when the
 * file exists unless `--force` is passed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { stringify as stringifyYaml } from "yaml";
import { resolveApplyClient } from "../apply/client.js";
import type {
  ApplyClient,
  RemoteAuthProfile,
  RemoteConnection,
  RemoteEntityType,
  RemoteFeed,
  RemoteRelationshipType,
  RemoteWatcher,
} from "../apply/client.js";
import { printText } from "../../memory/_lib/output.js";

export interface ExportOptions {
  cwd?: string;
  /** Override the destination directory (defaults to `cwd`). */
  out?: string;
  /** Allow overwriting existing exported files. */
  force?: boolean;
  /** Org slug (defaults to active session). */
  org?: string;
  /** Server URL override. */
  url?: string;
  /** Restrict to one resource family. */
  only?: "models" | "connectors";
  /** Test seam — inject fetch. */
  fetchImpl?: typeof fetch;
}

interface ExportedFile {
  /** Relative path under `out`. */
  path: string;
  /** Body to write. */
  body: string;
  /** Did we skip (existing file, no --force)? */
  skipped?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function entityTypeDoc(e: RemoteEntityType): Record<string, unknown> {
  const out: Record<string, unknown> = {
    slug: e.slug,
    ...(e.name ? { name: e.name } : {}),
    ...(e.description ? { description: e.description } : {}),
  };
  if (
    (e.required && e.required.length > 0) ||
    (e.properties && Object.keys(e.properties).length > 0)
  ) {
    const metadata: Record<string, unknown> = {};
    if (e.required?.length) metadata.required = e.required;
    if (e.properties && Object.keys(e.properties).length > 0) {
      metadata.properties = e.properties;
    }
    out.metadata_schema = metadata;
  }
  return out;
}

function relationshipTypeDoc(
  r: RemoteRelationshipType
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    slug: r.slug,
    ...(r.name ? { name: r.name } : {}),
    ...(r.description ? { description: r.description } : {}),
  };
  if (r.rules?.length) out.rules = r.rules;
  return out;
}

function watcherDoc(
  w: RemoteWatcher,
  reactionScriptRelPath: string | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    slug: w.slug,
    ...(w.name ? { name: w.name } : {}),
    ...(w.agent_id ? { agent: w.agent_id } : {}),
    ...(w.description ? { description: w.description } : {}),
  };
  if (w.schedule) out.schedule = w.schedule;
  if (w.prompt) out.prompt = w.prompt;
  if (w.extraction_schema && Object.keys(w.extraction_schema).length > 0) {
    out.extraction_schema = w.extraction_schema;
  }
  if (w.sources?.length) out.sources = w.sources;
  if (w.reactions_guidance) out.reactions_guidance = w.reactions_guidance;
  if (reactionScriptRelPath) out.reaction_script = reactionScriptRelPath;
  if (w.device_worker_id) out.device_worker_id = w.device_worker_id;
  if (w.scheduler_client_id) out.scheduler_client_id = w.scheduler_client_id;
  if (w.notification_channel && w.notification_channel !== "canvas") {
    out.notification_channel = w.notification_channel;
  }
  if (w.notification_priority && w.notification_priority !== "normal") {
    out.notification_priority = w.notification_priority;
  }
  if (
    w.min_cooldown_seconds !== undefined &&
    w.min_cooldown_seconds !== null &&
    w.min_cooldown_seconds !== 0
  ) {
    out.min_cooldown_seconds = w.min_cooldown_seconds;
  }
  if (w.tags?.length) out.tags = w.tags;
  if (w.agent_kind) out.agent_kind = w.agent_kind;
  if (w.json_template) out.json_template = w.json_template;
  if (w.keying_config && Object.keys(w.keying_config).length > 0) {
    out.keying_config = w.keying_config;
  }
  if (w.classifiers?.length) out.classifiers = w.classifiers;
  if (w.condensation_prompt) out.condensation_prompt = w.condensation_prompt;
  if (w.condensation_window_count) {
    out.condensation_window_count = w.condensation_window_count;
  }
  return out;
}

function connectionDoc(
  c: RemoteConnection,
  feeds: RemoteFeed[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: 1,
    type: "connection",
    slug: c.slug,
    connector: c.connector_key,
    ...(c.display_name ? { name: c.display_name } : {}),
    ...(c.auth_profile_slug ? { auth: c.auth_profile_slug } : {}),
    ...(c.app_auth_profile_slug ? { app_auth: c.app_auth_profile_slug } : {}),
  };
  if (c.config && Object.keys(c.config).length > 0) out.config = c.config;
  if (c.device_worker_id) out.device_worker_id = c.device_worker_id;
  if (feeds.length > 0) {
    out.feeds = feeds.map((f) => {
      const feed: Record<string, unknown> = { feed: f.feed_key };
      if (f.display_name) feed.name = f.display_name;
      if (f.schedule) feed.schedule = f.schedule;
      if (f.config && Object.keys(f.config).length > 0) feed.config = f.config;
      return feed;
    });
  }
  return out;
}

function authProfileDoc(p: RemoteAuthProfile): Record<string, unknown> {
  // We never export credentials — they're write-only on the server, and we
  // mustn't emit literal secrets to disk. Operators fill credentials back in
  // (typically via `$ENV` refs) before re-applying.
  return {
    version: 1,
    type: "auth_profile",
    slug: p.slug,
    connector: p.connector_key,
    kind: profileKindForExport(p.profile_kind),
    ...(p.display_name ? { name: p.display_name } : {}),
  };
}

function profileKindForExport(kind: string): string {
  // Server returns its canonical kind; CLI consumes the same names. No mapping
  // needed today — this stub exists to keep one place to centralize any
  // future divergence.
  return kind;
}

async function loadFeedsByConnection(
  client: ApplyClient,
  connections: RemoteConnection[]
): Promise<Map<number, RemoteFeed[]>> {
  const out = new Map<number, RemoteFeed[]>();
  for (const conn of connections) {
    out.set(conn.id, await client.listFeeds(conn.id));
  }
  return out;
}

/** Write a file if it doesn't exist, or overwrite when `force`. */
async function writeIfFreeOrForced(
  absPath: string,
  body: string,
  force: boolean
): Promise<{ skipped: boolean }> {
  if (existsSync(absPath) && !force) {
    return { skipped: true };
  }
  await mkdir(resolve(absPath, ".."), { recursive: true });
  await writeFile(absPath, body, "utf-8");
  return { skipped: false };
}

// ── Multi-doc YAML helpers ─────────────────────────────────────────────────

function modelBundleYaml(
  entityTypes: RemoteEntityType[],
  relationshipTypes: RemoteRelationshipType[],
  watchers: Array<{
    watcher: RemoteWatcher;
    reactionScriptRelPath: string | undefined;
  }>
): string {
  // Single dbt-style bundle so apply's loader handles it. Empty sections are
  // omitted to keep the file tidy.
  const bundle: Record<string, unknown> = { version: 2 };
  if (entityTypes.length > 0) {
    bundle.entities = entityTypes.map(entityTypeDoc);
  }
  if (relationshipTypes.length > 0) {
    bundle.relationships = relationshipTypes.map(relationshipTypeDoc);
  }
  if (watchers.length > 0) {
    bundle.watchers = watchers.map(({ watcher, reactionScriptRelPath }) =>
      watcherDoc(watcher, reactionScriptRelPath)
    );
  }
  return stringifyYaml(bundle, { lineWidth: 0, blockQuote: "literal" });
}

function connectorBundleYaml(
  connections: RemoteConnection[],
  feedsByConnection: Map<number, RemoteFeed[]>,
  authProfiles: RemoteAuthProfile[]
): string {
  // Multi-document YAML stream — one doc per connection / auth_profile, the
  // shape `loadConnectors` already understands.
  const docs: Record<string, unknown>[] = [];
  for (const p of authProfiles) docs.push(authProfileDoc(p));
  for (const c of connections) {
    docs.push(connectionDoc(c, feedsByConnection.get(c.id) ?? []));
  }
  return docs
    .map((doc) => stringifyYaml(doc, { lineWidth: 0, blockQuote: "literal" }))
    .join("---\n");
}

// ── Top-level ──────────────────────────────────────────────────────────────

export async function exportCommand(opts: ExportOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const out = resolve(cwd, opts.out ?? ".");
  const force = !!opts.force;

  const { client, orgSlug } = await resolveApplyClient({
    url: opts.url,
    org: opts.org,
    fetchImpl: opts.fetchImpl,
  });
  printText(chalk.dim(`Exporting from org: ${orgSlug}`));
  printText(chalk.dim(`Destination: ${out}`));

  const wantModels = !opts.only || opts.only === "models";
  const wantConnectors = !opts.only || opts.only === "connectors";

  const written: ExportedFile[] = [];

  if (wantModels) {
    const [entityTypes, relationshipTypes, watchers] = await Promise.all([
      client.listEntityTypes(),
      client.listRelationshipTypes(),
      client.listWatchers(),
    ]);

    // Reaction scripts aren't on the list response — fetch each watcher's
    // detail to pick up `reaction_script`. Sequential to keep load on the
    // server bounded; a per-watcher GET is cheap.
    const withReactions: Array<{
      watcher: RemoteWatcher;
      reactionScriptRelPath: string | undefined;
    }> = [];
    for (const w of watchers) {
      let reactionScriptRelPath: string | undefined;
      if (w.watcher_id) {
        const detail = await client.getWatcherDetail(w.watcher_id);
        const script = detail?.reaction_script ?? null;
        if (script) {
          // Defensive slug sanitization — the watcher slug is used as a
          // filesystem path component below. The server's slug constraint
          // should already keep this safe, but a stale or corrupted row could
          // contain `..` or `/`. Reject anything that isn't a tight basename.
          const safeSlug = String(w.slug);
          if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(safeSlug)) {
            printText(
              chalk.yellow(
                `  ⚠ skipping reaction script for watcher slug "${safeSlug}" — slug is not a safe filename basename; export the watcher manually if needed.`
              )
            );
          } else {
            const rel = `reactions/${safeSlug}.reaction.ts`;
            const abs = join(out, "models", rel);
            const res = await writeIfFreeOrForced(abs, script, force);
            // When the local file exists and --force isn't set, don't emit a
            // `reaction_script:` reference — re-applying would otherwise
            // upload whatever stale code happens to be on disk, masking the
            // server's actual script. Loudly warn so the operator notices.
            if (res.skipped) {
              printText(
                chalk.yellow(
                  `  ⚠ keeping existing ${rel}; YAML will NOT reference the server script (re-run with --force to overwrite and re-link).`
                )
              );
              written.push({
                path: join("models", rel),
                body: script,
                skipped: true,
              });
            } else {
              written.push({
                path: join("models", rel),
                body: script,
              });
              reactionScriptRelPath = `./${rel}`;
            }
          }
        }
        if (detail?.description && !w.description) {
          w.description = detail.description;
        }
      }
      withReactions.push({ watcher: w, reactionScriptRelPath });
    }

    const bundleBody = modelBundleYaml(
      entityTypes,
      relationshipTypes,
      withReactions
    );
    const bundlePath = join(out, "models", "exported.yaml");
    const res = await writeIfFreeOrForced(bundlePath, bundleBody, force);
    written.push({
      path: join("models", "exported.yaml"),
      body: bundleBody,
      ...(res.skipped ? { skipped: true } : {}),
    });
  }

  if (wantConnectors) {
    const [authProfiles, connections] = await Promise.all([
      client.listAuthProfiles(),
      client.listConnections(),
    ]);
    if (authProfiles.length > 0 || connections.length > 0) {
      const feedsByConnection = await loadFeedsByConnection(
        client,
        connections
      );
      const body = connectorBundleYaml(
        connections,
        feedsByConnection,
        authProfiles
      );
      const path = join(out, "connectors", "exported.yaml");
      const res = await writeIfFreeOrForced(path, body, force);
      written.push({
        path: join("connectors", "exported.yaml"),
        body,
        ...(res.skipped ? { skipped: true } : {}),
      });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (written.length === 0) {
    printText(
      chalk.dim(
        "\nNothing to export — server has no models or connectors for this org."
      )
    );
    return;
  }
  const skipped = written.filter((w) => w.skipped);
  const wrote = written.filter((w) => !w.skipped);
  if (wrote.length > 0) {
    printText(chalk.bold("\nWrote:"));
    for (const w of wrote) printText(`  ${chalk.green("+")} ${w.path}`);
  }
  if (skipped.length > 0) {
    printText(
      chalk.bold("\nSkipped (file exists — use --force to overwrite):")
    );
    for (const w of skipped) printText(`  ${chalk.yellow("·")} ${w.path}`);
  }
  // Auth profiles are kind-only — flag any oauth_app/env profile in the export
  // so the operator knows they need to re-add `credentials:` (or `$ENV` refs)
  // before the next apply. Quick re-read of the file to find their slugs is
  // overkill; instead print the list directly from what we exported.
  if (wantConnectors) {
    const authProfiles = await client.listAuthProfiles();
    const credentialed = authProfiles.filter(
      (p) => p.profile_kind === "env" || p.profile_kind === "oauth_app"
    );
    if (credentialed.length > 0) {
      printText(
        chalk.bold(
          "\nNote — credentials are write-only on the server, not exported:"
        )
      );
      for (const p of credentialed) {
        printText(
          `  ${chalk.yellow("·")} auth_profile "${p.slug}" (${p.profile_kind}) — re-add \`credentials:\` (typically with \`$ENV\` refs) before applying.`
        );
      }
    }
  }
}

// Stub kept for the future if we want to validate the export against the
// loaded desired-state. Today exported files round-trip through
// `loadDesiredState` directly because they share the same schema, so we don't
// re-validate here. Imports kept to satisfy the bundler if this lib grows.
export const __exportInternals = { readFile };
