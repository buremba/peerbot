/**
 * `lobu connector run` — execute a connector locally against a browser_session
 * auth profile, no feed row required, no events persisted.
 *
 * Why this exists: testing a device-bound browser_session profile end-to-end
 * (does Chrome launch, are we signed in, does the connector emit anything?)
 * used to require creating a real connections row + a feed + triggering it,
 * and even then events would commit. This command runs the same compiled
 * connector code the server runs, against the same SessionState shape, but
 * locally on the user's Mac (where the source Chrome profile lives) and dumps the
 * would-be events + would-be-next-checkpoint to stdout and a run artifact.
 *
 * Scope (v1): browser_session profiles only. OAuth / env / interactive
 * profiles need credentials the CLI doesn't have; they require gateway-side
 * execution (a separate trigger_feed dry_run path, not yet wired).
 *
 * Execution uses SubprocessExecutor (the same one the worker daemon uses),
 * not an in-process executor — bugs in connector code don't take the CLI
 * down, and we get the same isolation production gets.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { printText } from "../memory/_lib/output.js";

import type { EventEnvelope } from "@lobu/connector-sdk";
import { resolveContext } from "../../internal/context.js";
import { getUsableToken, resolveOrg } from "../memory/_lib/openclaw-auth.js";
import {
  compileConnectorFromFile,
  findBundledConnectorFile,
} from "./connector-loader.js";

export interface ConnectorRunOptions {
  connectorKey?: string;
  authProfile?: string;
  config?: string;
  checkpointFromFeed?: string;
  fromFeed?: string;
  maxItems?: string;
  check?: boolean;
  json?: boolean;
  context?: string;
  url?: string;
  org?: string;
}

interface ResolvedAuthProfile {
  id: number;
  slug: string;
  display_name: string;
  connector_key: string | null;
  profile_kind: string;
  status: string;
  browser_kind: string | null;
  cdp_url: string | null;
  device_worker_id: string | null;
  /** Mirror-mode fields. When source_profile_dir is set, the connector
   * subprocess decrypts cookies from the user's Chrome locally instead of
   * launching anything. See packages/connector-sdk/src/browser/mirror-cookies.ts. */
  auth_data?: {
    source_profile_dir?: string | null;
    source_browser_root?: string | null;
    source_browser?: string | null;
    mode?: string | null;
    /** Per-profile opt-in to CDP attach. When true and the user's Chrome
     * is exposing remote debugging, the connector subprocess attaches
     * via the live CDP socket; otherwise it sticks to mirror cookies.
     * Default false — Lobu doesn't probe the user's browser process
     * without explicit consent, even when DevToolsActivePort is there. */
    allow_cdp_attach?: boolean;
  };
}

interface ResolvedFeed {
  id: number;
  feed_key: string;
  connection_id: number;
  connector_key: string;
  auth_profile_slug: string | null;
  device_worker_id: string | null;
  config: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
}

// The connector-run REST routes live on the main app (mounted at `/`),
// not under the Agent API (`/lobu`) or the MCP path. We resolve the
// app origin from the context's agent API URL — *not* the memory MCP
// URL, which historically defaulted to lobu.ai/mcp and pointed the
// connector-run client at the marketing site (404).
function apiBaseFrom(agentApiUrl: string): string {
  const { origin } = new URL(agentApiUrl);
  return origin;
}

async function authedGet<T>(apiUrl: string, token: string): Promise<T> {
  const res = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET ${apiUrl} → ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`
    );
  }
  return (await res.json()) as T;
}

function ensurePlaywrightAvailable(): void {
  try {
    const require_ = createRequire(import.meta.url);
    require_.resolve("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. `lobu connector run` drives browser_session profiles via Playwright. Install: `bunx playwright install chromium`"
    );
  }
}

function parseJsonFlag(
  raw: string | undefined,
  flagName: string
): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`--${flagName} expects a JSON object: ${msg}`);
  }
}

function summarizeEvents(contents: any[], max = 3): string {
  if (contents.length === 0) return "  (no events emitted)";
  const sample = contents.slice(0, max);
  return sample
    .map((c, i) => {
      const date =
        c.occurred_at instanceof Date
          ? c.occurred_at.toISOString()
          : c.occurred_at;
      const head = c.payload_text
        ? String(c.payload_text).slice(0, 90)
        : "(no payload)";
      return `  [${i + 1}] ${c.semantic_type ?? "?"} · ${date ?? "?"} · ${head}`;
    })
    .join("\n");
}

export async function connectorRun(
  args: ConnectorRunOptions,
  positionalKey?: string
): Promise<void> {
  ensurePlaywrightAvailable();

  // Resolve API endpoint + auth from the chosen context. The agent API URL
  // (e.g. https://app.lobu.ai/api/v1) shares an origin with the connector-run
  // REST routes — unlike the memory MCP URL, which historically defaulted to
  // lobu.ai/mcp and pointed this client at the marketing site.
  //
  // --url is an explicit override (for testing); LOBU_API_TOKEN short-circuits
  // the credential store.
  const ctx = await resolveContext(args.context);
  const explicitUrl = args.url?.trim();
  const apiBase = explicitUrl
    ? new URL(explicitUrl).origin
    : apiBaseFrom(ctx.apiUrl);

  const envToken = process.env.LOBU_API_TOKEN?.trim();
  let token: string;
  let resolvedContextName: string | undefined;
  if (envToken) {
    token = envToken;
    resolvedContextName = ctx.name;
  } else if (explicitUrl) {
    // Refuse to silently forward the context's stored credentials to a URL the
    // user typed on the command line — that's how tokens leak to the wrong
    // backend. Pair --url with LOBU_API_TOKEN explicitly.
    throw new Error(
      "--url requires LOBU_API_TOKEN to be set (refuse to forward stored credentials to an explicit override)."
    );
  } else {
    const tokenInfo = await getUsableToken(undefined, ctx.name);
    if (!tokenInfo) {
      throw new Error(
        "Not logged in. Run `lobu login` first (or set LOBU_API_TOKEN; or pass --context <name>)."
      );
    }
    token = tokenInfo.token;
    resolvedContextName = tokenInfo.contextName;
  }
  const orgSlug = await resolveOrg(args.org, undefined, resolvedContextName);
  if (!orgSlug) {
    throw new Error(
      "No active org. Run `lobu org use <slug>` or pass --org <slug>."
    );
  }

  // Resolve auth profile and (optionally) feed in parallel.
  let feed: ResolvedFeed | null = null;
  if (args.fromFeed) {
    const feedId = Number(args.fromFeed);
    if (!Number.isFinite(feedId))
      throw new Error(
        `--from-feed expects a numeric feed id (got: ${args.fromFeed})`
      );
    const { feed: feedRow } = await authedGet<{ feed: ResolvedFeed }>(
      `${apiBase}/api/${orgSlug}/connector-run/feed/${feedId}`,
      token
    );
    feed = feedRow;
    printText(
      `Resolved feed #${feed.id} (${feed.feed_key}) → connector ${feed.connector_key}, auth profile ${feed.auth_profile_slug ?? "<none>"}`
    );
  }

  const connectorKey =
    positionalKey ?? args.connectorKey ?? feed?.connector_key;
  if (!connectorKey) {
    throw new Error(
      "Missing connector key. Pass it positionally or use --from-feed <id>."
    );
  }

  const authProfileSlug =
    args.authProfile ?? feed?.auth_profile_slug ?? undefined;
  if (!authProfileSlug) {
    throw new Error(
      "Missing --auth-profile <slug> (and --from-feed didn't supply one)."
    );
  }

  const { profile } = await authedGet<{ profile: ResolvedAuthProfile }>(
    `${apiBase}/api/${orgSlug}/connector-run/auth-profile/${encodeURIComponent(authProfileSlug)}`,
    token
  );
  printText(
    `Resolved auth profile '${profile.slug}' (${profile.profile_kind}, status=${profile.status})`
  );

  // v1 scope: only browser_session profiles. OAuth/env profiles' credentials
  // live on the server and can't be safely materialized in the CLI process.
  if (profile.profile_kind !== "browser_session") {
    throw new Error(
      `Profile kind '${profile.profile_kind}' is not supported by \`lobu connector run\` (v1 supports only browser_session). Use the server-side trigger_feed path for OAuth/env-based profiles.`
    );
  }

  // Two auth shapes for a browser_session profile:
  //   1. Mirror mode (auth_data.source_profile_dir set): decrypt cookies
  //      from the user's Chrome via keychain at sync time. The source
  //      dir must exist on this machine.
  //   2. CDP attach (cdp_url set, no source_profile_dir): the user is
  //      running Chrome with --remote-debugging-port and we attach.
  const mirrorSourceDir = profile.auth_data?.source_profile_dir;
  const mirrorBrowserRoot = profile.auth_data?.source_browser_root;
  const mirrorSourceBrowser = profile.auth_data?.source_browser ?? "chrome";
  if (mirrorSourceDir && mirrorBrowserRoot) {
    const sourceProfilePath = `${mirrorBrowserRoot}/${mirrorSourceDir}`;
    if (!existsSync(sourceProfilePath)) {
      throw new Error(
        `Source Chrome profile not found at ${sourceProfilePath}.\n` +
          `The profile may have been deleted or renamed in your Chrome — re-pick in the Lobu menu bar.`
      );
    }
  }
  if (profile.cdp_url && !mirrorSourceDir) {
    printText(
      `Profile uses CDP at ${profile.cdp_url} — make sure that Chrome is running with --remote-debugging-port.`
    );
  }

  // Build connector config: feed config + CLI overrides (shallow, top-level).
  const cliConfig = parseJsonFlag(args.config, "config");
  const mergedConfig = { ...(feed?.config ?? {}), ...cliConfig };
  const maxItems = args.maxItems ? Number(args.maxItems) : undefined;
  if (maxItems !== undefined && Number.isFinite(maxItems) && maxItems > 0) {
    // Common-case caps that connectors actually honor; harmless if they ignore.
    mergedConfig.max_scrolls =
      mergedConfig.max_scrolls ?? Math.min(20, maxItems);
    mergedConfig.max_items = mergedConfig.max_items ?? maxItems;
  }

  // Borrow checkpoint either from --checkpoint-from-feed or --from-feed.
  let checkpoint: Record<string, unknown> | null = null;
  if (args.checkpointFromFeed) {
    const cpFeedId = Number(args.checkpointFromFeed);
    if (!Number.isFinite(cpFeedId))
      throw new Error(`--checkpoint-from-feed expects a numeric feed id`);
    const { feed: cpFeed } = await authedGet<{ feed: ResolvedFeed }>(
      `${apiBase}/api/${orgSlug}/connector-run/feed/${cpFeedId}`,
      token
    );
    checkpoint = cpFeed.checkpoint;
    printText(
      `Borrowed checkpoint from feed #${cpFeed.id} (${cpFeed.feed_key})`
    );
  } else if (feed) {
    checkpoint = feed.checkpoint;
  }

  // --check: validate everything resolved, don't actually run the connector.
  if (args.check) {
    const summary = {
      connector_key: connectorKey,
      auth_profile: profile.slug,
      mode: mirrorSourceDir ? "mirror" : "cdp",
      mirror: mirrorSourceDir
        ? {
            source_profile_dir: mirrorSourceDir,
            source_browser_root: mirrorBrowserRoot,
            source_browser: mirrorSourceBrowser,
          }
        : null,
      cdp_url: profile.cdp_url,
      profile_status: profile.status,
      feed_id: feed?.id,
      checkpoint: checkpoint ?? null,
      config: mergedConfig,
    };
    if (args.json) printText(JSON.stringify(summary, null, 2));
    else printText("✓ All resolved. Re-run without --check to execute.");
    return;
  }

  // Resolve and compile the connector. Done late so --check above doesn't
  // pay the esbuild cost.
  const sourcePath = findBundledConnectorFile(connectorKey);
  if (!sourcePath) {
    throw new Error(
      `Connector '${connectorKey}' not found in the bundled catalog. Check: \`lobu memory run manage_connections '{"action":"list_connector_definitions"}'\`.`
    );
  }
  printText(`Compiling ${connectorKey} from ${sourcePath}...`);
  const compiledCode = await compileConnectorFromFile(sourcePath);

  // Build the ExecutorJob shape that executeCompiledConnector expects.
  // For mirror profiles we layer two acquisition paths:
  //   1. DevToolsActivePort lookup against the source Chrome's
  //      user-data root. If the file is there, Chrome is exposing a
  //      live CDP WebSocket — either the user toggled the M144 setting
  //      at chrome://inspect/#remote-debugging, or they launched Chrome
  //      with --remote-debugging-port. Either way, we attach via CDP and
  //      run inside the user's actual Chrome session. Best fidelity for
  //      fingerprint-pinned sites (Revolut etc.).
  //   2. Keychain-decrypted cookies. If Chrome isn't exposing CDP, the
  //      connector subprocess falls back to headless Playwright with
  //      these cookies injected via addCookies. Covers ~90% of sites.
  //
  // The connector subprocess's browser-network.ts tries CDP first when
  // cdp_url is explicitly set, falls through to cookies on failure.
  const sessionState: Record<string, unknown> = {};
  if (mirrorSourceDir && mirrorBrowserRoot) {
    const { acquireMirroredCookies } = await import(
      "@lobu/connector-sdk/browser-mirror"
    );
    const { readDevToolsActivePort } = await import(
      "@lobu/connector-sdk/browser-devtools-active-port"
    );

    // Layer 1: DevToolsActivePort — *only* when the user explicitly
    // opted into CDP for this profile. Otherwise we never probe their
    // Chrome's debug surface, even if M144 is enabled for other tools.
    // Default-off matches the "no surprise dialogs" UX: the only way
    // Lobu attaches to a live Chrome is if the user checked the box at
    // profile-create time.
    if (profile.auth_data?.allow_cdp_attach === true) {
      const activePort = await readDevToolsActivePort(mirrorBrowserRoot);
      if (activePort) {
        printText(
          `Detected Chrome CDP at ${activePort.wsUrl} (via DevToolsActivePort).`
        );
        sessionState.cdp_url = activePort.wsUrl;
      } else {
        printText(
          "CDP attach allowed for this profile, but Chrome isn't exposing remote debugging — falling back to mirror cookies."
        );
      }
    }

    // Layer 2: cookies. Always acquire — even if CDP attach succeeds,
    // the cookies are a free fallback in case the CDP socket drops
    // mid-sync. Cheap to skip on CDP success in practice.
    printText(
      `Acquiring cookies from ${mirrorBrowserRoot}/${mirrorSourceDir}...`
    );
    const acquired = await acquireMirroredCookies({
      sourceBrowser: mirrorSourceBrowser,
      userDataRoot: mirrorBrowserRoot,
      sourceProfileDir: mirrorSourceDir,
    });
    printText(
      `  Kept ${acquired.cookies.length} cookies (skipped ${acquired.skipped_google_count} Google-account cookies, ${acquired.total_decrypted_count} total).`
    );
    sessionState.cookies = acquired.cookies;
  }
  // Explicit cdp_url on the profile row overrides DevToolsActivePort
  // auto-discovery — the user pinned a specific port at create time.
  if (profile.cdp_url) sessionState.cdp_url = profile.cdp_url;

  // Lazy-import the worker so the CLI startup doesn't pay this cost for
  // every command (only this one needs it). executeCompiledConnector defaults
  // to SubprocessExecutor internally — no need to instantiate one ourselves.
  const { executeCompiledConnector } = await import(
    "@lobu/connector-worker/executor/runtime"
  );

  // Signal handlers — Chrome processes spawned by Playwright don't always die
  // with the parent. The subprocess executor's child is forked from us, so
  // exiting the CLI process tears it down; the explicit exit code keeps the
  // shell's $? meaningful for scripts.
  const onSignal = (sig: NodeJS.Signals) => {
    process.stderr.write(`\nReceived ${sig}, shutting down...\n`);
    process.exit(130);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  // Sync events stream via the onEventChunk hook now (the executor used to
  // collect them into result.contents for us — that path is gone). Collect
  // locally so the artifact/--json output still has the full payload.
  const collectedEvents: EventEnvelope[] = [];
  const onEventChunk = (events: EventEnvelope[]) => {
    for (const event of events) collectedEvents.push(event);
    process.stderr.write(`  ... ${collectedEvents.length} events so far\n`);
  };

  printText(`Running ${connectorKey} (subprocess executor)...`);
  const startMs = Date.now();
  const result = await executeCompiledConnector({
    compiledCode,
    job: {
      mode: "sync",
      config: mergedConfig,
      checkpoint,
      env: process.env as Record<string, string | undefined>,
      sessionState,
      credentials: null,
      feedKey: feed?.feed_key ?? `${connectorKey}-cli-run`,
      entityIds: [],
    },
    hooks: { onEventChunk },
  });
  const durationMs = Date.now() - startMs;

  if (result.mode !== "sync") {
    throw new Error(`Expected sync result, got mode=${result.mode}`);
  }

  // Save artifact for debugging / sharing. ~/.lobu/cache/connector-runs/<ts>.json.
  const cacheDir = join(homedir(), ".lobu", "cache", "connector-runs");
  mkdirSync(cacheDir, { recursive: true });
  const artifactPath = join(cacheDir, `${connectorKey}-${Date.now()}.json`);
  const artifact = {
    timestamp: new Date().toISOString(),
    connector_key: connectorKey,
    auth_profile_slug: profile.slug,
    feed_id: feed?.id ?? null,
    config: mergedConfig,
    input_checkpoint: checkpoint,
    duration_ms: durationMs,
    event_count: collectedEvents.length,
    next_checkpoint: result.checkpoint,
    events: collectedEvents,
    metadata: result.metadata ?? {},
  };
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf-8");

  if (args.json) {
    printText(JSON.stringify(artifact, null, 2));
  } else {
    printText("");
    printText(`✓ Completed in ${(durationMs / 1000).toFixed(1)}s`);
    printText(`  Events: ${collectedEvents.length}`);
    if (collectedEvents.length > 0) {
      printText("  Sample:");
      printText(summarizeEvents(collectedEvents));
    }
    if (result.checkpoint) {
      printText(`  Next checkpoint: ${JSON.stringify(result.checkpoint)}`);
    }
    printText(`  Full artifact: ${artifactPath}`);
  }
}
