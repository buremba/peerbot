import { afterEach, describe, expect, mock, test } from "bun:test";

// Mock the vault read so resolveRuntimeCredentials can be unit-tested without a DB.
const readEnvironmentSecretMock = mock(
  async (_envId: string, _field: string, _orgId: string): Promise<string | null> =>
    null
);
mock.module("../../../lobu/stores/provider-secrets.js", () => ({
  readEnvironmentSecret: readEnvironmentSecretMock,
}));

const { resolveRuntimeCredentials } = await import("../credentials.js");
import type { GatewayRuntimeProvider } from "../types.js";

const provider: GatewayRuntimeProvider = {
  id: "vercel",
  credentialFields: [
    { key: "token", systemEnvVar: "VERCEL_TOKEN", required: true },
    { key: "teamId", systemEnvVar: "VERCEL_TEAM_ID", required: true },
    { key: "projectId", systemEnvVar: "VERCEL_PROJECT_ID", required: true },
  ],
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

const ORIG = {
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
  VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  readEnvironmentSecretMock.mockClear();
  readEnvironmentSecretMock.mockImplementation(async () => null);
});

describe("resolveRuntimeCredentials", () => {
  test("prefers the org vault over system env (source=byo)", async () => {
    process.env.VERCEL_TOKEN = "env-token";
    process.env.VERCEL_TEAM_ID = "env-team";
    process.env.VERCEL_PROJECT_ID = "env-project";
    readEnvironmentSecretMock.mockImplementation(
      async (_e: string, field: string) => `vault-${field}`
    );

    const result = await resolveRuntimeCredentials(provider, "org-1", "env-1");
    expect(result).toEqual({
      values: {
        token: "vault-token",
        teamId: "vault-teamId",
        projectId: "vault-projectId",
      },
      source: "byo",
    });
  });

  test("falls back to system env when no environment is pinned (source=system)", async () => {
    process.env.VERCEL_TOKEN = "env-token";
    process.env.VERCEL_TEAM_ID = "env-team";
    process.env.VERCEL_PROJECT_ID = "env-project";

    const result = await resolveRuntimeCredentials(provider, "org-1", undefined);
    expect(result?.source).toBe("system");
    expect(result?.values).toEqual({
      token: "env-token",
      teamId: "env-team",
      projectId: "env-project",
    });
    // No environmentId → vault is never consulted.
    expect(readEnvironmentSecretMock).not.toHaveBeenCalled();
  });

  test("fails closed (null) when a required field is unresolved", async () => {
    process.env.VERCEL_TOKEN = "env-token";
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;

    const result = await resolveRuntimeCredentials(provider, "org-1", undefined);
    expect(result).toBeNull();
  });
});
