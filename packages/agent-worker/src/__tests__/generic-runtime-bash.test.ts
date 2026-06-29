import { afterEach, describe, expect, mock, test } from "bun:test";
import { createGenericRuntimeBashOps } from "../embedded/runtime/generic-runtime-bash";
import { getWorkerRuntimeProvider } from "../embedded/runtime/index";

const originalEnv = {
  JUST_BASH_ALLOWED_DOMAINS: process.env.JUST_BASH_ALLOWED_DOMAINS,
  LOBU_RUNTIME_PROVIDER: process.env.LOBU_RUNTIME_PROVIDER,
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
  restoreEnv("LOBU_RUNTIME_PROVIDER");
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("worker runtime registry", () => {
  test("resolves registered providers and ignores unknown selectors", () => {
    expect(getWorkerRuntimeProvider("vercel")?.id).toBe("vercel");
    expect(getWorkerRuntimeProvider("VERCEL")?.id).toBe("vercel");
    expect(getWorkerRuntimeProvider("")).toBeUndefined();
    expect(getWorkerRuntimeProvider(undefined)).toBeUndefined();
    expect(getWorkerRuntimeProvider("local")).toBeUndefined();
  });
});

describe("createGenericRuntimeBashOps", () => {
  test("posts bash execution to the generic runtime route without naming a provider", async () => {
    process.env.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify([
      "github.com",
      ".npmjs.org",
      "bad domain",
    ]);

    const fetchMock = mock(async () =>
      Response.json({ stdout: "ok\n", stderr: "", exitCode: 0 })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = getWorkerRuntimeProvider("vercel");
    if (!provider) throw new Error("vercel provider not registered");
    const ops = createGenericRuntimeBashOps(provider, {
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
    expect(url).toBe("http://127.0.0.1:8787/lobu/internal/runtime/exec");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer worker-token",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init.body));
    // The worker never selects a provider — the gateway derives it from the token.
    expect(body).not.toHaveProperty("provider");
    expect(body).toEqual({
      command: "echo ok",
      cwd: "/subdir",
      workspaceDir: "/workspace/conv",
      timeoutMs: 3000,
      env: {
        // WORKER_TOKEN / DISPATCHER_URL / HTTP_PROXY / NO_PROXY stripped; the
        // provider's remoteEnv overrides HOME and adds the sandbox tmp/cache.
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

    const provider = getWorkerRuntimeProvider("vercel");
    if (!provider) throw new Error("vercel provider not registered");
    const ops = createGenericRuntimeBashOps(provider, {
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
