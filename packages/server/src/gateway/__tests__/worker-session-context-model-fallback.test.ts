import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { getDb } from "../../db/client.js";
import {
  createInferenceProvider,
  getOrgDefaultModel,
  setInferenceProviderDefault,
} from "../../lobu/stores/provider-secrets.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import { WorkerGateway } from "../gateway/index.js";

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
  gateway: WorkerGateway
): Promise<string | undefined> {
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
    providerConfig?: { defaultModel?: string };
  };
  return body.providerConfig?.defaultModel;
}

describe("worker model fallback (real DB, both channels)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await createInferenceProvider({
      organizationId: ORG,
      slug: "org-default-openai",
      kind: "openai",
      apiKey: "sk-e2e",
      capabilities: { text: { model: "openai/gpt-5" } },
    });
    await setInferenceProviderDefault(ORG, "org-default-openai");
  }, 60_000);

  test("org default is readable via the real DB reader", async () => {
    expect(await getOrgDefaultModel(ORG)).toBe("openai/gpt-5");
  });

  test("Channel 1: agent with no defaultModel → org default in agentOptions.model", async () => {
    const store = {
      getSettings: async () => ({ defaultModel: undefined }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBe("openai/gpt-5");
  });

  test("Channel 1: agent defaultModel wins over org default", async () => {
    const store = {
      getSettings: async () => ({ defaultModel: "claude/claude-sonnet-4-6" }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBe("claude/claude-sonnet-4-6");
  });

  test("Channel 1: behavior override wins over both agent and org", async () => {
    const store = {
      getSettings: async () => ({ defaultModel: "claude/claude-sonnet-4-6" }),
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
      getSettings: async () => ({ defaultModel: undefined }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBeUndefined();
  });

  test("Channel 2: /session-context returns no defaultModel without a routable provider catalog", async () => {
    const gateway = buildGatewayNoCatalog(async () => ({
      defaultModel: "claude/claude-sonnet-4-6",
    }));
    // Accurate contract: with no ProviderCatalogService, Channel 2 surfaces no
    // defaultModel (the worker uses Channel 1's agentOptions.model instead).
    expect(await sessionContextModel(gateway)).toBeUndefined();
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
  });
});
