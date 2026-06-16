import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ValidationError } from "./errors.js";
import {
  getUsableToken,
  mcpUrlForOrg,
  normalizeMcpUrl,
  resolveOrg,
  resolveServerUrl,
  setActiveMcpUrl,
  setActiveOrg,
  type MemorySession,
} from "./openclaw-auth.js";
import { printText } from "../../../internal/output.js";
import { mcpRpc } from "./mcp.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveSessionAndUrl(
  urlFlag?: string,
  orgFlag?: string,
  context?: string
): Promise<{ token: string; session: MemorySession; mcpUrl: string }> {
  const org = await resolveOrg(orgFlag, undefined, context);
  const serverUrl = await resolveServerUrl(urlFlag, context);
  if (!serverUrl) {
    throw new ValidationError("Memory MCP URL could not be resolved.");
  }

  const mcpUrl = org ? mcpUrlForOrg(serverUrl, org) : serverUrl;
  const result = await getUsableToken(mcpUrl, context);
  if (!result) {
    throw new ValidationError("Not logged in. Run: lobu login");
  }

  return { token: result.token, session: result.session, mcpUrl };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function writeJsonObject(filePath: string, payload: Record<string, unknown>) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function defaultTokenCommand(context?: string): string {
  return context
    ? `lobu token --raw --context ${shellQuote(context)}`
    : "lobu token --raw";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface HealthOptions {
  url?: string;
  org?: string;
  context?: string;
}

export async function checkMemoryHealth(
  opts: HealthOptions = {}
): Promise<void> {
  // Resolve + validate auth ("Not logged in" surfaces here), then run the
  // initialize → tools/list handshake through the shared mcp.ts client, whose
  // localhost/docker-host fallback and session handling are the single impl.
  const { session, mcpUrl: targetMcpUrl } = await resolveSessionAndUrl(
    opts.url,
    opts.org,
    opts.context
  );
  const org = await resolveOrg(opts.org, session, opts.context);

  const result = (await mcpRpc(targetMcpUrl, "tools/list", {}, opts.context)) as
    | { tools?: unknown[] }
    | undefined;
  const toolsCount = Array.isArray(result?.tools) ? result.tools.length : 0;

  printText("ok: true");
  printText(`mcpUrl: ${targetMcpUrl}`);
  printText(`org: ${org || "(none)"}`);
  printText(`tools: ${toolsCount}`);
}

export interface ConfigureOptions {
  url?: string;
  org?: string;
  context?: string;
  configPath?: string;
  tokenCommand?: string;
}

export async function configureMemoryPlugin(
  opts: ConfigureOptions = {}
): Promise<void> {
  const org = await resolveOrg(opts.org, undefined, opts.context);
  const baseMcpUrl = await resolveServerUrl(opts.url, opts.context);
  if (!baseMcpUrl) {
    throw new ValidationError("Memory MCP URL could not be resolved.");
  }
  const resolvedMcpUrl = org
    ? mcpUrlForOrg(baseMcpUrl, org)
    : normalizeMcpUrl(baseMcpUrl);
  await setActiveMcpUrl(resolvedMcpUrl, opts.context);
  if (org) await setActiveOrg(org, opts.context);

  const configPath = resolve(
    opts.configPath || resolve(homedir(), ".openclaw", "openclaw.json")
  );
  const config = readJsonObject(configPath);

  if (!isRecord(config.plugins)) {
    config.plugins = {};
  }
  const plugins = config.plugins as Record<string, unknown>;
  if (!isRecord(plugins.entries)) {
    plugins.entries = {};
  }
  const entries = plugins.entries as Record<string, unknown>;
  const pluginId = "openclaw-lobu";
  const existingEntry = isRecord(entries[pluginId])
    ? (entries[pluginId] as Record<string, unknown>)
    : {};
  const existingConfig = isRecord(existingEntry.config)
    ? (existingEntry.config as Record<string, unknown>)
    : {};

  const tokenCommand = opts.tokenCommand || defaultTokenCommand(opts.context);

  entries[pluginId] = {
    ...existingEntry,
    enabled: true,
    config: {
      ...existingConfig,
      mcpUrl: resolvedMcpUrl,
      tokenCommand,
    },
  };

  writeJsonObject(configPath, config);

  printText(`Updated ${configPath}`);
  printText(`Plugin: ${pluginId}`);
  printText(`mcpUrl: ${resolvedMcpUrl}`);
  printText(`tokenCommand: ${tokenCommand}`);
}
