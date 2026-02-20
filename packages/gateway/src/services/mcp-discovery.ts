import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@lobu/core";
import type { PrefillMcpServer } from "../auth/settings/token-service";

const logger = createLogger("mcp-discovery-service");

const DEFAULT_OFFICIAL_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0.1/servers";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RECENT_CANDIDATE_KEYS = 2000;

type DiscoverySource = "official" | "local";

interface RegistryRemote {
  type?: string;
  url?: string;
  headers?: Array<{
    name?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    value?: string;
  }>;
}

interface RegistryServerRecord {
  server?: {
    name?: string;
    description?: string;
    repository?: { url?: string; source?: string };
    remotes?: RegistryRemote[];
  };
}

interface LocalRegistryServer {
  id: string;
  name: string;
  description: string;
  type: string;
  config: Record<string, unknown>;
}

export interface DiscoveredMcpCandidate {
  id: string;
  canonicalId: string;
  name: string;
  description: string;
  source: DiscoverySource;
  url: string;
  requiresAuth: boolean;
  prefillMcpServer: PrefillMcpServer;
}

export class McpDiscoveryService {
  private readonly officialRegistryUrl: string;
  private readonly timeoutMs: number;
  private readonly localRegistry: LocalRegistryServer[];
  private readonly recentCandidates = new Map<string, DiscoveredMcpCandidate>();

  constructor() {
    this.officialRegistryUrl =
      process.env.MCP_DISCOVERY_OFFICIAL_REGISTRY_URL ||
      DEFAULT_OFFICIAL_REGISTRY_URL;
    const timeoutFromEnv = Number(process.env.MCP_DISCOVERY_TIMEOUT_MS || "");
    this.timeoutMs =
      Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
        ? timeoutFromEnv
        : DEFAULT_TIMEOUT_MS;
    this.localRegistry = loadLocalRegistry();
  }

  async search(query: string, limit = 5): Promise<DiscoveredMcpCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const [official, local] = await Promise.all([
      this.searchOfficialRegistry(trimmed, 25),
      this.searchLocalRegistry(trimmed),
    ]);

    const merged = dedupeById([...official, ...local]);
    for (const candidate of merged) {
      this.cacheCandidate(candidate);
    }
    return merged.slice(0, limit);
  }

  async getById(id: string): Promise<DiscoveredMcpCandidate | null> {
    const clean = id.trim();
    if (!clean) return null;

    const cached =
      this.recentCandidates.get(clean) ||
      this.recentCandidates.get(clean.toLowerCase());
    if (cached) return cached;

    const localMatch = this.searchLocalRegistry(clean).find(
      (candidate) =>
        candidate.id === clean ||
        candidate.canonicalId === clean ||
        candidate.id.toLowerCase() === clean.toLowerCase()
    );
    if (localMatch) {
      this.cacheCandidate(localMatch);
      return localMatch;
    }

    const officialCandidates = await this.searchOfficialRegistry(clean, 40);
    for (const candidate of officialCandidates) {
      this.cacheCandidate(candidate);
    }
    const exact = officialCandidates.find(
      (candidate) =>
        candidate.id === clean ||
        candidate.canonicalId === clean ||
        candidate.id.toLowerCase() === clean.toLowerCase() ||
        candidate.canonicalId.toLowerCase() === clean.toLowerCase()
    );
    return exact || null;
  }

  private cacheCandidate(candidate: DiscoveredMcpCandidate): void {
    this.setCacheKey(candidate.id, candidate);
    this.setCacheKey(candidate.id.toLowerCase(), candidate);
    this.setCacheKey(candidate.canonicalId, candidate);
    this.setCacheKey(candidate.canonicalId.toLowerCase(), candidate);
  }

  private setCacheKey(key: string, candidate: DiscoveredMcpCandidate): void {
    if (this.recentCandidates.has(key)) {
      this.recentCandidates.delete(key);
    }
    this.recentCandidates.set(key, candidate);

    while (this.recentCandidates.size > MAX_RECENT_CANDIDATE_KEYS) {
      const oldestKey = this.recentCandidates.keys().next().value;
      if (!oldestKey) break;
      this.recentCandidates.delete(oldestKey);
    }
  }

  private async searchOfficialRegistry(
    query: string,
    limit: number
  ): Promise<DiscoveredMcpCandidate[]> {
    try {
      const url = new URL(this.officialRegistryUrl);
      url.searchParams.set("search", query);
      url.searchParams.set("limit", String(clamp(limit, 1, 100)));

      const response = await fetchWithTimeout(url.toString(), this.timeoutMs);
      if (!response.ok) {
        logger.warn("Official MCP registry request failed", {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const data = (await response.json()) as {
        servers?: RegistryServerRecord[];
      };

      const candidates: DiscoveredMcpCandidate[] = [];
      for (const entry of data.servers || []) {
        const normalized = normalizeOfficialEntry(entry);
        if (normalized) {
          candidates.push(normalized);
        }
      }

      return candidates;
    } catch (error) {
      logger.warn("Official MCP registry search failed", { query, error });
      return [];
    }
  }

  private searchLocalRegistry(query: string): DiscoveredMcpCandidate[] {
    const q = query.toLowerCase();
    return this.localRegistry
      .filter((server) => {
        const url =
          typeof server.config.url === "string" ? server.config.url.trim() : "";
        if (!isHttpUrl(url)) return false;

        const id = server.id.toLowerCase();
        const name = server.name.toLowerCase();
        const description = (server.description || "").toLowerCase();

        return id.includes(q) || name.includes(q) || description.includes(q);
      })
      .map((server) => {
        const url = String(server.config.url);
        const requiresAuth =
          server.type === "oauth" ||
          !!server.config.oauth ||
          !!server.config.loginUrl;
        return {
          id: server.id,
          canonicalId: server.id,
          name: server.name,
          description: server.description || "",
          source: "local" as const,
          url,
          requiresAuth,
          prefillMcpServer: {
            id: server.id,
            name: server.name,
            url,
            type: "sse",
          },
        };
      });
  }
}

function loadLocalRegistry(): LocalRegistryServer[] {
  const candidatePaths = [
    join(__dirname, "../../../cli/src/mcp-servers.json"),
    join(process.cwd(), "packages/cli/src/mcp-servers.json"),
  ];

  for (const filePath of candidatePaths) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { servers?: LocalRegistryServer[] };
      if (Array.isArray(parsed.servers)) {
        logger.info("Loaded local MCP registry", {
          filePath,
          serverCount: parsed.servers.length,
        });
        return parsed.servers;
      }
    } catch {
      // Try next path
    }
  }

  logger.warn("Could not load local MCP registry JSON");
  return [];
}

function normalizeOfficialEntry(
  record: RegistryServerRecord
): DiscoveredMcpCandidate | null {
  const server = record.server;
  if (!server?.name) return null;

  const streamableRemote = (server.remotes || []).find(
    (remote) => remote?.type === "streamable-http" && isHttpUrl(remote.url)
  );
  if (!streamableRemote || !streamableRemote.url) {
    return null;
  }

  // We only support turn-key remote MCP installs from chat.
  // Skip entries requiring extra secret headers not represented in settings prefill.
  if (requiresSecretHeaders(streamableRemote)) {
    return null;
  }

  const canonicalId = server.name;
  const generatedId = sanitizeMcpId(canonicalId);
  return {
    id: generatedId,
    canonicalId,
    name: server.name,
    description: server.description || "",
    source: "official",
    url: streamableRemote.url,
    requiresAuth: false,
    prefillMcpServer: {
      id: generatedId,
      name: server.name,
      url: streamableRemote.url,
      type: "sse",
    },
  };
}

function requiresSecretHeaders(remote: RegistryRemote): boolean {
  const headers = remote.headers || [];
  return headers.some((header) => !!header.isRequired || !!header.isSecret);
}

function sanitizeMcpId(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const compact = lowered.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const normalized = compact || "mcp-server";
  const withPrefix = /^[a-z]/.test(normalized)
    ? normalized
    : `mcp-${normalized}`;
  const hash = shortHash(raw);
  const base = withPrefix.slice(0, 40);
  return `${base}-${hash}`;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function isHttpUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("http://") || value.startsWith("https://"))
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dedupeById(
  candidates: DiscoveredMcpCandidate[]
): DiscoveredMcpCandidate[] {
  const seen = new Set<string>();
  const output: DiscoveredMcpCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    output.push(candidate);
  }
  return output;
}

async function fetchWithTimeout(
  input: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
