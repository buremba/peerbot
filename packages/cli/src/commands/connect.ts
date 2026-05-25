/**
 * `lobu connect <connector> --org <public-org>`
 *
 * Connect a MANAGED connector that lives in a PUBLIC Lobu Cloud org, wiring a
 * LOCAL `managedBy` connection so this instance can fetch the connector's
 * access token at runtime (the grant + secret stay in the cloud).
 *
 * Flow:
 *   1. Open the EXISTING cloud connect URL for `org` + `connector`
 *      (`<cloudWeb>/<org>/connectors/<connector>`). A non-member sees the
 *      explicit join step there — we never auto-join.
 *   2. Poll the cloud's `POST /oauth/connection-token` with the user's login
 *      credential until it returns a token (consent completed) or we time out.
 *   3. Create (or update) a LOCAL connection marked `config.managedBy = { org }`
 *      in the local instance, plus any declared feeds so it actually syncs.
 *
 * The cloud side (connect URL + token poll) uses the `--cloud-context` context
 * (default `lobu` = app.lobu.ai). The LOCAL connection is created in the
 * standard `-c/--context` (default the active context — the loopback instance
 * `lobu run` registers).
 */

import chalk from "chalk";
import open from "open";
import ora from "ora";
import {
  apiBaseFromContextUrl,
  getToken,
  resolveApiClient,
  resolveContext,
} from "../internal/index.js";

export interface ConnectOptions {
  /** The PUBLIC cloud org the managed connector lives under (slug or id). */
  org: string;
  /** Local instance context where the managedBy connection is created. */
  context?: string;
  /** Cloud context (public org host + login token). Default: `lobu`. */
  cloudContext?: string;
  /** Local connection slug (defaults to the connector key, slugified). */
  slug?: string;
  /** Local connection display name. */
  name?: string;
  /** Local feed keys to create so the connection syncs. Repeatable. */
  feed?: string[];
  /** Skip opening the browser (print the URL only). */
  noOpen?: boolean;
  /** Max seconds to poll for consent completion. */
  timeout?: number;
}

const DEFAULT_CLOUD_CONTEXT = "lobu";
const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_SECONDS = 300;

/** `foo.bar Baz` → `foo-bar-baz`, clamped to the connection slug pattern. */
export function defaultSlug(connector: string): string {
  return (
    connector
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "managed"
  );
}

export async function connectCommand(
  connector: string,
  options: ConnectOptions
): Promise<void> {
  const connectorKey = connector.trim();
  if (!connectorKey) {
    console.error(chalk.red("\n  A connector key is required.\n"));
    process.exitCode = 1;
    return;
  }
  const org = options.org?.trim();
  if (!org) {
    console.error(chalk.red("\n  --org <public-org> is required.\n"));
    process.exitCode = 1;
    return;
  }

  const cloudContextName = options.cloudContext?.trim() || DEFAULT_CLOUD_CONTEXT;
  const cloud = await resolveContext(cloudContextName);
  const cloudOrigin = apiBaseFromContextUrl(cloud.url);

  const token = await getToken(cloudContextName);
  if (!token) {
    console.error(
      chalk.red(
        `\n  Not logged in to "${cloudContextName}". Run \`lobu login${
          cloudContextName === DEFAULT_CLOUD_CONTEXT ? "" : ` --context ${cloudContextName}`
        }\` first.\n`
      )
    );
    process.exitCode = 1;
    return;
  }

  // 1. Open the existing cloud connect URL (connections page for org+connector).
  //    A non-member sees the explicit join step there — we do NOT auto-join.
  const connectUrl = `${cloudOrigin}/${encodeURIComponent(org)}/connectors/${encodeURIComponent(
    connectorKey
  )}`;
  console.log(chalk.dim("\n  Complete the connection in your browser:"));
  console.log(chalk.cyan(`  ${connectUrl}`));
  console.log(
    chalk.dim(
      "  If you are not a member of this org yet, join it first (the page guides you).\n"
    )
  );
  if (!options.noOpen) {
    try {
      await open(connectUrl);
    } catch {
      // Best-effort; the URL is printed above.
    }
  }

  // 2. Poll the cloud token endpoint with the login credential until consent
  //    completes (200) or we time out. 404 = not connected yet (keep polling);
  //    403 = membership/scope problem (terminal).
  const tokenUrl = `${cloudOrigin}/oauth/connection-token`;
  const timeoutMs = (options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const deadline = Date.now() + timeoutMs;
  const interactive = process.stdout.isTTY === true;
  const spinner = interactive
    ? ora("Waiting for you to complete the connection...").start()
    : null;

  let connected = false;
  try {
    while (Date.now() < deadline) {
      const status = await pollConnectionToken(tokenUrl, token, {
        org,
        connector_key: connectorKey,
      });
      if (status.ok) {
        connected = true;
        break;
      }
      if (status.terminal) {
        spinner?.fail(status.message);
        if (!spinner) console.error(chalk.red(`  ${status.message}`));
        console.log();
        process.exitCode = 1;
        return;
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
  } finally {
    if (!connected) spinner?.stop();
  }

  if (!connected) {
    const msg = "Timed out waiting for the connection to be completed.";
    if (spinner) spinner.fail(msg);
    else console.error(chalk.red(`  ${msg}`));
    console.log(chalk.dim("  Re-run `lobu connect` after finishing in the browser.\n"));
    process.exitCode = 1;
    return;
  }
  spinner?.succeed("Cloud connection confirmed.");

  // 3. Create (or update) the LOCAL managedBy connection in the local instance.
  const slug = options.slug?.trim() || defaultSlug(connectorKey);
  const feeds = (options.feed ?? []).map((f) => f.trim()).filter(Boolean);
  await upsertLocalManagedConnection({
    context: options.context,
    org,
    connectorKey,
    slug,
    name: options.name,
    feeds,
  });

  console.log(
    chalk.green(
      `\n  Linked managed connector "${connectorKey}" (org "${org}") as local connection "${slug}".`
    )
  );
  if (feeds.length > 0) {
    console.log(chalk.dim(`  Feeds: ${feeds.join(", ")} — the connection will sync locally.`));
  } else {
    console.log(
      chalk.dim("  No feeds declared. Pass `--feed <key>` to make the connection sync.")
    );
  }
  console.log();
}

export interface PollResult {
  ok: boolean;
  /** Terminal failure (don't keep polling). */
  terminal: boolean;
  message: string;
}

/**
 * One poll of the cloud connection-token endpoint with the login credential.
 *   200 → ok. 404 → not connected yet (keep polling). 401/403 → terminal.
 */
export async function pollConnectionToken(
  tokenUrl: string,
  token: string,
  body: { org: string; connector_key: string },
  fetchImpl: typeof fetch = fetch
): Promise<PollResult> {
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network blip — keep polling.
    return { ok: false, terminal: false, message: String((err as Error).message) };
  }
  if (response.status === 200) return { ok: true, terminal: false, message: "" };
  if (response.status === 404) {
    // Not connected yet (consent not completed) — keep polling.
    return { ok: false, terminal: false, message: "" };
  }
  const data = (await response.json().catch(() => null)) as {
    error_description?: string;
    error?: string;
  } | null;
  const detail = data?.error_description ?? data?.error ?? `HTTP ${response.status}`;
  if (response.status === 403) {
    return {
      ok: false,
      terminal: true,
      message: `Not authorized: ${detail}. Join the org and ensure your login is current (\`lobu login --force\`).`,
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      terminal: true,
      message: `Authentication failed: ${detail}. Re-run \`lobu login\`.`,
    };
  }
  // Other 4xx/5xx — terminal.
  return { ok: false, terminal: true, message: detail };
}

/**
 * Create (or update) the local managedBy connection + its feeds via the local
 * instance's admin API. Idempotent: if a connection with the slug already
 * exists, mark it managedBy and ensure the feeds; otherwise create it.
 */
async function upsertLocalManagedConnection(params: {
  context?: string;
  org: string;
  connectorKey: string;
  slug: string;
  name?: string;
  feeds: string[];
}): Promise<void> {
  const { client, orgSlug } = await resolveApiClient({ context: params.context });
  const connectionsPath = `/api/${orgSlug}/manage_connections`;
  const feedsPath = `/api/${orgSlug}/manage_feeds`;

  const config = { managedBy: { org: params.org } };

  const existing = await findConnectionBySlug(client, connectionsPath, params.slug);
  let connectionId: number;
  if (existing) {
    await client.post(connectionsPath, {
      action: "update",
      connection_id: existing.id,
      config,
      replace_config: false,
    });
    connectionId = existing.id;
  } else {
    const created = await client.post<{ connection?: { id?: number } }>(connectionsPath, {
      action: "create",
      connector_key: params.connectorKey,
      slug: params.slug,
      ...(params.name ? { display_name: params.name } : {}),
      config,
    });
    const id = created.connection?.id;
    if (typeof id !== "number") {
      throw new Error("Local connection creation returned no connection id.");
    }
    connectionId = id;
  }

  // Feeds (Stage 5): create any declared feed so the local connection syncs.
  for (const feedKey of params.feeds) {
    await client
      .post(feedsPath, {
        action: "create_feed",
        connection_id: connectionId,
        feed_key: feedKey,
      })
      .catch((err: unknown) => {
        // A feed that already exists is fine; surface anything else.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists|duplicate/i.test(msg)) throw err;
      });
  }
}

async function findConnectionBySlug(
  client: { post<T>(path: string, body?: unknown): Promise<T> },
  connectionsPath: string,
  slug: string
): Promise<{ id: number } | null> {
  const body = await client.post<{ connections?: Array<{ id: number; slug: string }> }>(
    connectionsPath,
    { action: "list", limit: 500 }
  );
  const match = (body.connections ?? []).find((c) => c.slug === slug);
  return match ? { id: match.id } : null;
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}
