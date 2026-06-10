import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ApiError, ValidationError } from "./errors.js";
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
import { MCP_PROTOCOL_VERSION } from "@lobu/core";
import { printText } from "./output.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractErrorMessage(
  parsed: Record<string, unknown>,
  status: number,
  statusText: string
): string {
  if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message;
  }
  if (typeof parsed.error_description === "string") {
    return parsed.error_description;
  }
  if (typeof parsed.error === "string") return parsed.error;
  return `HTTP ${status} ${statusText}`;
}

function parseJsonWithError<T>(text: string, fallbackMessage: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(fallbackMessage);
  }
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const parsed = raw
    ? parseJsonWithError<Record<string, unknown>>(
        raw,
        `Invalid JSON from ${url}`
      )
    : {};

  if (!res.ok) {
    throw new ApiError(
      `Request failed: ${extractErrorMessage(parsed, res.status, res.statusText)}`,
      res.status
    );
  }

  return parsed as T;
}

async function initializeMcpSession(
  url: string,
  accessToken: string
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "__init__",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lobu", version: "1.0.0" },
      },
    }),
  });

  const raw = await response.text();
  const parsed = raw
    ? parseJsonWithError<Record<string, unknown>>(
        raw,
        `Invalid JSON from ${url}`
      )
    : {};

  if (!response.ok) {
    throw new ApiError(
      `Request failed: ${extractErrorMessage(parsed, response.status, response.statusText)}`,
      response.status
    );
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new ApiError(
      "MCP initialize did not return an mcp-session-id header"
    );
  }

  await postJson(
    url,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    {
      Authorization: `Bearer ${accessToken}`,
      "mcp-session-id": sessionId,
    }
  );

  return sessionId;
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
  const {
    token: accessToken,
    session,
    mcpUrl: targetMcpUrl,
  } = await resolveSessionAndUrl(opts.url, opts.org, opts.context);
  const org = await resolveOrg(opts.org, session, opts.context);
  const sessionId = await initializeMcpSession(targetMcpUrl, accessToken);

  const result = await postJson<{ result?: { tools?: unknown[] } }>(
    targetMcpUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    },
    {
      Authorization: `Bearer ${accessToken}`,
      "mcp-session-id": sessionId,
    }
  );

  const toolsCount = Array.isArray(result.result?.tools)
    ? result.result?.tools.length
    : 0;

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
