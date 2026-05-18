import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOBU_CONFIG_DIR = join(homedir(), ".config", "lobu");
export const DEFAULT_CONTEXT_NAME = "lobu";
const DEFAULT_API_URL = "https://app.lobu.ai/api/v1";

const CONTEXTS_FILE = join(LOBU_CONFIG_DIR, "config.json");

export const DEFAULT_MEMORY_URL = "https://lobu.ai/mcp";

export interface LobuServerConfig {
  databaseUrl?: string;
  port?: number;
  host?: string;
  dataDir?: string;
  // "managed" → the Mac menubar (or another lifecycle owner) spawns
  // `lobu run` for this context. "external" → just connect; never
  // spawn or kill. Absent → infer from apiUrl: loopback ⇒ managed,
  // remote ⇒ external. Today only the Mac menubar reads this.
  lifecycle?: "managed" | "external";
}

interface LobuContextEntry {
  apiUrl: string;
  activeOrg?: string;
  memoryUrl?: string;
  server?: LobuServerConfig;
}

interface LobuContextConfig {
  currentContext: string;
  contexts: Record<string, LobuContextEntry>;
}

export interface ResolvedContext {
  name: string;
  apiUrl: string;
  source: "default" | "config" | "env";
}

interface StoredContextConfig {
  currentContext?: string;
  contexts?: Record<string, LobuContextEntry>;
}

export async function loadContextConfig(): Promise<LobuContextConfig> {
  try {
    const raw = await readFile(CONTEXTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoredContextConfig;
    return normalizeContextConfig(parsed);
  } catch {
    return normalizeContextConfig({});
  }
}

async function saveContextConfig(config: LobuContextConfig): Promise<void> {
  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(CONTEXTS_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export async function getCurrentContextName(): Promise<string> {
  const envContext = process.env.LOBU_CONTEXT?.trim();
  if (envContext) {
    return envContext;
  }

  const config = await loadContextConfig();
  return config.currentContext;
}

export async function getActiveOrg(
  contextName?: string
): Promise<string | undefined> {
  const envOrg = process.env.LOBU_ORG?.trim();
  if (envOrg) return envOrg;

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  return config.contexts[name]?.activeOrg;
}

export async function getMemoryUrl(contextName?: string): Promise<string> {
  const envUrl = process.env.LOBU_MEMORY_URL?.trim();
  if (envUrl) return normalizeApiUrl(envUrl);

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  return normalizeApiUrl(
    config.contexts[name]?.memoryUrl || DEFAULT_MEMORY_URL
  );
}

export async function setActiveOrg(
  orgSlug: string,
  contextName?: string
): Promise<LobuContextConfig> {
  const trimmed = orgSlug.trim();
  if (!trimmed) {
    throw new Error("Organization slug cannot be empty.");
  }
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(trimmed)) {
    throw new Error(
      `Invalid organization slug "${orgSlug}". Slugs may only contain alphanumeric characters, hyphens, and underscores.`
    );
  }

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  const context = config.contexts[name];
  if (!context) {
    throw new Error(`Unknown context "${name}".`);
  }

  context.activeOrg = trimmed;
  await saveContextConfig(config);
  return config;
}

export async function setMemoryUrl(
  memoryUrl: string,
  contextName?: string
): Promise<LobuContextConfig> {
  const trimmed = memoryUrl.trim();
  if (!trimmed) {
    throw new Error("Memory URL cannot be empty.");
  }

  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  const context = config.contexts[name];
  if (!context) {
    throw new Error(`Unknown context "${name}".`);
  }

  context.memoryUrl = normalizeAndValidateApiUrl(trimmed);
  await saveContextConfig(config);
  return config;
}

export async function resolveContext(
  preferredContext?: string
): Promise<ResolvedContext> {
  const envApiUrl = process.env.LOBU_API_URL?.trim();
  const requestedContext =
    preferredContext?.trim() || process.env.LOBU_CONTEXT?.trim();

  if (envApiUrl) {
    return {
      name: requestedContext || (await getCurrentContextName()),
      apiUrl: normalizeApiUrl(envApiUrl),
      source: "env",
    };
  }

  const config = await loadContextConfig();
  const contextName = requestedContext || config.currentContext;
  const context = config.contexts[contextName];
  if (context) {
    return {
      name: contextName,
      apiUrl: normalizeApiUrl(context.apiUrl),
      source: contextName === DEFAULT_CONTEXT_NAME ? "default" : "config",
    };
  }

  throw new Error(
    `Unknown context "${contextName}". Run \`lobu context list\` to see configured contexts.`
  );
}

export async function addContext(
  name: string,
  apiUrl: string
): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }

  const config = await loadContextConfig();
  config.contexts[trimmedName] = {
    apiUrl: normalizeAndValidateApiUrl(apiUrl),
  };
  await saveContextConfig(config);
  return config;
}

export async function setCurrentContext(
  name: string
): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }

  const config = await loadContextConfig();
  if (!config.contexts[trimmedName]) {
    throw new Error(
      `Unknown context "${trimmedName}". Run \`lobu context add ${trimmedName} --api-url <url>\` first.`
    );
  }

  config.currentContext = trimmedName;
  await saveContextConfig(config);
  return config;
}

function normalizeContextConfig(raw: StoredContextConfig): LobuContextConfig {
  const contexts: Record<string, LobuContextEntry> = {
    [DEFAULT_CONTEXT_NAME]: { apiUrl: DEFAULT_API_URL },
  };

  for (const [name, value] of Object.entries(raw.contexts ?? {})) {
    if (!value || typeof value.apiUrl !== "string") {
      continue;
    }
    contexts[name] = {
      apiUrl: normalizeApiUrl(value.apiUrl),
      activeOrg:
        typeof value.activeOrg === "string"
          ? value.activeOrg.trim()
          : undefined,
      memoryUrl:
        typeof value.memoryUrl === "string"
          ? value.memoryUrl.trim()
          : undefined,
      server: normalizeServerConfig(value.server),
    };
  }

  const currentContext =
    raw.currentContext && contexts[raw.currentContext]
      ? raw.currentContext
      : DEFAULT_CONTEXT_NAME;

  return {
    currentContext,
    contexts,
  };
}

function normalizeServerConfig(raw: unknown): LobuServerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const out: LobuServerConfig = {};

  if (typeof src.databaseUrl === "string" && src.databaseUrl.trim()) {
    out.databaseUrl = src.databaseUrl.trim();
  }
  if (
    typeof src.port === "number" &&
    Number.isInteger(src.port) &&
    src.port > 0
  ) {
    out.port = src.port;
  }
  if (typeof src.host === "string" && src.host.trim()) {
    out.host = src.host.trim();
  }
  if (typeof src.dataDir === "string" && src.dataDir.trim()) {
    out.dataDir = src.dataDir.trim();
  }
  if (src.lifecycle === "managed" || src.lifecycle === "external") {
    out.lifecycle = src.lifecycle;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

export async function getServerConfig(
  contextName?: string
): Promise<LobuServerConfig | undefined> {
  const config = await loadContextConfig();
  // Honor LOBU_CONTEXT the same way resolveContext() does — without this,
  // a caller that sets the env var to pin a context (e.g. the Mac menubar
  // spawning `lobu run` with LOBU_CONTEXT=local) gets the server block
  // from `currentContext` instead, because no contextName was passed.
  const name =
    contextName?.trim() ||
    process.env.LOBU_CONTEXT?.trim() ||
    config.currentContext;
  return config.contexts[name]?.server;
}

export async function setServerConfig(
  server: LobuServerConfig | undefined,
  contextName?: string
): Promise<LobuContextConfig> {
  const config = await loadContextConfig();
  const name = contextName || config.currentContext;
  const context = config.contexts[name];
  if (!context) {
    throw new Error(`Unknown context "${name}".`);
  }

  context.server = server ? normalizeServerConfig(server) : undefined;
  await saveContextConfig(config);
  return config;
}

function normalizeAndValidateApiUrl(apiUrl: string): string {
  const normalized = normalizeApiUrl(apiUrl.trim());
  if (!normalized) {
    throw new Error("API URL cannot be empty.");
  }

  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol || !parsed.host) {
      throw new Error("Missing protocol or host");
    }
  } catch {
    throw new Error(`Invalid API URL: ${apiUrl}`);
  }

  return normalized;
}

function normalizeApiUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === url.length ? url : url.slice(0, end);
}

export async function findContextByUrl(
  apiUrl: string
): Promise<ResolvedContext | undefined> {
  const config = await loadContextConfig();
  const normalizedSearch = normalizeApiUrl(apiUrl);

  for (const [name, context] of Object.entries(config.contexts)) {
    if (normalizeApiUrl(context.apiUrl) === normalizedSearch) {
      return contextToResolvedContext(name, context);
    }
  }

  return undefined;
}

export async function findContextByMemoryUrl(
  memoryUrl: string
): Promise<ResolvedContext | undefined> {
  const config = await loadContextConfig();
  const normalizedSearch = normalizeMemoryBaseUrl(memoryUrl);

  for (const [name, context] of Object.entries(config.contexts)) {
    const candidate = normalizeMemoryBaseUrl(
      context.memoryUrl || DEFAULT_MEMORY_URL
    );
    if (candidate === normalizedSearch) {
      return contextToResolvedContext(name, context);
    }
  }

  return undefined;
}

function contextToResolvedContext(
  name: string,
  context: LobuContextEntry
): ResolvedContext {
  return {
    name,
    apiUrl: normalizeApiUrl(context.apiUrl),
    source: name === DEFAULT_CONTEXT_NAME ? "default" : "config",
  };
}

function normalizeMemoryBaseUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    url.search = "";
    // Compare at the *base* MCP path (`/mcp`) so a context whose memoryUrl is
    // org-scoped (`/mcp/<slug>`) still matches a bare-base search and vice
    // versa — mirrors `baseMcpUrl()` in openclaw-auth.ts.
    url.pathname = "/mcp";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalizeApiUrl(input);
  }
}
