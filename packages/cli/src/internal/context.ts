import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOBU_CONFIG_DIR = join(homedir(), ".config", "lobu");
export const DEFAULT_CONTEXT_NAME = "lobu";
const DEFAULT_CONTEXT_URL = "https://app.lobu.ai/api/v1";

const CONTEXTS_FILE = join(LOBU_CONFIG_DIR, "config.json");

export const DEFAULT_MEMORY_URL = "https://lobu.ai/mcp";

export interface LobuServerConfig {
  port?: number;
  host?: string;
  // Directory the lifecycle owner should `cd` into before spawning
  // `lobu run`. Used by per-worktree contexts so the menubar launches
  // the server against the worktree's source (hot-reload on the right
  // checkout). Absent → spawner uses its own cwd.
  cwd?: string;
  // "managed" → the Mac menubar (or another lifecycle owner) spawns
  // `lobu run` for this context. "external" → just connect; never
  // spawn or kill. Absent → infer at the lifecycle owner only.
  lifecycle?: "managed" | "external";
}

interface LobuContextEntry {
  url: string;
  activeOrg?: string;
  memoryUrl?: string;
  lifecycle?: "managed" | "external";
  cwd?: string;
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

interface StoredContextEntry {
  url?: unknown;
  apiUrl?: unknown;
  activeOrg?: unknown;
  memoryUrl?: unknown;
  lifecycle?: unknown;
  cwd?: unknown;
  server?: unknown;
}

interface StoredContextConfig {
  currentContext?: string;
  contexts?: Record<string, StoredContextEntry>;
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
    return contextToResolvedContext(contextName, context);
  }

  throw new Error(
    `Unknown context "${contextName}". Run \`lobu context list\` to see configured contexts.`
  );
}

export async function addContext(
  name: string,
  url: string,
  server?: LobuServerConfig
): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }
  if (trimmedName === DEFAULT_CONTEXT_NAME) {
    throw new Error(
      `Cannot overwrite the default context "${trimmedName}". Pick a different name.`
    );
  }

  const config = await loadContextConfig();
  const entry: LobuContextEntry = {
    url: normalizeAndValidateApiUrl(url),
  };
  const lifecycle = normalizeLifecycle(server?.lifecycle);
  if (lifecycle) entry.lifecycle = lifecycle;
  if (server?.cwd?.trim()) entry.cwd = server.cwd.trim();

  config.contexts[trimmedName] = entry;
  await saveContextConfig(config);
  return config;
}

export async function removeContext(name: string): Promise<LobuContextConfig> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Context name cannot be empty.");
  }

  const config = await loadContextConfig();
  if (!config.contexts[trimmedName]) {
    // Idempotent: removing a non-existent context is a no-op.
    return config;
  }
  if (trimmedName === DEFAULT_CONTEXT_NAME) {
    throw new Error(`Cannot remove the default context "${trimmedName}".`);
  }

  delete config.contexts[trimmedName];
  if (config.currentContext === trimmedName) {
    config.currentContext = DEFAULT_CONTEXT_NAME;
  }
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
      `Unknown context "${trimmedName}". Run \`lobu context add ${trimmedName} --url <url>\` first.`
    );
  }

  config.currentContext = trimmedName;
  await saveContextConfig(config);
  return config;
}

function normalizeContextConfig(raw: StoredContextConfig): LobuContextConfig {
  const contexts: Record<string, LobuContextEntry> = {
    [DEFAULT_CONTEXT_NAME]: { url: DEFAULT_CONTEXT_URL },
  };

  for (const [name, value] of Object.entries(raw.contexts ?? {})) {
    const normalized = normalizeContextEntry(value);
    if (normalized) contexts[name] = normalized;
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

function normalizeContextEntry(
  raw: StoredContextEntry
): LobuContextEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const legacyServer = normalizeLegacyServerConfig(raw.server);
  const rawUrl = firstString(raw.url, raw.apiUrl);
  if (!rawUrl) return undefined;

  const entry: LobuContextEntry = { url: normalizeApiUrl(rawUrl) };
  const activeOrg = normalizeString(raw.activeOrg);
  if (activeOrg) entry.activeOrg = activeOrg;
  const memoryUrl = normalizeString(raw.memoryUrl);
  if (memoryUrl) entry.memoryUrl = memoryUrl;
  const lifecycle = normalizeLifecycle(raw.lifecycle) ?? legacyServer.lifecycle;
  if (lifecycle) entry.lifecycle = lifecycle;
  const cwd = normalizeString(raw.cwd) ?? legacyServer.cwd;
  if (cwd) entry.cwd = cwd;

  return entry;
}

function normalizeLegacyServerConfig(
  raw: unknown
): Pick<LobuServerConfig, "cwd" | "lifecycle"> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Pick<LobuServerConfig, "cwd" | "lifecycle"> = {};
  const cwd = normalizeString(src.cwd);
  if (cwd) out.cwd = cwd;
  const lifecycle = normalizeLifecycle(src.lifecycle);
  if (lifecycle) out.lifecycle = lifecycle;
  return out;
}

function normalizeLifecycle(
  value: unknown
): "managed" | "external" | undefined {
  return value === "managed" || value === "external" ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export async function getServerConfig(
  contextName?: string
): Promise<LobuServerConfig | undefined> {
  const config = await loadContextConfig();
  // Honor LOBU_CONTEXT the same way resolveContext() does — without this,
  // a caller that sets the env var to pin a context (e.g. the Mac menubar
  // spawning `lobu run` with LOBU_CONTEXT=local) gets the server settings
  // from `currentContext` instead.
  const name =
    contextName?.trim() ||
    process.env.LOBU_CONTEXT?.trim() ||
    config.currentContext;
  const context = config.contexts[name];
  if (!context || context.lifecycle !== "managed") return undefined;

  return deriveManagedServerConfig(context);
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

  if (!server) {
    delete context.lifecycle;
    delete context.cwd;
  } else {
    const lifecycle = normalizeLifecycle(server.lifecycle);
    if (lifecycle) context.lifecycle = lifecycle;
    else delete context.lifecycle;
    if (server.cwd?.trim()) context.cwd = server.cwd.trim();
    else delete context.cwd;
  }
  await saveContextConfig(config);
  return config;
}

function deriveManagedServerConfig(
  context: LobuContextEntry
): LobuServerConfig | undefined {
  const out: LobuServerConfig = { lifecycle: context.lifecycle };
  if (context.cwd) out.cwd = context.cwd;

  try {
    const parsed = new URL(context.url);
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : undefined;
    if (port && Number.isInteger(port) && port > 0 && port <= 65535) {
      out.port = port;
    }
    if (parsed.hostname) {
      out.host = parsed.hostname;
    }
  } catch {
    // URL validation happens when contexts are saved/loaded; ignore here so a
    // hand-edited malformed config does not make the caller crash.
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

function normalizeAndValidateApiUrl(apiUrl: string): string {
  const normalized = normalizeApiUrl(apiUrl.trim());
  if (!normalized) {
    throw new Error("URL cannot be empty.");
  }

  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol || !parsed.host) {
      throw new Error("Missing protocol or host");
    }
  } catch {
    throw new Error(`Invalid URL: ${apiUrl}`);
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
    if (normalizeApiUrl(context.url) === normalizedSearch) {
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
    apiUrl: normalizeApiUrl(context.url),
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
