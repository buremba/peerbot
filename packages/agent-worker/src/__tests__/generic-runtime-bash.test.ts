import { afterEach, describe, expect, mock, test } from "bun:test";
import { createGenericRuntimeBashOps } from "../embedded/runtime/generic-runtime-bash";
import { getWorkerRuntimeProvider } from "../embedded/runtime/index";

const originalEnv = {
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
    // …and never supplies the egress allowlist: the gateway reads it from the
    // signed token so a worker can't widen its own sandbox network policy.
    expect(body).not.toHaveProperty("allowedDomains");
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
    });
  });

  /**
   * The gateway degrades honestly when a contributed nix package fails to
   * install: HTTP 200, the command still runs, and the failure is reported in
   * `sandbox.packages` (shape pinned by
   * `packages/server/src/gateway/__tests__/runtime-route.test.ts`). Only the
   * worker can tell the AGENT — if it drops the field, the model sees exit 0
   * and no hint that the CLI it is about to reach for is absent.
   */
  describe("contributed package provisioning", () => {
    function opsForResponse(payload: unknown): {
      ops: ReturnType<typeof createGenericRuntimeBashOps>;
    } {
      globalThis.fetch = mock(async () =>
        Response.json(payload as Record<string, unknown>)
      ) as typeof fetch;
      const provider = getWorkerRuntimeProvider("vercel");
      if (!provider) throw new Error("vercel provider not registered");
      return {
        ops: createGenericRuntimeBashOps(provider, {
          gw: {
            gatewayUrl: "http://127.0.0.1:8787/lobu",
            workerToken: "worker-token",
            channelId: "chan",
            conversationId: "conv",
          },
        }),
      };
    }

    test("tells the agent which packages are missing instead of exiting silently", async () => {
      // Verbatim production shape: the route spreads the provider `meta` and
      // adds `packages` (see runtime.ts `sandbox: { ...result.meta, packages }`).
      const { ops } = opsForResponse({
        stdout: "gh: command not found\n",
        stderr: "",
        exitCode: 0,
        sandbox: {
          name: "lobu-org-agent-hash",
          persistent: true,
          cwd: "/vercel/sandbox",
          packages: {
            installed: [],
            failed: ["gh"],
            cached: false,
            error: "nix provisioning exited 1",
          },
        },
      });

      const chunks: string[] = [];
      const result = await ops.exec("gh --version", "/", {
        onData: (chunk) => chunks.push(chunk.toString()),
        timeout: 1,
      });

      const output = chunks.join("");
      // Named, not merely hinted at — the agent must be able to read WHICH tool
      // is absent and WHY without guessing from a shell error.
      expect(output).toContain("lobu:");
      expect(output).toContain("gh");
      expect(output).toContain("nix provisioning exited 1");
      // The notice is a preamble, not a conclusion drawn from the output.
      expect(output.indexOf("lobu:")).toBeLessThan(
        output.indexOf("gh: command not found")
      );
      // Honest degradation: a missing contributed CLI must NOT fail the turn,
      // so the command's own exit code is passed through untouched.
      expect(result.exitCode).toBe(0);
    });

    test("stays silent when every contributed package provisioned", async () => {
      const { ops } = opsForResponse({
        stdout: "gh version 2.0.0\n",
        stderr: "",
        exitCode: 0,
        sandbox: {
          name: "lobu-org-agent-hash",
          persistent: true,
          cwd: "/vercel/sandbox",
          packages: { installed: ["gh"], failed: [], cached: true },
        },
      });

      const chunks: string[] = [];
      const result = await ops.exec("gh --version", "/", {
        onData: (chunk) => chunks.push(chunk.toString()),
        timeout: 1,
      });

      expect(chunks.join("")).toBe("gh version 2.0.0\n");
      expect(result.exitCode).toBe(0);
    });

    test("stays silent when the turn provisioned nothing", async () => {
      // `sandbox` is the bare provider meta with no `packages` key at all when
      // the signed claim carried no nix packages.
      const { ops } = opsForResponse({
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        sandbox: { name: "lobu-org-agent-hash", persistent: true },
      });

      const chunks: string[] = [];
      const result = await ops.exec("echo ok", "/", {
        onData: (chunk) => chunks.push(chunk.toString()),
        timeout: 1,
      });

      expect(chunks.join("")).toBe("ok\n");
      expect(result.exitCode).toBe(0);
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
