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
import { whoamiCommand } from "../whoami.js";

describe("whoamiCommand --json", () => {
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    spyOn(internal, "resolveContext").mockResolvedValue({
      name: "lobu",
      url: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(internal, "loadCredentials").mockResolvedValue(null);
    spyOn(internal, "refreshCredentials").mockImplementation(
      async (existing) => existing ?? null
    );
    spyOn(internal, "getAgentApiToken").mockResolvedValue(null);
    spyOn(internal, "listOrganizations").mockResolvedValue([]);
    spyOn(internal, "getActiveOrg").mockResolvedValue(undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  function parseJsonOutput(): Record<string, unknown> {
    const line = stdoutChunks.join("").trim();
    return JSON.parse(line) as Record<string, unknown>;
  }

  test("emits loggedIn=false when no credentials", async () => {
    await whoamiCommand({ json: true });

    const result = parseJsonOutput();
    expect(result.loggedIn).toBe(false);
    expect(result.context).toBe("lobu");
    expect(result.apiUrl).toBe("https://app.lobu.ai/api/v1");
    expect(result.local).toBe(false);
    expect(result.organizations).toEqual([]);
  });

  test("emits session fields after refresh", async () => {
    spyOn(internal, "refreshCredentials").mockResolvedValue({
      accessToken: "session-token",
      refreshToken: "refresh-token",
      expiresAt: 1_700_000_000_000,
      email: "user@example.com",
      name: "Test User",
      userId: "user-123",
      oauth: {
        clientId: "client-id",
        tokenEndpoint: "https://issuer.example.com/token",
      },
    });
    spyOn(internal, "getAgentApiToken").mockResolvedValue("session-token");
    spyOn(internal, "listOrganizations").mockResolvedValue([
      { slug: "acme", name: "Acme Inc" },
    ]);
    spyOn(internal, "getActiveOrg").mockResolvedValue("acme");

    await whoamiCommand({ json: true, context: "lobu" });

    const result = parseJsonOutput();
    expect(result.loggedIn).toBe(true);
    expect(result.email).toBe("user@example.com");
    expect(result.name).toBe("Test User");
    expect(result.userId).toBe("user-123");
    expect(result.accessToken).toBe("session-token");
    expect(result.workerToken).toBe("session-token");
    expect(result.expiresAt).toBe(1_700_000_000_000);
    expect(result.orgSlug).toBe("acme");
    expect(result.organizations).toEqual([{ slug: "acme", name: "Acme Inc" }]);
  });

  test("uses worker PAT on loopback and marks local=true", async () => {
    spyOn(internal, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://localhost:8787/api/v1",
      source: "default",
    });
    spyOn(internal, "refreshCredentials").mockResolvedValue({
      accessToken: "session-token",
      localWorkerToken: "worker-pat",
      email: "dev@lobu.local",
      oauth: {
        clientId: "client-id",
        tokenEndpoint: "http://localhost:8787/oauth/token",
      },
    });
    spyOn(internal, "getAgentApiToken").mockResolvedValue("worker-pat");

    await whoamiCommand({ json: true, context: "local" });

    const result = parseJsonOutput();
    expect(result.local).toBe(true);
    expect(result.accessToken).toBe("session-token");
    expect(result.workerToken).toBe("worker-pat");
    expect(result.loggedIn).toBe(true);
  });

  test("falls back to accessToken when getAgentApiToken fails", async () => {
    spyOn(internal, "refreshCredentials").mockResolvedValue({
      accessToken: "fallback-token",
      oauth: {
        clientId: "client-id",
        tokenEndpoint: "https://issuer.example.com/token",
      },
    });
    spyOn(internal, "getAgentApiToken").mockRejectedValue(new Error("network"));

    await whoamiCommand({ json: true });

    const result = parseJsonOutput();
    expect(result.loggedIn).toBe(true);
    expect(result.workerToken).toBe("fallback-token");
  });

  test("tolerates listOrganizations failure", async () => {
    spyOn(internal, "refreshCredentials").mockResolvedValue({
      accessToken: "token",
      oauth: {
        clientId: "client-id",
        tokenEndpoint: "https://issuer.example.com/token",
      },
    });
    spyOn(internal, "getAgentApiToken").mockResolvedValue("token");
    spyOn(internal, "listOrganizations").mockRejectedValue(new Error("401"));

    await whoamiCommand({ json: true });

    const result = parseJsonOutput();
    expect(result.loggedIn).toBe(true);
    expect(result.organizations).toEqual([]);
  });
});
