import { apiBaseFromContextUrl } from "../../../internal/api-client.js";
import {
  DEFAULT_CONTEXT_NAME,
  loadContextConfig,
} from "../../../internal/context.js";
import { getContextToken } from "../../../internal/credentials.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import { ApplyClient, type RemoteConnectorDefinition } from "./client.js";
import type { DesiredState } from "./desired-state.js";

type CatalogLoader = (
  organizationSlug: string
) => Promise<RemoteConnectorDefinition[]>;

function managedOrganization(
  connection: DesiredState["connectors"]["connections"][number]
): string | null {
  const raw = connection.config?.managedBy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const organization = (raw as Record<string, unknown>).org;
  return typeof organization === "string" && organization.trim()
    ? organization.trim()
    : null;
}

function mcpUpstreamUrl(definition: RemoteConnectorDefinition): string | null {
  const raw = definition.mcp_config?.upstream_url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function buildManagedMcpConnectorSource(
  definition: RemoteConnectorDefinition
): string {
  const upstreamUrl = mcpUpstreamUrl(definition);
  if (!upstreamUrl) {
    throw new ValidationError(
      `Managed connector "${definition.key}" has no valid HTTPS MCP upstream URL.`
    );
  }
  const spec = {
    key: definition.key,
    name: definition.name ?? definition.key,
    version: definition.version ?? "0.0.0",
    authSchema: definition.auth_schema ?? null,
    // Preserve the catalog's canonical snake-case proxy config, including its
    // operation prefix. The connector compiler persists metadata verbatim.
    mcpConfig: {
      ...definition.mcp_config,
      upstream_url: upstreamUrl,
    },
  };
  return [
    'import { defineConnector } from "@lobu/connector-sdk";',
    `export default defineConnector(${JSON.stringify(spec)} as never);`,
    "",
  ].join("\n");
}

/**
 * Add installable definitions for managed MCP connections that a local Lobu
 * catalog does not know. The authenticated Cloud org remains the source of
 * truth; only its non-secret connector manifest crosses into the install plan.
 */
export async function hydrateManagedConnectorCatalog(
  state: DesiredState,
  localCatalog: RemoteConnectorDefinition[],
  loadCatalog: CatalogLoader
): Promise<RemoteConnectorDefinition[]> {
  const localByKey = new Map(
    localCatalog.map((definition) => [definition.key, definition])
  );
  const locallyDeclared = new Set<string>();
  for (const definition of state.connectors.definitions) {
    if (definition.key) locallyDeclared.add(definition.key);
    if (definition.declaredKeyHint) {
      locallyDeclared.add(definition.declaredKeyHint);
    }
  }

  const requested = new Map<string, Map<string, string[]>>();
  for (const connection of state.connectors.connections) {
    const organization = managedOrganization(connection);
    if (!organization || locallyDeclared.has(connection.connector)) continue;
    const localDefinition = localByKey.get(connection.connector);
    const needsManagedDefinition =
      !localDefinition ||
      (!localDefinition.source_uri && Boolean(localDefinition.mcp_config));
    if (!needsManagedDefinition) continue;
    const byConnector =
      requested.get(organization) ?? new Map<string, string[]>();
    const connectionSlugs = byConnector.get(connection.connector) ?? [];
    connectionSlugs.push(connection.slug);
    byConnector.set(connection.connector, connectionSlugs);
    requested.set(organization, byConnector);
  }
  if (requested.size === 0) return localCatalog;

  const additions = new Map<string, RemoteConnectorDefinition>();
  const desiredSources = new Map<string, string>();
  for (const [organization, byConnector] of requested) {
    let cloudCatalog: RemoteConnectorDefinition[];
    try {
      cloudCatalog = await loadCatalog(organization);
    } catch (error) {
      const connectors = [...byConnector.keys()].sort().join(", ");
      throw new ValidationError(
        `Could not read managed connector${byConnector.size === 1 ? "" : "s"} ${connectors} from Cloud org "${organization}": ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const cloudByKey = new Map(cloudCatalog.map((item) => [item.key, item]));
    for (const [connectorKey, connectionSlugs] of byConnector) {
      const cloudDefinition = cloudByKey.get(connectorKey);
      const upstreamUrl = cloudDefinition
        ? mcpUpstreamUrl(cloudDefinition)
        : null;
      if (!cloudDefinition || !upstreamUrl) {
        throw new ValidationError(
          `Managed connection${connectionSlugs.length === 1 ? "" : "s"} ${connectionSlugs.map((slug) => `"${slug}"`).join(", ")} reference${connectionSlugs.length === 1 ? "s" : ""} connector "${connectorKey}", but Cloud org "${organization}" does not expose an installed HTTPS MCP definition for it.`
        );
      }

      const managedMcpSource = buildManagedMcpConnectorSource(cloudDefinition);
      const priorSource = desiredSources.get(connectorKey);
      if (priorSource && priorSource !== managedMcpSource) {
        throw new ValidationError(
          `Managed connector "${connectorKey}" resolves to different definitions across Cloud orgs; one local connector key cannot safely represent both.`
        );
      }
      desiredSources.set(connectorKey, managedMcpSource);
      const { id: _cloudId, ...portableDefinition } = cloudDefinition;
      const localDefinition = localByKey.get(connectorKey);
      const localSource = localDefinition
        ? buildManagedMcpConnectorSource(localDefinition)
        : null;
      const needsSync =
        !localDefinition?.installed || localSource !== managedMcpSource;
      additions.set(connectorKey, {
        ...(localDefinition ?? {}),
        ...portableDefinition,
        // The local row contributes only target-local identity/state. Cloud is
        // authoritative for every portable manifest field, including version.
        ...(localDefinition?.id !== undefined
          ? { id: localDefinition.id }
          : {}),
        installed: localDefinition?.installed ?? false,
        installable: true,
        catalog_origin: "managed",
        source_uri: localDefinition?.source_uri ?? null,
        ...(needsSync ? { managed_mcp_source: managedMcpSource } : {}),
      });
    }
  }

  const remaining = new Map(additions);
  const merged = localCatalog.map((definition) => {
    const replacement = remaining.get(definition.key);
    if (!replacement) return definition;
    remaining.delete(definition.key);
    return replacement;
  });
  return [...merged, ...remaining.values()];
}

/** Read a managed org's catalog with its Cloud context credential, never local auth. */
export async function loadManagedCloudConnectorCatalog(
  organizationSlug: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteConnectorDefinition[]> {
  const contextName =
    process.env.LOBU_CLOUD_CONTEXT?.trim() || DEFAULT_CONTEXT_NAME;
  let contextError: unknown;
  let contextAuth: { apiBaseUrl: string; token: string } | null = null;
  try {
    const config = await loadContextConfig();
    const context = config.contexts[contextName];
    if (!context) throw new Error(`Unknown context "${contextName}"`);
    const token = await getContextToken(contextName);
    if (token) {
      contextAuth = {
        apiBaseUrl: apiBaseFromContextUrl(context.url),
        token,
      };
    }
  } catch (error) {
    contextError = error;
  }
  if (contextAuth) {
    return new ApplyClient(
      { ...contextAuth, orgSlug: organizationSlug },
      fetchImpl
    ).listConnectors(true);
  }

  const envToken = process.env.LOBU_CLOUD_PAT?.trim();
  const envUrl = process.env.LOBU_CLOUD_URL?.trim();
  if (envToken && envUrl) {
    return new ApplyClient(
      {
        apiBaseUrl: apiBaseFromContextUrl(envUrl),
        orgSlug: organizationSlug,
        token: envToken,
      },
      fetchImpl
    ).listConnectors(true);
  }

  const detail =
    contextError instanceof Error ? ` (${contextError.message})` : "";
  throw new ValidationError(
    `No Lobu Cloud login is available for context "${contextName}"${detail}. Run \`lobu login --context ${contextName}\`, or configure both LOBU_CLOUD_PAT and LOBU_CLOUD_URL.`
  );
}

export async function isManagedCloudTarget(
  apiBaseUrl: string
): Promise<boolean> {
  const contextName =
    process.env.LOBU_CLOUD_CONTEXT?.trim() || DEFAULT_CONTEXT_NAME;
  const candidates: string[] = [];
  const config = await loadContextConfig().catch(() => null);
  const contextUrl = config?.contexts[contextName]?.url;
  if (contextUrl) candidates.push(contextUrl);
  const envUrl = process.env.LOBU_CLOUD_URL?.trim();
  if (envUrl) candidates.push(envUrl);

  let target: string;
  try {
    target = apiBaseFromContextUrl(apiBaseUrl);
  } catch {
    return false;
  }
  return candidates.some((candidate) => {
    try {
      return apiBaseFromContextUrl(candidate) === target;
    } catch {
      return false;
    }
  });
}
