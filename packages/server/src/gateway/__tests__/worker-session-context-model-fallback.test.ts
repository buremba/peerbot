import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
} from "@lobu/core";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { getDb } from "../../db/client.js";
import {
  createInferenceProvider,
  getOrgDefaultModel,
  listInferenceProviders,
  setInferenceProviderDefault,
  updateInferenceProviderCapabilities,
} from "../../lobu/stores/provider-secrets.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import { ProviderCatalogService } from "../auth/provider-catalog.js";
import { WorkerGateway } from "../gateway/index.js";

// createInferenceProvider encrypts the org key and ProviderCatalogService later
// decrypts it, so each test owns the process-wide env value and cached key.
const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let savedEncryptionKey: string | undefined;

/**
 * E2E of the two worker model-delivery channels against the REAL DB, proving
 * the layered fallback (behavior → agent → org default) reaches a worker.
 *
 * - Channel 1 (`agentOptions.model` → worker rawOptions.model): built at
 *   enqueue by `resolveAgentOptions`, which calls the real `getOrgDefaultModel`
 *   DB reader. This carries the model REGARDLESS of installed providers.
 * - Channel 2 (`providerConfig.defaultModel` at `/session-context`): resolved
 *   from `composeEffectiveModelRef`, but only SURFACES a `defaultModel` when the
 *   agent has a routable installed/synthesized provider (empty catalog → `{}`).
 *   With no ProviderCatalogService wired, the endpoint returns no defaultModel —
 *   the accurate contract we assert here.
 */
const ORG = "org-worker-ctx-fallback";
const AGENT = "agent-worker-ctx";

function buildGatewayNoCatalog(getSettings: () => Promise<any>): WorkerGateway {
  return new WorkerGateway(
    { send: async () => undefined } as any,
    "https://gateway.example.com",
    { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
    {
      getSessionContext: async () => ({
        agentInstructions: "",
        platformInstructions: "",
        networkInstructions: "",
        skillsInstructions: "",
        mcpStatus: [],
      }),
    } as any,
    undefined,
    undefined, // no ProviderCatalogService → resolveProviderConfig returns {}
    { getSettings } as any
  );
}

async function sessionContextModel(
  gateway: WorkerGateway,
  opts: { agentId?: string; organizationId?: string } = {}
): Promise<string | undefined> {
  const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
    channelId: "channel-1",
    agentId: opts.agentId ?? AGENT,
    // organizationId omitted when opts.organizationId is explicitly undefined.
    ...("organizationId" in opts
      ? opts.organizationId
        ? { organizationId: opts.organizationId }
        : {}
      : { organizationId: ORG }),
  });
  const res = await gateway.getApp().request("/session-context", {
    headers: { authorization: `Bearer ${token}`, host: "gateway.example.com" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    providerConfig?: { defaultModel?: string };
  };
  return body.providerConfig?.defaultModel;
}

/**
 * Full providerConfig from /session-context. `sessionContextModel` above reads
 * only `defaultModel`; CTA attribution needs the provider fields too.
 */
async function sessionContextProviderConfig(gateway: WorkerGateway): Promise<{
  defaultProvider?: string;
  defaultProviderServesModel?: boolean;
}> {
  const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
    channelId: "channel-1",
    agentId: AGENT,
    organizationId: ORG,
  });
  const res = await gateway.getApp().request("/session-context", {
    headers: { authorization: `Bearer ${token}`, host: "gateway.example.com" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    providerConfig?: {
      defaultProvider?: string;
      defaultProviderServesModel?: boolean;
    };
  };
  return body.providerConfig ?? {};
}

describe("worker model fallback (real DB, both channels)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    savedEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    await resetTestDatabase();
    // Seed a bare model id under slug "openai"; getOrgDefaultModel prefixes it
    // to the routable "openai/gpt-5". (The slug must match the model's intended
    // provider prefix — a bare id gets `${slug}/` prepended.)
    await createInferenceProvider({
      organizationId: ORG,
      slug: "openai",
      kind: "openai",
      apiKey: "sk-e2e",
      capabilities: { text: { model: "gpt-5" } },
    });
    await setInferenceProviderDefault(ORG, "openai");
  }, 60_000);

  afterEach(() => {
    if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedEncryptionKey;
    __resetEncryptionKeyCacheForTests();
  });

  test("org default is readable via the real DB reader", async () => {
    expect(await getOrgDefaultModel(ORG)).toBe("openai/gpt-5");
  });

  test("Channel 1: agent with no models → org default in agentOptions.model", async () => {
    const store = {
      getSettings: async () => ({ models: undefined }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBe("openai/gpt-5");
  });

  test("Channel 1: agent models[0] wins over org default", async () => {
    const store = {
      getSettings: async () => ({ models: ["claude/claude-sonnet-4-6"] }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBe("claude/claude-sonnet-4-6");
  });

  test("Channel 1: behavior override wins over both agent and org", async () => {
    const store = {
      getSettings: async () => ({ models: ["claude/claude-sonnet-4-6"] }),
    } as any;
    const opts = await resolveAgentOptions(
      AGENT,
      { model: "groq/llama-3.3" },
      store,
      ORG
    );
    expect(opts.model).toBe("groq/llama-3.3");
  });

  test("Channel 1: nothing anywhere → no model (worker throws)", async () => {
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    const store = {
      getSettings: async () => ({ models: undefined }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBeUndefined();
  });

  test("Channel 2: /session-context returns no defaultModel without a routable provider catalog", async () => {
    const gateway = buildGatewayNoCatalog(async () => ({
      models: ["claude/claude-sonnet-4-6"],
    }));
    // Accurate contract: with no ProviderCatalogService, Channel 2 surfaces no
    // defaultModel (the worker uses Channel 1's agentOptions.model instead).
    expect(await sessionContextModel(gateway)).toBeUndefined();
  });

  test("#2(b): a SENTINEL default publishes NO defaultModel via /session-context (fails closed)", async () => {
    // The agent's only model is a restriction sentinel. Even though the org has
    // a credentialed provider that session-context WOULD fall back to, a sentinel
    // must never be published as defaultModel nor cause a credentialed-module
    // fallback — the worker must get "no routable model", not "__unresolved__".
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    await createInferenceProvider({
      organizationId: ORG,
      slug: "byo",
      kind: "openai",
      apiKey: "sk-byo",
      capabilities: {
        text: { base_url: "https://api.byo.example.com", model: "byo-model" },
      },
    });
    await setInferenceProviderDefault(ORG, "byo");

    const catalog = new ProviderCatalogService(
      { getSettings: async () => ({ models: ["byo/__unresolved__"] }) } as any,
      {} as any,
      (org: string) => listInferenceProviders(org),
    );
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      catalog,
      { getSettings: async () => ({ models: ["byo/__unresolved__"] }) } as any,
    );

    // Fails closed: no defaultModel published (never "byo/__unresolved__", and
    // no silent fallback to the credentialed byo module).
    expect(await sessionContextModel(gateway)).toBeUndefined();
  });

  test("#3 mixed-list: a SENTINEL-first list publishes the first REAL routable ref via /session-context", async () => {
    // models=["chatgpt/__unresolved__","byo2/byo2-model"]. models[0] is a
    // sentinel, but session-context must resolve the later real+routable ref
    // (byo2, a credentialed custom-upstream org provider) — NOT return {} — so
    // the OpenAI-compatible byo2 module + its default reach the worker.
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    await createInferenceProvider({
      organizationId: ORG,
      slug: "byo2",
      kind: "openai",
      apiKey: "sk-byo2",
      capabilities: {
        text: { base_url: "https://api.byo2.example.com", model: "byo2-model" },
      },
    });
    await setInferenceProviderDefault(ORG, "byo2");

    const settings = {
      getSettings: async () => ({
        models: ["chatgpt/__unresolved__", "byo2/byo2-model"],
      }),
    } as any;
    const catalog = new ProviderCatalogService(
      settings,
      { getBestProfile: async () => null } as any,
      (org: string) => listInferenceProviders(org),
      // registerUpstream: make the synthesized byo2 slug routable on this pod.
      () => {},
    );
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      catalog,
      settings,
    );

    // The real routable ref is published — NOT undefined, NOT the sentinel.
    expect(await sessionContextModel(gateway)).toBe("byo2/byo2-model");
  });

  test("CTA attribution: a model-MATCHED provider publishes defaultProviderServesModel=true", async () => {
    // `defaultProviderServesModel` tells the worker whether the published
    // `defaultProvider` was MATCHED to the model (findProviderForModel) or
    // merely picked by the credentialed-fallback scan. The worker gates failure
    // CTA attribution on it: true means this provider genuinely serves the ref,
    // so the CTA stays here even when the model's prefix names some OTHER
    // installed provider (OpenRouter's "openai/gpt-4o" vendor namespace).
    //
    // NOTE on the false branch: no fixture here reaches it, and that appears to
    // be by design rather than a coverage gap. `resolveDispatchModel` fails
    // closed — an unroutable ref is either replaced by the first routable one
    // or resolves to undefined, in which case resolveProviderConfig returns {}
    // and publishes NO provider at all. So via /session-context the gateway
    // does not appear to publish a defaultProvider that fails to serve its
    // model. The worker still handles `false` (older-gateway/other-caller
    // safety, covered in model-resolver.test.ts), but asserting it here would
    // require a state this endpoint does not seem to produce.
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    await createInferenceProvider({
      organizationId: ORG,
      slug: "byo2",
      kind: "openai",
      apiKey: "sk-byo2",
      capabilities: {
        text: { base_url: "https://api.byo2.example.com", model: "byo2-model" },
      },
    });
    await setInferenceProviderDefault(ORG, "byo2");

    const settings = {
      getSettings: async () => ({ models: ["byo2/byo2-model"] }),
    } as any;
    const catalog = new ProviderCatalogService(
      settings,
      { getBestProfile: async () => null } as any,
      (org: string) => listInferenceProviders(org),
      () => {},
    );
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      catalog,
      settings,
    );

    const pc = await sessionContextProviderConfig(gateway);
    expect(pc.defaultProvider).toBe("byo2");
    expect(pc.defaultProviderServesModel).toBe(true);
  });

  test("CTA attribution: a FALLBACK-picked provider publishes defaultProviderServesModel=false", async () => {
    // The live wrong-provider shape. The agent pins NO models, so the policy is
    // ALLOW-ALL (`allowedRefs === null`) and `enforceModelAllowList` returns the
    // requested ref VERBATIM with no routability check — the one path where an
    // unroutable model survives to resolveProviderConfig instead of being
    // replaced or failing closed.
    //
    // The org default names "gemini", which has no installed module here, so
    // findProviderForModel matches nothing and the credentialed-fallback scan
    // publishes byo2 — a provider that does NOT serve the requested model.
    // Without the false, the worker would pin the failure CTA on byo2 and tell
    // the user to reconnect a provider they never asked for.
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    await createInferenceProvider({
      organizationId: ORG,
      slug: "byo2",
      kind: "openai",
      apiKey: "sk-byo2",
      capabilities: {
        text: { base_url: "https://api.byo2.example.com", model: "byo2-model" },
      },
    });
    // A SECOND org row whose slug is "gemini" with NO custom text upstream:
    // synthesizeOrgProviderModule returns null for it, so it contributes no
    // module — yet it IS the org default, so it supplies the requested ref.
    await createInferenceProvider({
      organizationId: ORG,
      slug: "gemini",
      kind: "gemini",
      apiKey: "sk-gemini",
      capabilities: { text: { model: "gemini-2.5-flash" } },
    });
    await setInferenceProviderDefault(ORG, "gemini");

    // models: [] ⇒ allow-all. The org default supplies the requested ref.
    const settings = { getSettings: async () => ({ models: [] }) } as any;
    const catalog = new ProviderCatalogService(
      settings,
      { getBestProfile: async () => null } as any,
      (org: string) => listInferenceProviders(org),
      () => {},
    );
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      catalog,
      settings,
    );

    const pc = await sessionContextProviderConfig(gateway);
    expect(pc.defaultProvider).toBe("byo2");
    expect(pc.defaultProviderServesModel).toBe(false);
  });

  test("R5 #4: an ORGLESS worker token publishes NO model for a db-backed shared id (no cross-org read)", async () => {
    // A shared id (lobu-builder) exists in many orgs. An orgless token must NOT
    // cause session-context to id-only read ANOTHER org's models[0] and PUBLISH
    // it as the worker's defaultModel. The settings store here WOULD return a
    // foreign model — the MODEL resolver must refuse the orgless db read and
    // publish nothing (fail closed). Track whether the foreign model is used by
    // the MODEL path specifically.
    const settings = {
      // DB-backed (not declared): isDeclaredAgent is false, so the MODEL policy
      // read must be refused for an orgless db-backed agent.
      isDeclaredAgent: () => false,
      getSettings: async () => ({ models: ["claude/other-org-model"] }),
    } as any;
    const catalog = new ProviderCatalogService(
      settings,
      { getBestProfile: async () => null } as any,
      (org: string) => listInferenceProviders(org),
      () => {},
    );
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      catalog,
      settings,
    );

    // Orgless token → NO model published (the foreign org's model must never
    // reach the worker as defaultModel).
    const published = await sessionContextModel(gateway, {
      agentId: "lobu-builder",
      organizationId: undefined,
    });
    expect(published).toBeUndefined();
    expect(published).not.toBe("claude/other-org-model");
  });

  test("org default reaches an agent with NO installed providers (custom upstream synthesized)", async () => {
    // The layered fallback's headline case: an agent that pins nothing and has
    // an EMPTY models list must still get the org default provider synthesized
    // into its modules — otherwise a custom-upstream org default reaches the
    // worker as a bare model ref with no base_url/credentials and can't route.
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    // A BYO/custom-upstream provider, marked the org default.
    await createInferenceProvider({
      organizationId: ORG,
      slug: "byo-default",
      kind: "openai",
      apiKey: "sk-byo",
      capabilities: {
        text: { base_url: "https://api.byo.example.com", model: "byo-model" },
      },
    });
    await updateInferenceProviderCapabilities(ORG, "byo-default", "text", {
      base_url: "https://api.byo.example.com",
      model: "byo-model",
    });
    expect(await setInferenceProviderDefault(ORG, "byo-default")).toBe('ok');

    const catalog = new ProviderCatalogService(
      // Agent settings with an EMPTY models list — the exact gap.
      { getSettings: async () => ({ models: [] }) } as any,
      {} as any,
      (org: string) => listInferenceProviders(org),
    );

    const modules = await catalog.getInstalledModules(AGENT, ORG);
    // The org default provider must be synthesized despite empty installed set.
    expect(modules.some((m) => m.providerId === "byo-default")).toBe(true);
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
  });
});
