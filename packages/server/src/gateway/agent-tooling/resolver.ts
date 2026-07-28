/**
 * Connector-contributed agent tooling — deployment-time resolution.
 *
 * A connection whose connector declares `agentTooling` contributes three things
 * to the agent's sandbox: nix packages (so the CLI is on PATH), env vars (so it
 * is authenticated), and egress domains (so it can reach the provider). This
 * module turns the org's connection rows into that contribution; the deployment
 * manager applies it to the worker environment.
 *
 * The declaration is read from `connector_definitions.agent_tooling` — the
 * database, never connector code. Nothing here loads or executes a connector.
 */

import {
  createLogger,
  isValidDomainPattern,
  normalizeDomainPattern,
  parseJsonObject,
} from "@lobu/core";
import type {
  ConnectorAgentTooling,
  ConnectorAgentToolingEnv,
} from "@lobu/connector-sdk";
import { nixPackageAttrRef } from "@lobu/connector-sdk/nix-package";
import { getDb } from "../../db/client.js";
import {
  getAppInstallationAuthMethods,
  normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import type {
  CredentialLeaseRegistry,
  LeaseScopeHints,
  LeaseSubject,
} from "./credential-lease.js";

const logger = createLogger("agent-tooling-resolver");

/** The sandbox contribution of every eligible connection, already unioned. */
export interface ResolvedAgentTooling {
  /** Nix packages to union into the agent's `nixConfig.packages`. */
  packages: string[];
  /** Env vars to set in the worker environment. */
  env: Record<string, string>;
  /** Domains to grant on the worker's egress allowlist. */
  domains: string[];
}

const EMPTY: ResolvedAgentTooling = {
  packages: [],
  env: {},
  domains: [],
};

/**
 * Env var names a connector may never contribute. The deployment manager builds
 * the base worker environment first and then merges the contribution over it, so
 * an unguarded name would REPLACE gateway-owned runtime state:
 * `WORKER_TOKEN` is the signed gateway credential (a contributed one would also
 * inherit the lease exemption from placeholder injection, so the worker would
 * authenticate with an attacker-chosen token), `HTTP_PROXY`/`HTTPS_PROXY`/
 * `NO_PROXY` route egress through the filtering proxy, and `PATH`/`HOME`/
 * `WORKSPACE_DIR`/`DISPATCHER_URL`/`NODE_OPTIONS`/`BUN_OPTIONS`/`NIX_*` decide
 * what code the sandbox executes and where.
 *
 * Enforced here rather than only at the merge site so a hostile declaration
 * never reaches an env map at all.
 */
const RESERVED_ENV_NAMES = new Set([
  "WORKER_TOKEN",
  "DISPATCHER_URL",
  "WORKSPACE_DIR",
  "PATH",
  "HOME",
  "NODE_ENV",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

/**
 * True when a connector must not be allowed to set `name`. Compared
 * case-insensitively: `http_proxy` is honored by curl/git exactly like
 * `HTTP_PROXY`, so reserving only one spelling would reserve nothing.
 */
export function isReservedAgentToolingEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  // The whole NIX_ family steers package resolution for the sandbox.
  return RESERVED_ENV_NAMES.has(upper) || upper.startsWith("NIX_");
}

/** A connection row joined to its connector's declaration. */
interface ToolingConnectionRow {
  connection_id: string | number;
  connector_key: string;
  config: Record<string, unknown> | null;
  agent_tooling: unknown;
  auth_schema: unknown;
}

/**
 * Validate a persisted `agent_tooling` value. The column is jsonb written by the
 * connector install path, so it is structurally untrusted at read time — a
 * malformed declaration must contribute nothing rather than inject a
 * non-string into the worker environment or the nix command line.
 *
 * Returns null when the value carries no usable contribution.
 */
export function parseAgentTooling(value: unknown): ConnectorAgentTooling | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const packages = Array.isArray((raw.nix as Record<string, unknown>)?.packages)
    ? ((raw.nix as Record<string, unknown>).packages as unknown[]).filter(
        (pkg): pkg is string => {
          if (typeof pkg !== "string") return false;
          try {
            nixPackageAttrRef(pkg);
            return true;
          } catch {
            return false;
          }
        }
      )
    : [];

  const env: ConnectorAgentToolingEnv[] = Array.isArray(raw.env)
    ? (raw.env as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const { name, credential } = entry as Record<string, unknown>;
        if (
          typeof name !== "string" ||
          name === "__proto__" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          isReservedAgentToolingEnvName(name)
        ) {
          return [];
        }
        // 'lease' is the only tier. Anything else is dropped, not defaulted:
        // the worker egress proxy raw-tunnels HTTPS CONNECT traffic, so an
        // opaque placeholder in a CLI env var would be sent to the provider
        // verbatim — there is no relay that could swap it inside TLS. A static
        // credential tier can only exist once a credential-aware relay does.
        if (credential !== "lease") return [];
        return [{ name, credential }];
      })
    : [];

  // A domain lands straight on the worker's deny-by-default egress allowlist,
  // so it gets the same shape check the operator-facing settings API applies —
  // `"*"`, `"*.com"`, `"https://evil.com/x"` and `"a.com, b.com"` must widen
  // egress by nothing rather than by everything.
  //
  // Accepted entries are normalized to the form grants are stored and matched
  // in, so a declaration spelling it `GitHub.COM` or `*.GitHub.COM` joins the
  // existing `github.com`/`.github.com` grant instead of adding a second row
  // for the same host.
  const domains = Array.isArray(raw.domains)
    ? (raw.domains as unknown[])
        .filter(isValidDomainPattern)
        .map(normalizeDomainPattern)
    : [];

  if (packages.length === 0 && env.length === 0 && domains.length === 0) {
    return null;
  }
  return {
    ...(packages.length > 0 ? { nix: { packages } } : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  };
}

async function loadToolingConnections(
  organizationId: string
): Promise<ToolingConnectionRow[]> {
  const sql = getDb();
  return (await sql`
    SELECT c.id AS connection_id,
           c.connector_key,
           c.config,
           cd.agent_tooling,
           cd.auth_schema
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    WHERE c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
      AND c.status = 'active'
      AND cd.agent_tooling IS NOT NULL
    ORDER BY c.id
  `) as unknown as ToolingConnectionRow[];
}

/** The declaration-only half of the contribution: no credential is minted. */
export interface ResolvedAgentToolingDeclaration {
  packages: string[];
  domains: string[];
}

/**
 * Resolve the declaration-only contribution before minting a per-run worker
 * token. Credentials remain deployment-only and never enter the queue payload.
 *
 * Packages are returned alongside domains because the warm path reconciles
 * egress grants against this payload: `syncNetworkConfigGrants` derives the nix
 * binary-cache hosts from `nixConfig.packages`, so a caller that folded domains
 * but not packages would revoke the substituter hosts that the contributed
 * packages need — including out from under an in-flight first-deploy download.
 */
export async function resolveAgentToolingDeclaration(params: {
  organizationId: string;
}): Promise<ResolvedAgentToolingDeclaration> {
  const packages = new Set<string>();
  const domains = new Set<string>();
  for (const row of await loadToolingConnections(params.organizationId)) {
    const tooling = parseAgentTooling(row.agent_tooling);
    for (const pkg of tooling?.nix?.packages ?? []) packages.add(pkg);
    for (const domain of tooling?.domains ?? []) domains.add(domain);
  }
  return { packages: [...packages], domains: [...domains] };
}

/**
 * Resolve every eligible connection's sandbox contribution for one deployment.
 *
 * Eligibility (v1): every ACTIVE, non-deleted connection in the agent's org
 * whose connector declares `agent_tooling`. `connections.agent_id` is not an
 * attachment boundary for data connectors; it is the fallback agent for chat
 * connections, so it must not scope this resolver.
 *
 * Failure is always "contribute nothing": a connection whose lease cannot be
 * minted drops its env var and the deployment proceeds. A sandbox with no
 * GH_TOKEN reports itself unauthenticated; a sandbox that failed to deploy tells
 * the user nothing.
 */
export async function resolveAgentTooling(params: {
  agentId: string;
  organizationId: string;
  deploymentName: string;
  leaseRegistry: CredentialLeaseRegistry;
  runId?: number;
}): Promise<ResolvedAgentTooling> {
  const { agentId, organizationId } = params;
  const rows = await loadToolingConnections(organizationId);

  if (rows.length === 0) return EMPTY;

  const packages = new Set<string>();
  const domains = new Set<string>();
  const env: Record<string, string> = {};

  for (const row of rows) {
    const tooling = parseAgentTooling(row.agent_tooling);
    if (!tooling) {
      // Covers both a structurally malformed value and one whose every entry
      // was filtered out (an unknown credential tier, an invalid package name,
      // a domain that would have widened egress). Either way it contributes
      // nothing, and the connector key is what identifies which to go look at.
      logger.warn(
        { connector_key: row.connector_key },
        "Ignoring agent_tooling declaration with no usable contribution"
      );
      continue;
    }

    // Packages and domains are declaration-only: they describe what the CLI
    // needs to run at all, so they apply whether or not the credential resolves.
    // A `gh` on PATH that reports "not logged in" is a better failure than a
    // missing binary.
    for (const pkg of tooling.nix?.packages ?? []) packages.add(pkg);
    for (const domain of tooling.domains ?? []) domains.add(domain);

    if (!tooling.env?.length) continue;

    const connectionId = Number(row.connection_id);
    const scope: LeaseScopeHints = {
      agentId,
      deploymentName: params.deploymentName,
      runId: params.runId,
    };

    for (const entry of tooling.env) {
      // First successfully minted value wins. Two connections of the same
      // connector (e.g. two GitHub orgs) would otherwise fight over one env var
      // and the sandbox would silently use whichever sorted last.
      // Own properties only: `env` is a plain object literal, so `in` would
      // report `toString`/`constructor`/`valueOf` as already claimed before
      // anything is minted — all pass the identifier check and none is
      // reserved, so such an entry would be dropped with a bogus collision.
      if (Object.hasOwn(env, entry.name)) {
        logger.info(
          {
            env_name: entry.name,
            connector_key: row.connector_key,
            connection_id: connectionId,
          },
          "Agent-tooling env var already contributed by an earlier connection — skipping"
        );
        continue;
      }

      const subject = buildLeaseSubject(row, connectionId, organizationId);
      const lease = await params.leaseRegistry.mintFor(subject, scope);
      if (!lease) continue;
      env[entry.name] = lease.token;
    }
  }

  return {
    packages: [...packages],
    env,
    domains: [...domains],
  };
}

/**
 * Build the lease subject from a connection row: its App-installation binding
 * (`config.installation_ref`) plus the connector method's declared provider and
 * gateway env-var NAMES. Never reads a credential.
 */
function buildLeaseSubject(
  row: ToolingConnectionRow,
  connectionId: number,
  organizationId: string
): LeaseSubject {
  const config = parseJsonObject(row.config);
  const rawRef = config.installation_ref;
  const parsedRef =
    typeof rawRef === "number"
      ? rawRef
      : typeof rawRef === "string" && rawRef.trim()
        ? Number(rawRef)
        : null;
  const installationRef =
    parsedRef != null && Number.isFinite(parsedRef) ? parsedRef : null;

  const method = getAppInstallationAuthMethods(
    normalizeConnectorAuthSchema(row.auth_schema)
  )[0];

  return {
    connectionId,
    organizationId,
    connectorKey: row.connector_key,
    installationRef,
    provider: method?.provider ?? null,
    providerInstance: method?.providerInstance ?? null,
    appIdKey: method?.appIdKey ?? null,
    privateKeyKey: method?.privateKeyKey ?? null,
  };
}
