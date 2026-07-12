/**
 * Route-contract tests for the config-less infra commands: assert each command
 * hits the right path with the right body/query, with the network mocked at
 * `resolveApiClient` (same seam whoami.test.ts uses).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as providersInternal from "../../internal/index.js";
import { clientsListCommand, clientsRevokeCommand } from "../clients.js";
import {
  environmentCreateCommand,
  environmentSetCredentialCommand,
} from "../environment.js";
import {
  providersCreateCommand,
  providersListCommand,
  providersSetCapabilityCommand,
} from "../providers/manage.js";

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

let calls: RecordedCall[];
let responses: unknown[];

/** Minimal ApiClient stand-in: records every call, replays queued responses. */
function fakeClient() {
  const next = () => (responses.length > 0 ? responses.shift() : {});
  return {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return next();
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return next();
    },
    patch: async (path: string, body?: unknown) => {
      calls.push({ method: "PATCH", path, body });
      return next();
    },
    delete: async (path: string) => {
      calls.push({ method: "DELETE", path });
      return next();
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return next();
    },
  };
}

beforeEach(() => {
  calls = [];
  responses = [];
  spyOn(providersInternal, "resolveApiClient").mockImplementation(
    async () =>
      ({
        client: fakeClient(),
        contextName: "test",
        apiBaseUrl: "https://api.test",
        orgSlug: "testorg",
        token: "tok",
      }) as never
  );
  spyOn(process.stdout, "write").mockImplementation(() => true);
  spyOn(console, "log").mockImplementation(() => undefined);
  spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  mock.restore();
  delete process.env.LOBU_TEST_PROVIDER_KEY;
});

describe("providers", () => {
  test("list hits the org inference-providers route", async () => {
    responses = [{ providers: [] }];
    await providersListCommand({ json: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/testorg/agents/inference-providers" },
    ]);
  });

  test("create resolves $VAR key, merges --model, and sets default", async () => {
    process.env.LOBU_TEST_PROVIDER_KEY = "sk-resolved";
    responses = [{ provider: { slug: "z-ai" } }, {}];
    await providersCreateCommand("z-ai", {
      kind: "z-ai",
      key: "$LOBU_TEST_PROVIDER_KEY",
      model: "glm-5.2",
      default: true,
      json: true,
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/testorg/agents/inference-providers",
      body: {
        slug: "z-ai",
        kind: "z-ai",
        apiKey: "sk-resolved",
        capabilities: { text: { model: "glm-5.2" } },
      },
    });
    expect(calls[1]).toEqual({
      method: "PUT",
      path: "/api/testorg/agents/inference-providers/z-ai/default",
      body: undefined,
    });
  });

  test("set-capability sends the block for one modality", async () => {
    await providersSetCapabilityCommand("z-ai", "text", {
      model: "glm-5.2",
      baseUrl: "https://api.z.ai/v1",
    });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/testorg/agents/inference-providers/z-ai/capabilities/text",
        body: { block: { model: "glm-5.2", base_url: "https://api.z.ai/v1" } },
      },
    ]);
  });
});

describe("environment", () => {
  test("create sends snake-case provider_kind and parsed credential", async () => {
    responses = [{ environment: { id: "env_1", name: "prod" } }];
    await environmentCreateCommand("prod", {
      provider: "vercel",
      scope: "org",
      credential: ["token=tok-1", "teamId=team_1"],
      json: true,
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/testorg/environments",
        body: {
          name: "prod",
          provider_kind: "vercel",
          scope: "org",
          credential: { token: "tok-1", teamId: "team_1" },
        },
      },
    ]);
  });

  test("set-credential PUTs to the credential route", async () => {
    await environmentSetCredentialCommand("env_1", {
      credential: ["token=tok-2"],
    });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/testorg/environments/env_1/credential",
        body: { credential: { token: "tok-2" } },
      },
    ]);
  });
});

describe("clients", () => {
  test("list encodes the agent filter", async () => {
    responses = [{ clients: [] }];
    await clientsListCommand({ agent: "my/agent", json: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/testorg/clients?agentId=my%2Fagent" },
    ]);
  });

  test("revoke deletes the mcp client and requires --yes", async () => {
    await clientsRevokeCommand("mcp_client_1", { yes: true });
    expect(calls).toEqual([
      { method: "DELETE", path: "/api/testorg/clients/mcp/mcp_client_1" },
    ]);

    // Without --yes: refuses before any network call.
    calls = [];
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(clientsRevokeCommand("mcp_client_1", {})).rejects.toThrow(
      "exit"
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(calls).toEqual([]);
  });
});
