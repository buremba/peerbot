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
import * as internal from "../../internal/index.js";
import { clientsListCommand, clientsRevokeCommand } from "../clients.js";
import {
  sandboxCreateCommand,
  sandboxDeleteCommand,
  sandboxListCommand,
  sandboxSetCredentialCommand,
} from "../sandbox.js";
import {
  providersCatalogCommand,
  providersCreateCommand,
  providersDeleteCommand,
  providersListCommand,
  providersSetCapabilityCommand,
  providersSetDefaultCommand,
  providersSetKeyCommand,
  providersUpdateCommand,
} from "../providers/manage.js";

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

let calls: RecordedCall[];
let responses: unknown[];
let logLines: string[];
let errorLines: string[];
/** When set, the fake client throws for any call whose path ends with this. */
let failPathSuffix: string | null;

/** Minimal ApiClient stand-in: records every call, replays queued responses. */
function fakeClient() {
  const next = (path: string) => {
    if (failPathSuffix && path.endsWith(failPathSuffix)) {
      throw new Error(`simulated failure: ${path}`);
    }
    return responses.length > 0 ? responses.shift() : {};
  };
  return {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return next(path);
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return next(path);
    },
    patch: async (path: string, body?: unknown) => {
      calls.push({ method: "PATCH", path, body });
      return next(path);
    },
    delete: async (path: string) => {
      calls.push({ method: "DELETE", path });
      return next(path);
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return next(path);
    },
  };
}

beforeEach(() => {
  calls = [];
  responses = [];
  logLines = [];
  errorLines = [];
  failPathSuffix = null;
  spyOn(internal, "resolveApiClient").mockImplementation(
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
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  mock.restore();
  delete process.env.LOBU_TEST_PROVIDER_KEY;
});

/** Guarded delete-style commands: assert refusal without --yes (no network). */
async function expectYesGuard(run: () => Promise<void>): Promise<void> {
  const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  await expect(run()).rejects.toThrow("exit");
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(calls).toEqual([]);
  exitSpy.mockRestore();
}

describe("providers", () => {
  test("list hits the org inference-providers route", async () => {
    responses = [{ providers: [] }];
    await providersListCommand({ json: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/testorg/agents/inference-providers" },
    ]);
  });

  test("catalog fetches /catalog and renders auth by supportedAuthTypes", async () => {
    responses = [
      {
        catalog: [
          {
            slug: "claude",
            displayName: "Claude",
            authType: "oauth",
            supportedAuthTypes: ["oauth", "api-key"],
            defaultModel: null,
          },
          {
            slug: "sub-only",
            displayName: "Sub Only",
            authType: "oauth",
            supportedAuthTypes: ["oauth"],
            defaultModel: null,
          },
        ],
      },
    ];
    await providersCatalogCommand({});
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/testorg/agents/inference-providers/catalog",
      },
    ]);
    const claudeLine = logLines.find((l) => l.includes("claude"));
    const subOnlyLine = logLines.find((l) => l.includes("sub-only"));
    expect(claudeLine).toContain("api key or web sign-in");
    expect(subOnlyLine).toContain("sign-in via web console");
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

  test("create reports an automatic default returned by the server", async () => {
    responses = [{ provider: { slug: "z-ai", isDefault: true } }];

    await providersCreateCommand("z-ai", {
      kind: "z-ai",
      key: "sk-literal",
    });

    expect(logLines.join("\n")).toContain("and set as org default");
  });

  test("create --default reports partial success when the default PUT fails", async () => {
    responses = [{ provider: { slug: "p1" } }];
    failPathSuffix = "/p1/default";
    await expect(
      providersCreateCommand("p1", {
        kind: "openai",
        key: "sk-literal",
        default: true,
      })
    ).rejects.toThrow("simulated failure");
    // The provider row exists — the operator must learn create succeeded.
    expect(errorLines.join("\n")).toContain("was created");
    expect(errorLines.join("\n")).toContain("lobu providers set-default p1");
  });

  test("update trims the name and PUTs displayName", async () => {
    responses = [{ provider: { slug: "z-ai" } }];
    await providersUpdateCommand("z-ai", { name: "  Z AI  ", json: true });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/testorg/agents/inference-providers/z-ai",
        body: { displayName: "Z AI" },
      },
    ]);
  });

  test("update rejects a blank name before any network call", async () => {
    await expect(
      providersUpdateCommand("z-ai", { name: "   " })
    ).rejects.toThrow("--name must not be blank");
    expect(calls).toEqual([]);
  });

  test("set-key rotates via /key with a resolved $VAR value", async () => {
    process.env.LOBU_TEST_PROVIDER_KEY = "sk-rotated";
    await providersSetKeyCommand("z-ai", { key: "$LOBU_TEST_PROVIDER_KEY" });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/testorg/agents/inference-providers/z-ai/key",
        body: { value: "sk-rotated" },
      },
    ]);
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

  test("set-default PUTs /default", async () => {
    await providersSetDefaultCommand("z-ai", {});
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/testorg/agents/inference-providers/z-ai/default",
        body: undefined,
      },
    ]);
  });

  test("delete requires --yes, then DELETEs", async () => {
    await expectYesGuard(() => providersDeleteCommand("z-ai", {}));
    await providersDeleteCommand("z-ai", { yes: true });
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/api/testorg/agents/inference-providers/z-ai",
      },
    ]);
  });
});

describe("sandbox", () => {
  test("list hits the sandboxes route", async () => {
    responses = [
      { builtin: { id: "builtin" }, sandboxes: [], availableProviders: [] },
    ];
    await sandboxListCommand({ json: true });
    expect(calls).toEqual([{ method: "GET", path: "/api/testorg/sandboxes" }]);
  });

  test("create sends snake-case provider_kind and parsed credential", async () => {
    responses = [{ sandbox: { id: "sbx_1", name: "prod" } }];
    await sandboxCreateCommand("prod", {
      provider: "vercel",
      credential: ["token=tok-1", "teamId=team_1"],
      json: true,
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/testorg/sandboxes",
        body: {
          name: "prod",
          provider_kind: "vercel",
          credential: { token: "tok-1", teamId: "team_1" },
        },
      },
    ]);
  });

  test("set-credential PUTs to the credential route", async () => {
    await sandboxSetCredentialCommand("sbx_1", {
      credential: ["token=tok-2"],
    });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/testorg/sandboxes/sbx_1/credential",
        body: { credential: { token: "tok-2" } },
      },
    ]);
  });

  test("delete requires --yes, then DELETEs", async () => {
    await expectYesGuard(() => sandboxDeleteCommand("sbx_1", {}));
    await sandboxDeleteCommand("sbx_1", { yes: true });
    expect(calls).toEqual([
      { method: "DELETE", path: "/api/testorg/sandboxes/sbx_1" },
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

  test("revoke requires --yes, then DELETEs the mcp client", async () => {
    await expectYesGuard(() => clientsRevokeCommand("mcp_client_1", {}));
    await clientsRevokeCommand("mcp_client_1", { yes: true });
    expect(calls).toEqual([
      { method: "DELETE", path: "/api/testorg/clients/mcp/mcp_client_1" },
    ]);
  });
});
