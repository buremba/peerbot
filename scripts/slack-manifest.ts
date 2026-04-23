import { readFile } from "node:fs/promises";

type SlackApiResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown };

function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) out[key] = value;
  }
  return out;
}

async function loadEnv(): Promise<void> {
  const originalKeys = new Set(Object.keys(process.env));

  const load = async (path: string, overrideFromFiles: boolean) => {
    try {
      const contents = await readFile(path, "utf8");
      const env = parseDotenv(contents);
      for (const [k, v] of Object.entries(env)) {
        // Never override real environment variables.
        if (originalKeys.has(k)) continue;

        if (!overrideFromFiles && process.env[k] !== undefined) continue;
        process.env[k] = v;
      }
      return true;
    } catch {
      return false;
    }
  };

  const dotenvPath = process.env.DOTENV_PATH;
  if (dotenvPath) {
    await load(dotenvPath, true);
    return;
  }

  // Default: .env then .env.local, where .env.local overrides .env.
  await load(".env", false);
  await load(".env.local", true);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

async function getSlackConfigAccessToken(): Promise<string> {
  const token = process.env.SLACK_CONFIG_TOKEN;
  if (token) return token;

  const refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("Missing env var: SLACK_CONFIG_TOKEN");

  const rotated = await slackApiCall("tooling.tokens.rotate", refreshToken, {
    refresh_token: refreshToken,
  });
  if (!rotated.ok) {
    throw new Error(
      `Failed to rotate Slack config token (tooling.tokens.rotate): ${rotated.error}`
    );
  }

  const rotatedToken = rotated.token;
  if (typeof rotatedToken !== "string" || rotatedToken.length === 0) {
    throw new Error(
      "Slack token rotation succeeded but response did not include a token"
    );
  }

  // Note: rotated response also includes refresh_token; we don't persist it to disk.
  return rotatedToken;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function patchManifestGatewayUrls(
  manifest: Record<string, unknown>,
  publicGatewayUrl: string,
  connectionId?: string
): void {
  const base = normalizeBaseUrl(publicGatewayUrl);
  // Per-connection self-install uses the webhook endpoint; multi-tenant
  // community install uses the generic /slack/events entry point.
  const requestUrl = connectionId
    ? `${base}/api/v1/webhooks/${connectionId}`
    : `${base}/slack/events`;

  const settings = manifest.settings as Record<string, unknown> | undefined;
  if (settings) {
    const eventSubs = settings.event_subscriptions as
      | Record<string, unknown>
      | undefined;
    if (eventSubs) eventSubs.request_url = requestUrl;

    const interactivity = settings.interactivity as
      | Record<string, unknown>
      | undefined;
    if (interactivity) interactivity.request_url = requestUrl;
  }

  const features = manifest.features as Record<string, unknown> | undefined;
  if (features) {
    const slashCommands = features.slash_commands as unknown;
    if (Array.isArray(slashCommands)) {
      for (const cmd of slashCommands) {
        if (cmd && typeof cmd === "object") {
          (cmd as Record<string, unknown>).url = requestUrl;
        }
      }
    }
  }

  // OAuth redirect URL is only needed for public-install apps that do the
  // full OAuth flow. Self-install manifests (SLACK_CONNECTION_ID set) should
  // not advertise a redirect URL.
  const oauthConfig = manifest.oauth_config as
    | Record<string, unknown>
    | undefined;
  if (oauthConfig) {
    if (connectionId) {
      delete oauthConfig.redirect_urls;
    } else {
      oauthConfig.redirect_urls = [`${base}/slack/oauth_callback`];
    }
  }
}

async function slackApiCall(
  method: string,
  token: string,
  body: Record<string, unknown>
): Promise<SlackApiResponse> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as SlackApiResponse;
}

async function main(): Promise<void> {
  await loadEnv();

  const cmd = process.argv[2] || "print";
  const manifestPath =
    process.env.SLACK_MANIFEST_PATH ||
    "config/slack-app-manifest.self-install.json";

  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  const publicGatewayUrl = process.env.PUBLIC_GATEWAY_URL;
  const connectionId = process.env.SLACK_CONNECTION_ID;
  if (publicGatewayUrl) {
    patchManifestGatewayUrls(manifest, publicGatewayUrl, connectionId);
  }

  if (cmd === "print") {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (cmd === "validate") {
    const token = await getSlackConfigAccessToken();
    const result = await slackApiCall("apps.manifest.validate", token, {
      manifest,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exit(1);
    return;
  }

  if (cmd === "update") {
    const token = await getSlackConfigAccessToken();
    const appId = requireEnv("SLACK_APP_ID");
    const result = await slackApiCall("apps.manifest.update", token, {
      app_id: appId,
      manifest,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exit(1);
    return;
  }

  if (cmd === "rotate") {
    const refreshToken = requireEnv("SLACK_CONFIG_REFRESH_TOKEN");
    const result = await slackApiCall("tooling.tokens.rotate", refreshToken, {
      refresh_token: refreshToken,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exit(1);
    return;
  }

  throw new Error(
    `Unknown command: ${cmd} (expected: print|validate|update|rotate)`
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.stderr.write("Usage: bun run scripts/slack-manifest.ts <cmd>\n");
  process.stderr.write("Cmd: print | validate | update | rotate\n");
  process.stderr.write(
    "Env: SLACK_CONFIG_TOKEN or SLACK_CONFIG_REFRESH_TOKEN; SLACK_APP_ID (for update)\n"
  );
  process.stderr.write(
    "Optional env: SLACK_MANIFEST_PATH, PUBLIC_GATEWAY_URL, SLACK_CONNECTION_ID, DOTENV_PATH\n"
  );
  process.exit(1);
});
