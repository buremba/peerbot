/**
 * Short-lived credential leases for connector-contributed agent tooling.
 *
 * A LEASE is a short-lived, provider-derived credential minted per deployment
 * and injected into the agent sandbox as a real env var. This does not weaken
 * the workers-never-receive-durable-credentials invariant: what the worker
 * holds expires on its own (GitHub installation tokens last ~1h) and can be
 * revoked at the provider without touching the stored connection credential,
 * which never leaves the gateway.
 *
 * Providers with no derived-token support contribute no credential. The worker
 * egress proxy raw-tunnels HTTPS CONNECT traffic, so it cannot replace an
 * opaque placeholder inside a CLI's TLS request.
 *
 * Multi-replica: minting is STATELESS per deployment. No lease is persisted and
 * no replica reads another's lease; two pods minting for the same connection
 * simply hold two independently valid tokens. Expiry is the provider's: the
 * deployment records its earliest lease expiry and the warm path recycles the
 * worker before that point, so a re-mint happens on the next turn rather than
 * mid-run. Refreshing a credential INSIDE a running sandbox is still out of
 * scope — the env var is read at process start.
 */

import { createLogger } from "@lobu/core";
import { getInstallationTokenRegistry } from "../installation/registry.js";
import {
  InstallationTokenError,
  type MintedInstallationToken,
} from "../installation/installation-token-provider.js";
import type { AppInstallationStore } from "../../lobu/stores/app-installation-store.js";

const logger = createLogger("credential-lease");

/**
 * Minimum life a lease token must have left to be reused from cache.
 *
 * Must exceed the deployment manager's recycle margin (5 min): a recycle that
 * re-mints inside the margin gets the same token back, re-records the same
 * expiry, and recycles again on the next turn.
 */
const LEASE_MIN_TTL_MS = 10 * 60_000;

/** The connection a lease is being minted for, as resolved from the database. */
export interface LeaseSubject {
  /** `connections.id`. */
  connectionId: number;
  organizationId: string;
  connectorKey: string;
  /**
   * `app_installations.id` this connection is bound to (`config.installation_ref`),
   * or null when the connection has no App-installation backing.
   */
  installationRef: number | null;
  /** The connector's `app_installation` auth method provider, e.g. `'github'`. */
  provider: string | null;
  /** Method-declared provider instance; defaults to `'cloud'` when unset. */
  providerInstance: string | null;
  /** Gateway env var NAMES for the App id / private key (never their values). */
  appIdKey: string | null;
  privateKeyKey: string | null;
}

/** Who the lease is minted for — stamped into the audit line. */
export interface LeaseScopeHints {
  agentId: string;
  deploymentName: string;
  /** The run this deployment is serving, when the caller knows it. */
  runId?: number;
}

/** A minted lease value injected into the sandbox. */
export interface CredentialLease {
  token: string;
  /**
   * When the provider says this token stops working, or null when the provider
   * does not say. The deployment records the EARLIEST expiry across its leases
   * so the warm path can redeploy before a sandbox's `gh` starts 401ing —
   * without it, a deployment that never goes idle outlives its credential.
   */
  expiresAt: Date | null;
}

/**
 * Per-provider lease minting. One implementation per credential-derivation
 * scheme; `provider` matches the connector's `app_installation` method provider.
 */
export interface CredentialLeaseProvider {
  readonly provider: string;
  /**
   * Mint a short-lived credential for `subject`, or return null when this
   * connection cannot produce one (no installation backing, inactive install,
   * provider exchange failure). Returning null is NOT an error path for the
   * caller: the env var is simply omitted and the CLI reports itself
   * unauthenticated. Never throws for an unmintable connection — a broken
   * GitHub install must not fail the whole deployment.
   */
  mint(
    subject: LeaseSubject,
    scope: LeaseScopeHints
  ): Promise<CredentialLease | null>;
}

/**
 * GitHub App installation-token lease.
 *
 * Delegates to the existing per-pod {@link getInstallationTokenRegistry} — the
 * same minting path the connector credential resolver uses — so the App private
 * key, the signed App JWT, and the `/access_tokens` exchange all stay
 * gateway-side and there is exactly one implementation of the exchange.
 *
 * Scope: GitHub's installation token carries the installation's own
 * repository/permission selection, chosen by the org admin during install. We
 * deliberately do NOT narrow further per agent here — the token API's
 * `repositories`/`permissions` narrowing needs a repo allow-list this feature
 * has no UI for yet, and silently minting a narrower token than the operator
 * granted would make `gh` fail in ways the agent cannot explain. Narrowing is
 * the follow-up that pairs with a per-agent connector-write Access matrix.
 */
export class GitHubCredentialLeaseProvider implements CredentialLeaseProvider {
  readonly provider = "github";

  constructor(private readonly installStore: AppInstallationStore) {}

  async mint(
    subject: LeaseSubject,
    scope: LeaseScopeHints
  ): Promise<CredentialLease | null> {
    if (subject.installationRef == null) {
      // Connector supports App installs but this connection isn't bound to one
      // (OAuth/PAT fallback). There is no derivable short-lived credential, and
      // handing over the stored token would breach the worker-creds invariant.
      logger.debug(
        {
          connection_id: subject.connectionId,
          agent_id: scope.agentId,
        },
        "No installation backing for connection — no lease minted"
      );
      return null;
    }

    const install = await this.installStore.getById(subject.installationRef);
    if (!install) {
      logger.warn(
        {
          connection_id: subject.connectionId,
          install_id: subject.installationRef,
        },
        "Agent-tooling lease: connection references a missing install row"
      );
      return null;
    }

    // Tenancy guard, mirroring the connector credential resolver: a connection
    // whose `installation_ref` points at ANOTHER org's install must never yield
    // that org's token. Reject before minting, never after.
    if (install.organizationId !== subject.organizationId) {
      logger.warn(
        {
          connection_id: subject.connectionId,
          install_id: install.id,
          connection_org: subject.organizationId,
          install_org: install.organizationId,
        },
        "Agent-tooling lease REJECTED: cross-tenant installation reference"
      );
      return null;
    }

    // Connector-shape guard: the install must match the connector method's
    // declared provider/instance. An omitted instance means 'cloud', not a
    // wildcard — otherwise a self-hosted GHES install would satisfy a method
    // that never opted into it.
    const expectedInstance = subject.providerInstance ?? "cloud";
    if (
      install.provider !== subject.provider ||
      install.providerInstance !== expectedInstance
    ) {
      logger.warn(
        {
          connection_id: subject.connectionId,
          install_id: install.id,
          install_provider: install.provider,
          method_provider: subject.provider,
          install_provider_instance: install.providerInstance,
          method_provider_instance: expectedInstance,
        },
        "Agent-tooling lease REJECTED: install provider/instance does not match connector method"
      );
      return null;
    }

    // Only an ACTIVE install may mint. After a cross-org transfer the loser's
    // row is demoted to 'suspended' while its connection still points at it;
    // minting from that row would hand the old org the new owner's repo access.
    if (install.status !== "active") {
      logger.warn(
        {
          connection_id: subject.connectionId,
          install_id: install.id,
          install_status: install.status,
        },
        "Agent-tooling lease REJECTED: install is not active"
      );
      return null;
    }

    // Stamp the connector method's env-var NAMES onto the row so the provider
    // reads the right gateway env vars. The row never holds the App id or key.
    const installWithKeys = {
      ...install,
      metadata: {
        ...install.metadata,
        ...(subject.appIdKey ? { appIdKey: subject.appIdKey } : {}),
        ...(subject.privateKeyKey
          ? { privateKeyKey: subject.privateKeyKey }
          : {}),
      },
    };

    let minted: MintedInstallationToken;
    try {
      minted = await getInstallationTokenRegistry().mintFor(installWithKeys, {
        // A lease is baked into a sandbox that reads its env once at startup,
        // so a cached token with a few minutes left would produce a worker
        // that is born nearly dead — and the deployment would immediately
        // recycle itself for expiry, hand back the SAME cached token, and
        // churn a cold start every turn. Demand more runway than the recycle
        // margin so a re-mint always makes progress.
        minTtlMs: LEASE_MIN_TTL_MS,
      });
    } catch (error) {
      const reason =
        error instanceof InstallationTokenError ? error.reason : "unknown";
      logger.warn(
        {
          connection_id: subject.connectionId,
          install_id: install.id,
          agent_id: scope.agentId,
          reason,
        },
        "Agent-tooling lease mint failed — sandbox will run without this credential"
      );
      return null;
    }

    // Audit line: WHO got a lease for WHICH connection under WHICH deployment.
    // The token itself is never logged.
    logger.info(
      {
        agent_id: scope.agentId,
        connection_id: subject.connectionId,
        connector_key: subject.connectorKey,
        organization_id: subject.organizationId,
        install_id: install.id,
        deployment_name: scope.deploymentName,
        run_id: scope.runId,
        expires_at: minted.expiresAt,
      },
      "Minted agent-tooling credential lease"
    );

    // Provider implementations should reject malformed expiries. Keep this
    // boundary defensive so a future provider cannot leak an Invalid Date into
    // the earliest-expiry fold.
    const expiresAtMs = Date.parse(minted.expiresAt ?? "");
    return {
      token: minted.token,
      expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs) : null,
    };
  }
}

/**
 * Per-pod registry of {@link CredentialLeaseProvider}s keyed by provider. Mirrors
 * `InstallationTokenRegistry`: the single lookup point, so the resolver never
 * branches on a provider name.
 */
export class CredentialLeaseRegistry {
  private readonly providers = new Map<string, CredentialLeaseProvider>();

  register(provider: CredentialLeaseProvider): void {
    this.providers.set(provider.provider, provider);
  }

  /**
   * Mint via the provider registered for `subject.provider`. An unregistered or
   * absent provider yields null (no lease) rather than throwing — the same
   * "credential simply absent" outcome as a failed mint.
   */
  async mintFor(
    subject: LeaseSubject,
    scope: LeaseScopeHints
  ): Promise<CredentialLease | null> {
    if (!subject.provider) return null;
    const provider = this.providers.get(subject.provider);
    if (!provider) {
      logger.debug(
        { provider: subject.provider, connection_id: subject.connectionId },
        "No CredentialLeaseProvider registered — no lease minted"
      );
      return null;
    }
    return provider.mint(subject, scope);
  }
}
