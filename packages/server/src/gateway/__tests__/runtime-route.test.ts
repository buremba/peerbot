import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateWorkerToken } from "@lobu/core";

const remoteFiles = new Map<string, Buffer>();
const mkdirMock = mock(async () => undefined);
const readdirMock = mock(async () => []);
const statMock = mock(async (remotePath: string) => ({
  size: remoteFiles.get(remotePath)?.byteLength ?? 0,
}));
const rmMock = mock(async (remotePath: string) => {
  remoteFiles.delete(remotePath);
});
const writeFilesMock = mock(async () => undefined);
const readFileToBufferMock = mock(async () => null);
const runCommandMock = mock(async (params: { args?: string[] }) => {
  const command = params.args?.[1] ?? "";
  let stdout = "command stdout\n";
  let exitCode = 0;
  if (command.includes("echo remote output > output.txt")) {
    remoteFiles.set("/vercel/sandbox/output.txt", Buffer.from("remote output"));
  }
  if (command.includes("cat input.txt")) {
    const input = remoteFiles.get("/vercel/sandbox/input.txt");
    if (input) {
      stdout = input.toString("utf8");
    } else {
      stdout = "";
      exitCode = 1;
    }
  }
  if (command.includes("rm input.txt")) {
    remoteFiles.delete("/vercel/sandbox/input.txt");
  }
  return {
    exitCode,
    stdout: async () => stdout,
    stderr: async () => "",
  };
});
const updateMock = mock(async () => undefined);
const getOrCreateMock = mock(async () => fakeSandbox);

const fakeSandbox = {
  name: "lobu-org-agent-hash",
  persistent: true,
  cwd: "/vercel/sandbox",
  networkPolicy: "deny-all",
  timeout: 60_000,
  vcpus: 2,
  keepLastSnapshots: undefined,
  snapshotExpiration: undefined,
  fs: {
    mkdir: mkdirMock,
    readdir: readdirMock,
    stat: statMock,
    rm: rmMock,
  },
  writeFiles: writeFilesMock,
  readFileToBuffer: readFileToBufferMock,
  runCommand: runCommandMock,
  update: updateMock,
};

mock.module("@vercel/sandbox", () => ({
  Sandbox: { getOrCreate: getOrCreateMock },
}));

// Importing the route pulls in the gateway runtime registry barrel, which
// registers the Vercel provider. The @vercel/sandbox mock above is installed
// first so the provider module binds to it.
const { createRuntimeRoutes } = await import("../routes/internal/runtime.js");

const originalEnv = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  LOBU_VERCEL_SANDBOX_NAME_PREFIX: process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX,
  LOBU_VERCEL_SANDBOX_RUNTIME: process.env.LOBU_VERCEL_SANDBOX_RUNTIME,
  VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
  VERCEL_SANDBOX_DEFAULT_RUNTIME: process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME,
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function token(
  options: {
    agentId?: string;
    runtimeProviderId?: string;
    allowedDomains?: string[];
  } = {}
): string {
  return generateWorkerToken("user-1", "conv-1", "deploy-1", {
    channelId: "chan-1",
    teamId: "team-1",
    platform: "slack",
    organizationId: "org-1",
    agentId: options.agentId,
    runtimeProviderId: options.runtimeProviderId,
    allowedDomains: options.allowedDomains,
  });
}

function setVercelSystemCreds(): void {
  process.env.VERCEL_PROJECT_ID = "prj_test";
  process.env.VERCEL_TEAM_ID = "team_test";
  process.env.VERCEL_TOKEN = "vercel_test_token";
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(async () => {
  restoreEnv("ENCRYPTION_KEY");
  restoreEnv("LOBU_VERCEL_SANDBOX_NAME_PREFIX");
  restoreEnv("LOBU_VERCEL_SANDBOX_RUNTIME");
  restoreEnv("VERCEL_PROJECT_ID");
  restoreEnv("VERCEL_SANDBOX_DEFAULT_RUNTIME");
  restoreEnv("VERCEL_TEAM_ID");
  restoreEnv("VERCEL_TOKEN");
  restoreEnv("VERCEL_OIDC_TOKEN");
  remoteFiles.clear();
  getOrCreateMock.mockClear();
  mkdirMock.mockClear();
  readdirMock.mockClear();
  writeFilesMock.mockClear();
  runCommandMock.mockClear();
  statMock.mockClear();
  readFileToBufferMock.mockClear();
  rmMock.mockClear();
  updateMock.mockClear();
  await fs.rm(path.resolve("workspaces", "verceltestagent"), {
    recursive: true,
    force: true,
  });
  mock.restore();
});

describe("createRuntimeRoutes", () => {
  test("404s when the token selects no runtime provider", async () => {
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ agentId: "agent-1" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "No runtime provider configured for this agent",
    });
  });

  test("404s when the token names an unknown provider", async () => {
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "agent-1",
          runtimeProviderId: "made-up",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd" }),
    });

    expect(res.status).toBe(404);
  });

  test("requires an agent-scoped worker token before sandbox work", async () => {
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ runtimeProviderId: "vercel" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Token missing agent context" });
  });

  test("424s when the provider has no resolvable credentials", async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(424);
    expect(await res.json()).toEqual({
      error: "Runtime provider credentials unavailable",
    });
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("proceeds via OIDC self-auth when no explicit credential but VERCEL_OIDC_TOKEN is present", async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    process.env.VERCEL_OIDC_TOKEN = "oidc.test.token";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    // No explicit creds + OIDC present → route lets the SDK self-auth (no 424).
    expect(res.status).toBe(200);
    expect(getOrCreateMock).toHaveBeenCalledTimes(1);
    // SDK self-resolves OIDC — no explicit token/teamId/projectId passed in.
    expect(getOrCreateMock.mock.calls[0]?.[0]).not.toHaveProperty("token");
  });

  test("424s when required credentials are only partially configured", async () => {
    process.env.VERCEL_TOKEN = "vercel_test_token";
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(424);
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("rejects a workspace path outside the token conversation", async () => {
    setVercelSystemCreds();
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "pwd",
        workspaceDir: path.resolve("workspaces", "verceltestagent", "other"),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Workspace does not match token conversation context",
    });
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("resolves provider credentials from system env and passes them to the sandbox", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: "prj_test",
      teamId: "team_test",
      token: "vercel_test_token",
    });
    // The worker never receives the credential — only stdout/stderr/exitCode.
    expect(JSON.stringify(await res.json())).not.toContain("vercel_test_token");
  });

  test("ignores a body-supplied provider and uses the signed token claim", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      // A compromised worker tries to switch providers via the body.
      body: JSON.stringify({ command: "pwd", workspaceDir, provider: "made-up" }),
    });

    expect(res.status).toBe(200);
    expect(getOrCreateMock).toHaveBeenCalledTimes(1);
  });

  test("ignores a body-supplied egress allowlist and uses the signed token claim", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          // The gateway-signed allowlist for this agent.
          allowedDomains: ["github.com"],
        })}`,
        "content-type": "application/json",
      },
      // A compromised worker tries to widen egress to everything via the body.
      body: JSON.stringify({
        command: "pwd",
        workspaceDir,
        allowedDomains: ["*"],
      }),
    });

    expect(res.status).toBe(200);
    // The sandbox network policy reflects the TOKEN's allowlist, NOT the body's
    // "*": the body must not be able to escalate to an allow-all sandbox.
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      networkPolicy: { allow: ["github.com"] },
    });
  });

  test("executes in a persistent named sandbox without local file sync", async () => {
    setVercelSystemCreds();
    process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
    process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME = "node22";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    await fs.mkdir(workspaceDir, { recursive: true });
    const subdir = path.join(workspaceDir, "nested");
    await fs.writeFile(path.join(workspaceDir, "input.txt"), "local input");
    remoteFiles.set("/vercel/sandbox/stale.txt", Buffer.from("stale"));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          // The egress allowlist now rides the signed token, not the body.
          allowedDomains: ["github.com", ".npmjs.org", "bad domain"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "pwd",
        cwd: subdir,
        workspaceDir,
        timeoutMs: 1_000,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stdout: "command stdout\n",
      stderr: "",
      exitCode: 0,
      sandbox: {
        name: "lobu-org-agent-hash",
        persistent: true,
        cwd: "/vercel/sandbox",
      },
    });
    expect(getOrCreateMock).toHaveBeenCalledTimes(1);
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      name: expect.stringMatching(
        /^lobu-test-org-1-verceltestagent-[a-f0-9]{16}$/
      ),
      persistent: true,
      runtime: "node22",
      resources: { vcpus: 1 },
      networkPolicy: { allow: ["github.com", "*.npmjs.org"] },
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    });
    expect(remoteFiles.has("/vercel/sandbox/stale.txt")).toBe(true);
    expect(runCommandMock.mock.calls[0]?.[0]).toMatchObject({
      cmd: "/bin/bash",
      args: ["-lc", "pwd"],
      cwd: "/vercel/sandbox/nested",
      timeoutMs: 1_000,
    });
    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(readFileToBufferMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  test("remote deletes do not mutate local workspace files", async () => {
    setVercelSystemCreds();
    process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "input.txt"), "local input");
    remoteFiles.set("/vercel/sandbox/input.txt", Buffer.from("remote input"));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "rm input.txt", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(remoteFiles.has("/vercel/sandbox/input.txt")).toBe(false);
    expect(
      await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")
    ).toBe("local input");
    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(readFileToBufferMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });
});
