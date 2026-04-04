import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOBU_CONFIG_DIR = join(homedir(), ".config", "lobu");
export const DEFAULT_CONTEXT_NAME = "community";
const DEFAULT_API_URL = "https://community.lobu.ai/api/v1";

const CONTEXTS_FILE = join(LOBU_CONFIG_DIR, "config.json");

export interface LobuContextEntry {
  apiUrl: string;
}

export interface LobuContextConfig {
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
    contexts[name] = { apiUrl: normalizeApiUrl(value.apiUrl) };
  }

  const currentContext =
    raw.currentContext && contexts[raw.currentContext]
      ? raw.currentContext
      : DEFAULT_CONTEXT_NAME;

  return { currentContext, contexts };
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
  return url.replace(/\/+$/, "");
}
