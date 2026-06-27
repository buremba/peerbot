import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createVercelSandboxBashOps,
  useVercelSandboxBackend,
} from "../embedded/vercel-sandbox-bash";

const originalEnv = {
  JUST_BASH_ALLOWED_DOMAINS: process.env.JUST_BASH_ALLOWED_DOMAINS,
  LOBU_WORKSPACE_BACKEND: process.env.LOBU_WORKSPACE_BACKEND,
};
const originalFetch = globalThis.fetch;

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("JUST_BASH_ALLOWED_DOMAINS");
  restoreEnv("LOBU_WORKSPACE_BACKEND");
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("useVercelSandboxBackend", () => {
  test("is opt-in only", () => {
    delete process.env.LOBU_WORKSPACE_BACKEND;
    expect(useVercelSandboxBackend()).toBe(false);

    process.env.LOBU_WORKSPACE_BACKEND = "vercel";
    expect(useVercelSandboxBackend()).toBe(true);

    process.env.LOBU_WORKSPACE_BACKEND = "vercel-sandbox";
    expect(useVercelSandboxBackend()).toBe(true);

    process.env.LOBU_WORKSPACE_BACKEND = "local";
    expect(useVercelSandboxBackend()).toBe(false);
  });
});

describe("createVercelSandboxBashOps", () => {
  test("posts bash execution to the internal gateway route", async () => {
    process.env.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify([
      "github.com",
      ".npmjs.org",
      "bad domain",
    ]);

    const fetchMock = mock(async () =>
      Response.json({ stdout: "ok\n", stderr: "", exitCode: 0 })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const ops = createVercelSandboxBashOps({
      gw: {
        gatewayUrl: "http://127.0.0.1:8787/lobu/",
        workerToken: "worker-token",
        channelId: "chan",
        conversationId: "conv",
        workspaceDir: "/workspace/conv",
      },
    });

    const chunks: string[] = [];
    const result = await ops.exec("echo ok", "/subdir", {
      env: {
        DISPATCHER_URL: "http://gateway",
        HOME: "/local-home",
        HTTP_PROXY: "http://gateway:8118",
        NO_PROXY: "localhost,127.0.0.1",
        PATH: "/usr/bin",
        WORKER_TOKEN: "secret-token",
      },
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 3,
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toBe("ok\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/lobu/internal/vercel-sandbox/exec");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer worker-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      command: "echo ok",
      cwd: "/subdir",
      workspaceDir: "/workspace/conv",
      timeoutMs: 3000,
      env: {
        HOME: "/vercel/sandbox",
        PATH: "/usr/bin",
        TMPDIR: "/vercel/sandbox/.tmp",
        TMP: "/vercel/sandbox/.tmp",
        TEMP: "/vercel/sandbox/.tmp",
        XDG_CACHE_HOME: "/vercel/sandbox/.cache",
      },
      allowedDomains: ["github.com", ".npmjs.org"],
    });
  });

  test("surfaces gateway errors as bash failures", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "not enabled" }, { status: 404 })
    ) as typeof fetch;

    const ops = createVercelSandboxBashOps({
      gw: {
        gatewayUrl: "http://127.0.0.1:8787/lobu",
        workerToken: "worker-token",
        channelId: "chan",
        conversationId: "conv",
      },
    });

    const chunks: string[] = [];
    const result = await ops.exec("pwd", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 1,
    });

    expect(result.exitCode).toBe(1);
    expect(chunks.join("")).toBe("not enabled\n");
  });
});
