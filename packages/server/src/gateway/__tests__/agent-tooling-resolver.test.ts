/**
 * Connector-contributed agent tooling, end to end over a real database:
 * a connection whose connector declares `agentTooling` puts its CLI on the
 * agent's PATH, its leased credential in the sandbox env, and its hosts on the
 * egress allowlist — and NEVER puts the stored durable credential anywhere the
 * worker can read.
 *
 * The GitHub `/access_tokens` exchange is mocked at the `fetchImpl` seam of the
 * real provider, so no request reaches api.github.com while the App JWT signing
 * + install resolution + registry wiring all run for real.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type MessagePayload,
  verifyEgressProxyToken,
  verifyWorkerToken,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import {
  CredentialLeaseRegistry,
  GitHubCredentialLeaseProvider,
} from "../agent-tooling/credential-lease.js";
import {
  resolveAgentTooling,
  resolveAgentToolingDeclaration,
} from "../agent-tooling/resolver.js";
import { GitHubInstallationTokenProvider } from "../installation/github-installation-token-provider.js";
import { InMemoryInstallationTokenCache } from "../installation/installation-token-provider.js";
import {
  __resetInstallationTokenRegistryForTests,
  getInstallationTokenRegistry,
} from "../installation/registry.js";
import {
  type DeploymentInfo,
  DeploymentManager,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import { GrantStore } from "../permissions/grant-store.js";
import { PolicyStore } from "../permissions/policy-store.js";
import type { SecretRef, WritableSecretStore } from "../secrets/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "test-org";
const AGENT = "agent-1";
const TENANT = "44556677";
const APP_ID = "lobu-app";
const MINTED_TOKEN = "ghs_minted_installation_token";
/**
 * The DURABLE credential stored on the connection. The invariant test asserts
 * this string never reaches the worker environment under any key.
 */
const STORED_DURABLE_SECRET = "ghp_durable_stored_pat_never_leaks";

const GITHUB_AGENT_TOOLING = {
  nix: { packages: ["gh"] },
  env: [{ name: "GH_TOKEN", credential: "lease" }],
  domains: ["api.github.com", "github.com"],
};

const GITHUB_AUTH_SCHEMA = {
  methods: [
    {
      type: "app_installation",
      provider: "github",
      providerInstance: "cloud",
      appIdKey: "TEST_GH_APP_ID",
      privateKeyKey: "TEST_GH_APP_KEY",
    },
  ],
};

/** Minimal writable secret store so placeholder injection actually runs. */
class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<string, string>();

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith("host://")) return null;
    return this.entries.get(decodeURIComponent(ref.slice("host://".length))) ?? null;
  }

  async put(name: string, value: string): Promise<SecretRef> {
    this.entries.set(name, value);
    return `host://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    this.entries.delete(
      nameOrRef.startsWith("host://")
        ? decodeURIComponent(nameOrRef.slice("host://".length))
        : nameOrRef
    );
  }

  async list(): Promise<never[]> {
    return [];
  }
}

/** Minimal concrete subclass — the base class is abstract over orchestration. */
class TestDeploymentManager extends DeploymentManager {
  async listDeployments(): Promise<DeploymentInfo[]> {
    return [];
  }
  protected async spawnDeployment(): Promise<void> {}
  async scaleDeployment(): Promise<void> {}
  async deleteDeployment(): Promise<void> {}
  async updateDeploymentActivity(): Promise<void> {}
  async validateWorkerImage(): Promise<void> {}
  protected getDispatcherHost(): string {
    return "localhost";
  }
  /** Expose the protected env assembly under test. */
  buildEnv(messageData: MessagePayload): Promise<Record<string, string>> {
    return this.generateEnvironmentVariables(
      "user",
      "user-1",
      "deploy-1",
      messageData
    );
  }
}

const TEST_CONFIG: OrchestratorConfig = {
  queues: { retryLimit: 3, retryDelay: 5, expireInSeconds: 300 },
  worker: { idleCleanupMinutes: 30, maxDeployments: 10 },
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

function buildPayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    userId: "u",
    conversationId: "c",
    messageId: "m",
    channelId: "ch",
    teamId: "t",
    agentId: AGENT,
    organizationId: ORG,
    botId: "b",
    platform: "slack",
    messageText: "hi",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  };
}

/** Seed a connector_definitions row, optionally carrying an agent_tooling declaration. */
async function seedConnectorDef(params: {
  key: string;
  agentTooling?: unknown;
  authSchema?: unknown;
  organizationId?: string;
  status?: string;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, auth_schema, agent_tooling, status
    ) VALUES (
      ${params.organizationId ?? ORG}, ${params.key}, ${params.key}, '1.0.0',
      ${params.authSchema ? sql.json(params.authSchema) : null},
      ${params.agentTooling ? sql.json(params.agentTooling) : null},
      ${params.status ?? "active"}
    )
  `;
}

/** Seed an active app installation and return its id. */
async function seedInstall(organizationId = ORG, tenant = TENANT): Promise<number> {
  const row = await createPostgresAppInstallationStore().upsert({
    organizationId,
    provider: "github",
    providerInstance: "cloud",
    providerAppId: APP_ID,
    externalTenantId: tenant,
    status: "active",
    metadata: {},
  });
  return row.id;
}

/** Seed a connection row; returns its id. */
async function seedConnection(params: {
  connectorKey: string;
  installationRef?: number | null;
  agentId?: string | null;
  status?: string;
  organizationId?: string;
  credentials?: Record<string, unknown>;
  authProfileId?: number;
  deleted?: boolean;
  slug?: string;
}): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, status, agent_id, config,
      credentials, auth_profile_id, deleted_at
    ) VALUES (
      ${params.organizationId ?? ORG}, ${params.connectorKey},
      ${params.slug ?? `conn-${params.connectorKey}-${Math.random().toString(36).slice(2)}`},
      ${params.status ?? "active"}, ${params.agentId ?? null},
      ${sql.json(
        params.installationRef != null
          ? { installation_ref: params.installationRef }
          : {}
      )},
      ${params.credentials ? sql.json(params.credentials) : null},
      ${params.authProfileId ?? null},
      ${params.deleted ? new Date() : null}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function seedEnvAuthProfile(params: {
  connectorKey: string;
  authData: Record<string, string>;
}): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO auth_profiles (
      organization_id, connector_key, slug, display_name,
      profile_kind, status, auth_data
    ) VALUES (
      ${ORG}, ${params.connectorKey}, ${`tooling-${params.connectorKey}`},
      ${`Tooling ${params.connectorKey}`}, 'env', 'active',
      ${sql.json(params.authData)}
    )
    RETURNING id
  `;
  return Number(row.id);
}

/**
 * A lease registry whose GitHub provider mints through the REAL installation
 * token provider, with only the provider's HTTP exchange mocked.
 */
function buildLeaseRegistry(options?: {
  respond?: () => Response;
}): CredentialLeaseRegistry {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  __resetInstallationTokenRegistryForTests();
  getInstallationTokenRegistry().register(
    new GitHubInstallationTokenProvider({
      env: { TEST_GH_APP_ID: "12345", TEST_GH_APP_KEY: privateKeyPem },
      cache: new InMemoryInstallationTokenCache(),
      fetchImpl: (async () =>
        options?.respond?.() ??
        new Response(
          JSON.stringify({
            token: MINTED_TOKEN,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as unknown as typeof fetch,
    })
  );

  const registry = new CredentialLeaseRegistry();
  registry.register(
    new GitHubCredentialLeaseProvider(createPostgresAppInstallationStore())
  );
  return registry;
}

function resolve(params: {
  registry: CredentialLeaseRegistry;
  agentId?: string;
  organizationId?: string;
}) {
  return resolveAgentTooling({
    agentId: params.agentId ?? AGENT,
    organizationId: params.organizationId ?? ORG,
    deploymentName: "deploy-1",
    leaseRegistry: params.registry,
  });
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  await seedAgentRow(AGENT);
});

afterEach(() => {
  __resetInstallationTokenRegistryForTests();
});

describe("resolveAgentTooling", () => {
  test("a GitHub connection contributes gh, a leased GH_TOKEN, and its domains", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(resolved.domains).toEqual(["api.github.com", "github.com"]);
    // The declaration-only resolver (the queue path) must carry BOTH halves.
    // Domains alone would let the warm-path grant reconcile revoke the nix
    // binary-cache hosts that the contributed packages depend on.
    expect(
      await resolveAgentToolingDeclaration({
        organizationId: ORG,
      })
    ).toEqual({
      packages: ["gh"],
      domains: ["api.github.com", "github.com"],
    });
  });

  test("a connector that declares no agentTooling contributes nothing", async () => {
    await seedConnectorDef({ key: "linear" });
    await seedConnection({ connectorKey: "linear" });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual([]);
    expect(resolved.env).toEqual({});
    expect(resolved.domains).toEqual([]);
  });

  test("packages and domains still apply when the lease cannot be minted", async () => {
    // No installation backing: the CLI belongs on PATH regardless, so the agent
    // gets a `gh` that reports itself unauthenticated rather than a missing binary.
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: null });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.domains).toEqual(["api.github.com", "github.com"]);
    expect(resolved.env.GH_TOKEN).toBeUndefined();
  });

  test("a failed provider exchange drops the credential without failing resolution", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({
      registry: buildLeaseRegistry({
        respond: () => new Response("suspended", { status: 404 }),
      }),
    });

    expect(resolved.env.GH_TOKEN).toBeUndefined();
    expect(resolved.packages).toEqual(["gh"]);
  });

  test("the chat fallback agent does not scope an org connection's tooling", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedAgentRow("agent-2");
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      agentId: "agent-2",
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
  });

  test("a paused or soft-deleted connection contributes nothing", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      status: "paused",
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      deleted: true,
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual([]);
    expect(resolved.env).toEqual({});
  });

  test("another org's connection never contributes to this org's agent", async () => {
    await seedAgentRow(AGENT, { organizationId: "org-b" });
    const otherInstall = await seedInstall("org-b", "99887766");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      organizationId: "org-b",
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: otherInstall,
      organizationId: "org-b",
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env).toEqual({});
    expect(resolved.packages).toEqual([]);
  });

  test("a cross-tenant installation_ref is rejected without minting", async () => {
    // org-b owns the install; this org's connection points at it anyway.
    await seedAgentRow("agent-b", { organizationId: "org-b" });
    const foreignInstall = await seedInstall("org-b", "12121212");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: foreignInstall,
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBeUndefined();
  });

  test("a suspended install does not mint", async () => {
    const installId = await seedInstall();
    await getDb()`
      UPDATE app_installations SET status = 'suspended' WHERE id = ${installId}
    `;
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBeUndefined();
  });

  test("two connections of one connector do not fight over the env var", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      slug: "conn-a",
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      slug: "conn-b",
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(resolved.packages).toEqual(["gh"]);
  });
});

describe("deployment env assembly", () => {
  let manager: TestDeploymentManager;

  beforeEach(async () => {
    manager = new TestDeploymentManager(TEST_CONFIG);
    manager.setGrantStore(new GrantStore());
    manager.setPolicyStore(new PolicyStore());
  });

  test("the sandbox env carries the lease and nix packages include gh", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(env.NIX_PACKAGES?.split(",")).toContain("gh");
    const proxyToken = decodeURIComponent(
      new URL(env.HTTP_PROXY ?? "").password
    );
    expect(verifyEgressProxyToken(proxyToken)).not.toBeNull();
    expect(verifyWorkerToken(proxyToken)).toBeNull();
  });

  test("contributed nix packages union with the agent's own, never replace them", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(
      buildPayload({ nixConfig: { packages: ["ripgrep"] } })
    );

    expect(env.NIX_PACKAGES?.split(",").sort()).toEqual(["gh", "ripgrep"]);
  });

  test("contributed domains are granted on the worker's egress allowlist", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const grantStore = new GrantStore();
    manager.setGrantStore(grantStore);
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    expect(await grantStore.hasGrant(AGENT, "api.github.com", ORG)).toBe(true);
    expect(await grantStore.hasGrant(AGENT, "github.com", ORG)).toBe(true);
    expect(verifyWorkerToken(env.WORKER_TOKEN)?.allowedDomains).toEqual([
      "api.github.com",
      "github.com",
    ]);
  });

  test("REGRESSION: the warm-path reconcile keeps the nix cache hosts a contributed package needs", async () => {
    // The warm path (existing thread) re-runs syncNetworkConfigGrants against
    // the QUEUE payload, which is built by the consumer — not by buildEnv. That
    // reconcile derives the nix binary-cache hosts from nixConfig.packages and
    // unconditionally revokes anything not in the expected set. So if the
    // consumer folds contributed domains but NOT contributed packages, the
    // second message of a conversation revokes cache.nixos.org — potentially
    // out from under an in-flight first-deploy download of that very package.
    //
    // Mutation check: drop the `contribution.packages` fold in message-consumer
    // and this test fails on the cache.nixos.org assertion.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const grantStore = new GrantStore();
    manager.setGrantStore(grantStore);
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    // Cold create: grants the connector domains AND the nix cache hosts.
    await manager.buildEnv(buildPayload());
    expect(await grantStore.hasGrant(AGENT, "cache.nixos.org", ORG)).toBe(true);

    // Warm path: the agent declares no nix packages of its own, so the cache
    // hosts survive only if the consumer folded the contributed package.
    const contribution = await resolveAgentToolingDeclaration({
      organizationId: ORG,
    });
    await manager.syncNetworkConfigGrants({
      ...buildPayload(),
      networkConfig: { allowedDomains: contribution.domains },
      nixConfig: { packages: contribution.packages },
    });

    expect(await grantStore.hasGrant(AGENT, "cache.nixos.org", ORG)).toBe(true);
    expect(await grantStore.hasGrant(AGENT, "api.github.com", ORG)).toBe(true);
  });

  test("a lease env var survives secret-placeholder injection", async () => {
    // GH_TOKEN matches the _TOKEN secret heuristic, so without recognizing the
    // already-materialized lease it would be swapped for a proxy placeholder.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());
    manager.setSecretStore(new InMemoryWritableStore());

    const env = await manager.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(env.GH_TOKEN).not.toContain("lobu_secret_");
    expect(env.GH_TOKEN).not.toBe("lobu-proxy");
  });

  test("an operator override of a lease-named env var is still protected", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const withOverride = new TestDeploymentManager({
      ...TEST_CONFIG,
      worker: { ...TEST_CONFIG.worker, env: { GH_TOKEN: STORED_DURABLE_SECRET } },
    });
    withOverride.setGrantStore(new GrantStore());
    withOverride.setPolicyStore(new PolicyStore());
    withOverride.setCredentialLeaseRegistry(buildLeaseRegistry());
    withOverride.setSecretStore(new InMemoryWritableStore());

    const env = await withOverride.buildEnv(buildPayload());

    expect(env.GH_TOKEN).not.toBe(STORED_DURABLE_SECRET);
    expect(env.GH_TOKEN).toContain("lobu_secret_");
  });

  test("a NON-lease secret alongside a lease is still swapped for a placeholder", async () => {
    // Proves the exemption is scoped to lease vars rather than being a blanket
    // disable of placeholder injection: the sibling secret must still be swapped.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const withSecret = new TestDeploymentManager({
      ...TEST_CONFIG,
      worker: { ...TEST_CONFIG.worker, env: { SOME_API_TOKEN: "durable-value" } },
    });
    withSecret.setGrantStore(new GrantStore());
    withSecret.setPolicyStore(new PolicyStore());
    withSecret.setCredentialLeaseRegistry(buildLeaseRegistry());
    withSecret.setSecretStore(new InMemoryWritableStore());

    const env = await withSecret.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(env.SOME_API_TOKEN).not.toBe("durable-value");
    expect(env.SOME_API_TOKEN).toContain("lobu_secret_");
  });

  test("a retired placeholder-tier declaration contributes no env var at all", async () => {
    // The egress proxy raw-tunnels HTTPS CONNECT, so a placeholder in a CLI
    // env var would be sent to the provider verbatim. The tier was removed:
    // a persisted declaration still using it must contribute nothing — and
    // in particular must never fall back to the stored durable credential.
    const connectorKey = "placeholder-probe";
    await seedConnectorDef({
      key: connectorKey,
      agentTooling: {
        env: [{ name: "API_TOKEN", credential: "placeholder" }],
      },
    });
    const authProfileId = await seedEnvAuthProfile({
      connectorKey,
      authData: { API_TOKEN: STORED_DURABLE_SECRET },
    });
    await seedConnection({ connectorKey, authProfileId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());
    manager.setSecretStore(new InMemoryWritableStore());

    const env = await manager.buildEnv(buildPayload());

    expect(env.API_TOKEN).toBeUndefined();
    for (const [key, value] of Object.entries(env)) {
      expect(`${key}=${value}`).not.toContain(STORED_DURABLE_SECRET);
    }
  });

  test("INVARIANT: the connection's stored durable credential never reaches the worker env", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      credentials: { access_token: STORED_DURABLE_SECRET },
    });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    // The worker gets the ephemeral lease...
    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    // ...and the durable stored credential appears under NO key at all.
    for (const [key, value] of Object.entries(env)) {
      expect(`${key}=${value}`).not.toContain(STORED_DURABLE_SECRET);
    }
  });

  test("INVARIANT: a hostile declaration cannot hijack the signed worker token or PATH", async () => {
    // The contribution is merged OVER the already-built base env, so an
    // unguarded reserved name would REPLACE gateway-owned runtime state — and a
    // contributed WORKER_TOKEN would additionally inherit the lease exemption
    // from placeholder injection, leaving the worker authenticating with a
    // connector-chosen token.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: {
        ...GITHUB_AGENT_TOOLING,
        env: [
          { name: "WORKER_TOKEN", credential: "lease" },
          { name: "PATH", credential: "lease" },
          { name: "HTTPS_PROXY", credential: "lease" },
          { name: "GH_TOKEN", credential: "lease" },
        ],
      },
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    // The legitimate contribution still lands...
    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    // ...while every reserved name keeps its gateway-owned value.
    expect(env.WORKER_TOKEN).not.toBe(MINTED_TOKEN);
    expect(env.PATH).not.toBe(MINTED_TOKEN);
    expect(env.HTTPS_PROXY).not.toBe(MINTED_TOKEN);
    // The worker token must still verify as a token the GATEWAY signed.
    expect(verifyWorkerToken(env.WORKER_TOKEN)).toBeTruthy();
  });

  test("no declaring connection leaves the env and nix config untouched", async () => {
    await seedConnectorDef({ key: "linear" });
    await seedConnection({ connectorKey: "linear" });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.NIX_PACKAGES).toBeUndefined();
  });
});
