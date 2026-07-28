import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  probeSandboxStrategy,
  resetSandboxProbeForTests,
} from "../embedded/exec-sandbox";
import {
  buildBinaryInvocation,
  createEmbeddedBashOps,
} from "../embedded/just-bash-bootstrap";

const tempDirs: string[] = [];
const originalEnv = {
  PATH: process.env.PATH,
  LOBU_EXEC_SANDBOX: process.env.LOBU_EXEC_SANDBOX,
  LOBU_ALLOW_UNSANDBOXED_EXEC: process.env.LOBU_ALLOW_UNSANDBOXED_EXEC,
  LOBU_WORKSPACE_BACKEND: process.env.LOBU_WORKSPACE_BACKEND,
  LOBU_RUNTIME_PROVIDER: process.env.LOBU_RUNTIME_PROVIDER,
  JUST_BASH_ALLOWED_DOMAINS: process.env.JUST_BASH_ALLOWED_DOMAINS,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NIX_PACKAGES: process.env.NIX_PACKAGES,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * Turn spawned-binary registration on without relying on an OS sandbox.
 *
 * `createEmbeddedBashOps` registers spawned binaries only when a real per-exec
 * sandbox is present OR the explicit unsandboxed opt-in is set. Neither real
 * sandbox can run a *fixture* binary: bwrap (Linux) binds only /usr, /bin, /lib
 * and /nix from the host, so a fake CLI in a temp dir does not exist inside the
 * namespace, and sandbox-exec is macOS-only. Naming sandbox-exec via
 * LOBU_EXEC_SANDBOX on Linux is a hard error by design, which is exactly how
 * these tests used to break CI.
 *
 * The opt-in flips registration on without touching discovery, which is the
 * behaviour the tests below pin. The sandbox gate itself is pinned separately by
 * the SECURITY test in this file.
 */
function registerWithoutOsSandbox(): void {
  process.env.LOBU_EXEC_SANDBOX = "off";
  process.env.LOBU_ALLOW_UNSANDBOXED_EXEC = "1";
}

/**
 * Whether this host has a real per-exec sandbox (bwrap on Linux, sandbox-exec on
 * macOS). Probed once at module load, before any test mutates the environment.
 */
const realSandboxAvailable = ((): boolean => {
  const saved = process.env.LOBU_EXEC_SANDBOX;
  delete process.env.LOBU_EXEC_SANDBOX;
  try {
    return probeSandboxStrategy().kind !== "none";
  } catch {
    return false;
  } finally {
    if (saved === undefined) {
      delete process.env.LOBU_EXEC_SANDBOX;
    } else {
      process.env.LOBU_EXEC_SANDBOX = saved;
    }
    resetSandboxProbeForTests();
  }
})();

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv("PATH");
  restoreEnv("LOBU_EXEC_SANDBOX");
  restoreEnv("LOBU_ALLOW_UNSANDBOXED_EXEC");
  restoreEnv("LOBU_WORKSPACE_BACKEND");
  restoreEnv("LOBU_RUNTIME_PROVIDER");
  restoreEnv("JUST_BASH_ALLOWED_DOMAINS");
  restoreEnv("HTTP_PROXY");
  restoreEnv("HTTPS_PROXY");
  restoreEnv("NIX_PACKAGES");
  resetSandboxProbeForTests();
});

describe("createEmbeddedBashOps", () => {
  test("does not register spawned PATH binaries without a sandbox or opt-in", async () => {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-sandbox-"))
    );
    tempDirs.push(workspace);

    const nixBin = path.join(workspace, "nix", "store", "fake", "bin");
    fs.mkdirSync(nixBin, { recursive: true });
    const hostCat = path.join(nixBin, "hostcat");
    fs.writeFileSync(hostCat, '#!/bin/sh\n/bin/cat "$@"\n', "utf8");
    fs.chmodSync(hostCat, 0o755);

    process.env.PATH = `${nixBin}:${process.env.PATH ?? ""}`;
    process.env.LOBU_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
    delete process.env.LOBU_WORKSPACE_BACKEND;

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    const result = await ops.exec("hostcat /etc/passwd", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });

    expect(result.exitCode).not.toBe(0);
    expect(chunks.join("")).not.toContain("root:");
  });

  test("REGRESSION: a connector-contributed CLI outside /nix/store is runnable", async () => {
    // The production image bakes `git` and `gh` into /usr/bin, which is on PATH
    // but NOT under /nix/store — and discovery only scanned /nix/store plus a
    // hardcoded ["lobu"]. So the contributed CLI sat on the filesystem and
    // exited 127 through the agent's bash: the credential worked and the
    // command did not, which is the whole feature failing on the image it
    // ships on.
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-contributed-"))
    );
    tempDirs.push(workspace);

    // Deliberately NOT under /nix/store, mirroring the image layout.
    const usrBin = path.join(workspace, "usr", "bin");
    fs.mkdirSync(usrBin, { recursive: true });
    const fakeGh = path.join(usrBin, "gh");
    fs.writeFileSync(fakeGh, '#!/bin/sh\necho "gh version 2.23.0"\n', "utf8");
    fs.chmodSync(fakeGh, 0o755);

    process.env.PATH = `${usrBin}:${process.env.PATH ?? ""}`;
    registerWithoutOsSandbox();
    // What the gateway sets from the connector's declaration.
    process.env.NIX_PACKAGES = "gh";
    delete process.env.LOBU_WORKSPACE_BACKEND;

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    const result = await ops.exec("gh --version", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("gh version");
  });

  test("REGRESSION: a declared package registers its command, not its name", async () => {
    // A nix attribute does not name the command it installs: `ripgrep` installs
    // `rg`. Deriving the command from the attribute registered `ripgrep` (which
    // does not exist) and left `rg` unregistered, so a declared tool baked into
    // the image was still unusable.
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-pkgname-"))
    );
    tempDirs.push(workspace);

    const usrBin = path.join(workspace, "usr", "bin");
    fs.mkdirSync(usrBin, { recursive: true });
    const fakeRg = path.join(usrBin, "rg");
    fs.writeFileSync(fakeRg, '#!/bin/sh\necho "ripgrep 14.1.0"\n', "utf8");
    fs.chmodSync(fakeRg, 0o755);

    process.env.PATH = `${usrBin}:${process.env.PATH ?? ""}`;
    registerWithoutOsSandbox();
    process.env.NIX_PACKAGES = "ripgrep";
    delete process.env.LOBU_WORKSPACE_BACKEND;

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    const result = await ops.exec("rg --version", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("ripgrep 14.1.0");
  });

  test("an undeclared PATH binary stays unavailable", async () => {
    // The contributed-CLI discovery must widen to DECLARED tools only. If it
    // registered whatever is on PATH, it would undo the sandbox property the
    // first test in this file pins.
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-undeclared-"))
    );
    tempDirs.push(workspace);

    const usrBin = path.join(workspace, "usr", "bin");
    fs.mkdirSync(usrBin, { recursive: true });
    const sneaky = path.join(usrBin, "sneakytool");
    fs.writeFileSync(sneaky, '#!/bin/sh\necho "should not run"\n', "utf8");
    fs.chmodSync(sneaky, 0o755);

    process.env.PATH = `${usrBin}:${process.env.PATH ?? ""}`;
    // Registration is deliberately ON here: if discovery widened to whatever is
    // on PATH, `sneakytool` would run and print, so this stays a real assertion
    // rather than one that passes because nothing was registered at all.
    registerWithoutOsSandbox();
    // `gh` is declared; `sneakytool` is not.
    process.env.NIX_PACKAGES = "gh";
    delete process.env.LOBU_WORKSPACE_BACKEND;

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    const result = await ops.exec("sneakytool", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });

    expect(result.exitCode).not.toBe(0);
    expect(chunks.join("")).not.toContain("should not run");
  });

  test("SECURITY: a declared binary stays unavailable without a real sandbox", async () => {
    // Every worker and the gateway share the app container as the same user, so
    // a shell-capable CLI (gh runs extensions and aliases) with no per-exec
    // sandbox can read sibling workspaces/{agentId} directories and the
    // gateway's environment. An earlier revision of this branch added a
    // "the pod boundary is isolation enough" bypass; it was not — a registered
    // tool read another tenant's workspace file. Exiting 127 is the correct,
    // safe outcome until the deployment supplies a bwrap-capable profile.
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-nosandbox-"))
    );
    tempDirs.push(workspace);

    const usrBin = path.join(workspace, "usr", "bin");
    fs.mkdirSync(usrBin, { recursive: true });
    const fakeGh = path.join(usrBin, "gh");
    fs.writeFileSync(fakeGh, '#!/bin/sh\necho "gh version 2.23.0"\n', "utf8");
    fs.chmodSync(fakeGh, 0o755);

    process.env.PATH = `${usrBin}:${process.env.PATH ?? ""}`;
    process.env.LOBU_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
    // Declared, and still must not run: declaration is not authorization.
    process.env.NIX_PACKAGES = "gh";
    delete process.env.LOBU_WORKSPACE_BACKEND;

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    const result = await ops.exec("gh --version", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });

    expect(result.exitCode).not.toBe(0);
    expect(chunks.join("")).not.toContain("gh version 2.23.0");
  });

  // The one test here that genuinely needs a real sandbox: the interpreter gate
  // and the registration gate read the same LOBU_ALLOW_UNSANDBOXED_EXEC, so the
  // opt-in shortcut used above would unlock the very thing under test. Let the
  // probe auto-detect instead of naming a backend, since pinning one fails
  // closed on the other platform. This skip cannot hide a broken sandbox in CI:
  // exec-sandbox.test.ts fails the same job under LOBU_REQUIRE_EXEC_SANDBOX=1
  // when bwrap is missing.
  (realSandboxAvailable ? test : test.skip)(
    "interpreters stay gated even when declared",
    async () => {
      // Kept from the bot's revision: LOBU_ALLOW_UNSANDBOXED_EXEC is what unlocks
      // node/bun/python, and DECLARING an interpreter must not substitute for it.
      // Placed under /nix/store so discovery genuinely reaches it and rejects it.
      const workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lobu-interp-"))
      );
      tempDirs.push(workspace);

      const nixBin = path.join(workspace, "nix", "store", "iface", "bin");
      fs.mkdirSync(nixBin, { recursive: true });
      const gatedNames = [
        "node",
        "bunx",
        "uvx",
        "nix-store",
        "nix-channel",
        "nix-instantiate",
        "nix-prefetch-url",
        "nix-collect-garbage",
        "nix-copy-closure",
      ];
      for (const name of gatedNames) {
        const fake = path.join(nixBin, name);
        fs.writeFileSync(fake, '#!/bin/sh\necho "interpreter ran"\n', "utf8");
        fs.chmodSync(fake, 0o755);
      }

      process.env.PATH = `${nixBin}:${process.env.PATH ?? ""}`;
      delete process.env.LOBU_EXEC_SANDBOX;
      delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
      process.env.NIX_PACKAGES = "nodejs";
      delete process.env.LOBU_WORKSPACE_BACKEND;

      const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
      for (const name of gatedNames) {
        const chunks: string[] = [];
        const result = await ops.exec(name, "/", {
          onData: (chunk) => chunks.push(chunk.toString()),
          timeout: 5,
        });

        expect(chunks.join("")).not.toContain("interpreter ran");
        expect(result.exitCode).not.toBe(0);
      }
    }
  );

  // Built-in curl/wget are transport-only clients of the gateway egress
  // proxy: URL policy lives in the proxy (grants/denylist/SSRF/judge), not in
  // the worker. These tests are fully hermetic — the "gateway proxy" is a
  // local recording HTTP proxy that answers absolute-URI requests itself, so
  // no DNS and no live network is ever needed (`wandr-egress.test` never
  // resolves; only the proxy sees it).
  describe("built-in curl egress via the gateway proxy", () => {
    async function curlViaProxy(
      handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
      command: string
    ): Promise<{ output: string; proxied: string[]; auths: string[] }> {
      const proxied: string[] = [];
      const auths: string[] = [];
      const proxy = http.createServer((req, res) => {
        proxied.push(`${req.method} ${req.url}`);
        auths.push(req.headers["proxy-authorization"] ?? "NONE");
        handler(req, res);
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, "127.0.0.1", resolve)
      );
      const address = proxy.address();
      if (typeof address !== "object" || !address) {
        throw new Error("proxy did not bind");
      }
      try {
        // Credentialed, like the real gateway proxy URL
        // (http://<deployment>:<token>@host) — auth must survive the transport.
        process.env.HTTP_PROXY = `http://dep:tok@127.0.0.1:${address.port}`;
        process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
        process.env.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify(["*"]);
        const workspace = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "lobu-egress-"))
        );
        tempDirs.push(workspace);
        const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
        const chunks: string[] = [];
        await ops.exec(command, "/", {
          onData: (chunk) => chunks.push(chunk.toString()),
          timeout: 8,
        });
        return { output: chunks.join(""), proxied, auths };
      } finally {
        proxy.close();
      }
    }

    test("routes requests through the proxy with credentials and returns the body", async () => {
      const { output, proxied, auths } = await curlViaProxy(
        (_req, res) => res.end("proxy-delivered-body"),
        "curl -sS http://wandr-egress.test/hello"
      );
      expect(output).toContain("proxy-delivered-body");
      // Absolute-URI request line proves the proxy (not DNS) served it, and
      // that method + full path are visible to gateway policy.
      // Bun includes the default port in the URI; Node does not.
      expect(proxied).toHaveLength(1);
      expect(proxied[0]).toMatch(
        /^GET http:\/\/wandr-egress\.test(:80)?\/hello$/
      );
      // Basic base64("dep:tok") — the gateway proxy requires auth.
      expect(auths).toEqual(["Basic ZGVwOnRvaw=="]);
    });

    test("follows redirects with every hop transiting the proxy, auth intact", async () => {
      const { output, proxied, auths } = await curlViaProxy((req, res) => {
        if (req.url?.endsWith("/redirect-me")) {
          res.writeHead(302, { location: "http://wandr-egress.test/final" });
          res.end();
          return;
        }
        res.end("final-hop-body");
      }, "curl -sSL http://wandr-egress.test/redirect-me");
      expect(output).toContain("final-hop-body");
      expect(proxied).toHaveLength(2);
      expect(proxied[0]).toMatch(
        /^GET http:\/\/wandr-egress\.test(:80)?\/redirect-me$/
      );
      expect(proxied[1]).toMatch(
        /^GET http:\/\/wandr-egress\.test(:80)?\/final$/
      );
      expect(auths).toEqual(["Basic ZGVwOnRvaw==", "Basic ZGVwOnRvaw=="]);
    });

    test("a proxy denial is surfaced to the agent (single policy point)", async () => {
      const { output, proxied } = await curlViaProxy((_req, res) => {
        res.writeHead(403);
        res.end("denied-by-gateway-proxy");
      }, "curl -sS http://blocked.example/");
      expect(proxied).toHaveLength(1);
      expect(proxied[0]).toMatch(/^GET http:\/\/blocked\.example(:80)?\/$/);
      expect(output).toContain("denied-by-gateway-proxy");
    });

    test("an oversized chunked response is cut off at the size cap", async () => {
      // 33MB chunked (no content-length) — must be aborted while streaming,
      // not buffered whole and then rejected.
      const chunk = Buffer.alloc(1024 * 1024, "x");
      const { output } = await curlViaProxy((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        for (let i = 0; i < 33; i++) res.write(chunk);
        res.end();
      }, "curl -sS http://wandr-egress.test/huge");
      expect(output).toContain("Response too large");
    }, 20_000);

    test("fails closed when no gateway proxy is configured", async () => {
      process.env.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify(["*"]);
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      const workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lobu-egress-"))
      );
      tempDirs.push(workspace);
      const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
      const chunks: string[] = [];
      await ops.exec("curl -sS http://wandr-egress.test/", "/", {
        onData: (chunk) => chunks.push(chunk.toString()),
        timeout: 8,
      });
      expect(chunks.join("")).toContain("egress proxy not configured");
    });

    // The Node transport branch (undici + ProxyAgent, proxyTunnel:false)
    // only executes under Node, so exercise it in a spawned `node` child
    // against the built dist. Skipped when dist isn't built (CI unit job
    // runs from src); the branch is CI-covered indirectly via sdk-e2e and
    // verified here on any dev machine with a build.
    const distBootstrap = path.resolve(
      __dirname,
      "../../dist/embedded/just-bash-bootstrap.js"
    );
    test.skipIf(!fs.existsSync(distBootstrap))(
      "node transport: absolute-form method/path + auth via the proxy",
      async () => {
        const script = `
          const http = require("node:http");
          const fs = require("node:fs");
          const seen = [];
          const proxy = http.createServer((req, res) => {
            seen.push(req.method + " " + req.url + " " + (req.headers["proxy-authorization"] || "NONE"));
            res.end("node-proxy-body");
          });
          proxy.listen(0, "127.0.0.1", async () => {
            process.env.HTTP_PROXY = "http://dep:tok@127.0.0.1:" + proxy.address().port;
            process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
            process.env.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify(["*"]);
            const { createEmbeddedBashOps } = await import(${JSON.stringify(distBootstrap)});
            const ws = fs.mkdtempSync("/tmp/node-transport-");
            const ops = await createEmbeddedBashOps({ workspaceDir: ws });
            let out = "";
            const r = await ops.exec("curl -sS -X DELETE http://wandr-egress.test/thing", ws, {
              onData: (b) => { out += b.toString(); },
              timeout: 15,
            });
            console.log(JSON.stringify({ exit: r.exitCode, out, seen }));
            proxy.close();
            fs.rmSync(ws, { recursive: true, force: true });
            process.exit(0);
          });
        `;
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile("node", ["-e", script], { timeout: 30_000 }, (err, out) =>
            err ? reject(err) : resolve(out)
          );
        });
        const lastLine = stdout.trim().split("\n").at(-1) ?? "";
        const result = JSON.parse(lastLine) as {
          exit: number;
          out: string;
          seen: string[];
        };
        expect(result.exit).toBe(0);
        expect(result.out).toContain("node-proxy-body");
        expect(result.seen).toEqual([
          "DELETE http://wandr-egress.test/thing Basic ZGVwOnRvaw==",
        ]);
      },
      40_000
    );

    test("a dying worker's stale events do not poison its replacement", async () => {
      const { getEgressWorkerForTests } = await import(
        "../embedded/egress-fetch"
      );
      const { output: first } = await curlViaProxy(async (_req, res) => {
        res.end("lifecycle-body");
      }, "curl -sS http://wandr-egress.test/first");
      expect(first).toContain("lifecycle-body");
      const workerA = getEgressWorkerForTests();
      expect(workerA).not.toBeNull();
      // 'error' is typically followed by 'exit'; between the two a
      // replacement worker may already own new pending requests. The stale
      // worker's second event must not reject those.
      workerA?.emit("error", new Error("synthetic failure"));
      const secondRun = curlViaProxy(async (_req, res) => {
        res.end("replacement-body");
      }, "curl -sS http://wandr-egress.test/second");
      await workerA?.terminate(); // fires the stale 'exit'
      const { output: second } = await secondRun;
      expect(second).toContain("replacement-body");
      expect(getEgressWorkerForTests()).not.toBe(workerA);
    });

    test("no network config leaves curl unregistered", async () => {
      delete process.env.JUST_BASH_ALLOWED_DOMAINS;
      const workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lobu-egress-"))
      );
      tempDirs.push(workspace);
      const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
      const chunks: string[] = [];
      await ops.exec("curl -sS http://wandr-egress.test/", "/", {
        onData: (chunk) => chunks.push(chunk.toString()),
        timeout: 8,
      });
      expect(chunks.join("")).toContain("command not found");
    });
  });

  // The pin is load-bearing and the SOLE selector: on a warm deployment reused
  // across conversations pinned to different realms, the per-turn
  // `runtimeProviderId` selects the bash backend and LOBU_RUNTIME_PROVIDER is
  // never consulted. A remote-provider backend requires `gw` params and throws
  // without them; we use that throw as an observable signal of which backend was
  // selected (no live sandbox needed).
  describe("per-turn runtimeProviderId is the sole backend selector", () => {
    test("no pinned provider runs local just-bash even when LOBU_RUNTIME_PROVIDER=vercel", async () => {
      const workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "lobu-pin-local-"))
      );
      tempDirs.push(workspace);
      // The env var is deliberately set to a remote provider to prove it is
      // ignored: with no pin and no `gw`, a legacy env-var read would throw
      // "requires gateway parameters". Instead it resolves to local just-bash.
      process.env.LOBU_RUNTIME_PROVIDER = "vercel";

      const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
      const chunks: string[] = [];
      const result = await ops.exec("echo pinned-local", "/", {
        onData: (chunk) => chunks.push(chunk.toString()),
        timeout: 5,
      });
      expect(result.exitCode).toBe(0);
      expect(chunks.join("")).toContain("pinned-local");
    });

    test("a 'vercel' pin routes remote even when LOBU_RUNTIME_PROVIDER is unset", async () => {
      delete process.env.LOBU_RUNTIME_PROVIDER;
      // A remote provider without `gw` throws — proving the PIN (not the unset
      // env var) drove selection to the remote backend.
      await expect(
        createEmbeddedBashOps({ runtimeProviderId: "vercel" })
      ).rejects.toThrow(/requires gateway parameters/);
    });
  });
});

describe("buildBinaryInvocation", () => {
  test("runs node shebang scripts through node", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lobu-lobu-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "lobu");
    fs.writeFileSync(
      scriptPath,
      "#!/usr/bin/env node\nconsole.log('ok');\n",
      "utf8"
    );
    fs.chmodSync(scriptPath, 0o755);

    expect(buildBinaryInvocation(scriptPath, ["version"])).toEqual({
      command: "node",
      args: [scriptPath, "version"],
    });
  });

  test("executes normal binaries directly", () => {
    expect(buildBinaryInvocation("/bin/echo", ["hello"])).toEqual({
      command: "/bin/echo",
      args: ["hello"],
    });
  });

  test("wraps via sandbox when context provided", () => {
    const ws = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-sandbox-"))
    );
    tempDirs.push(ws);
    const r = buildBinaryInvocation("/bin/echo", ["hi"], {
      strategy: { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
      workspaceDir: ws,
      allowNet: false,
    });
    expect(r.command).toBe("/usr/bin/sandbox-exec");
    expect(r.args[0]).toBe("-p");
    expect(r.args).toContain("/bin/echo");
    expect(r.args).toContain("hi");
  });

  test("passes bwrap namespace cwd into the sandbox wrapper", () => {
    const ws = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-sandbox-"))
    );
    tempDirs.push(ws);
    const r = buildBinaryInvocation("/bin/echo", ["hi"], {
      strategy: { kind: "bwrap", path: "/usr/bin/bwrap" },
      workspaceDir: ws,
      bwrapCwd: "/workspace/subdir",
    });
    const chdir = r.args.indexOf("--chdir");
    expect(r.args[chdir + 1]).toBe("/workspace/subdir");
  });

  test("sandbox=none falls through to inner invocation", () => {
    const r = buildBinaryInvocation("/bin/echo", ["hi"], {
      strategy: { kind: "none" },
      workspaceDir: "/tmp",
    });
    expect(r).toEqual({ command: "/bin/echo", args: ["hi"] });
  });
});

// ---------------------------------------------------------------------------
// The REAL package-install boundary: a package manager that is not registered
// as a runnable command in just-bash resolves to "command not found" (exit
// 127) no matter how it is spelled or wrapped. isDirectPackageInstallCommand
// is only an advisory hint; THIS is enforcement, and it is spelling-agnostic
// because the lookup is on the resolved binary name. (PR #2259.)
// ---------------------------------------------------------------------------
describe("filtered package managers are not runnable however spelled", () => {
  test("nix/npm/uvx resolve to exit 127 through quoting and wrappers", async () => {
    // A bare just-bash with NO custom commands registered for these tools —
    // exactly what discoverBinaries() yields after UNSANDBOXED_INTERPRETERS
    // filtering. No OS sandbox needed: just-bash only runs its builtins plus
    // registered commands, so an unregistered binary is "not found".
    const { Bash, InMemoryFs } = await import("just-bash");
    const bash = new Bash({ fs: new InMemoryFs() });

    const evasions = [
      "nix run nixpkgs#hello",
      '"nix" run nixpkgs#hello',
      'n"i"x run nixpkgs#hello',
      "env nix run nixpkgs#hello",
      'sh -c "nix run nixpkgs#hello"',
      'echo "nix run nixpkgs#hello" | sh',
      'git -c alias.x="!nix run x" x',
      "npm install lodash",
      "uvx cowsay",
    ];
    for (const cmd of evasions) {
      const r = await bash.exec(cmd);
      expect(r.exitCode).toBe(127);
      expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain(
        "command not found"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Exec wrappers (env, xargs, find, timeout, …). just-bash ships SAFE builtins
// for these: the builtin `env nix …` resolves `nix` through just-bash's own
// command registry (builtins + registered customCommands), so a filtered `nix`
// is "command not found" and the builtin never re-execs the host. The danger is
// only when discovery REGISTERS a real /nix/store `env` as a custom command —
// buildCustomCommands execFile's that host binary, which re-execs its argv with
// the worker PATH and can reach a filtered interpreter. The wrappers are in
// UNSANDBOXED_INTERPRETERS so discovery drops them by default, leaving the safe
// builtin. These tests pin: (a) the host fixture env never runs by default, and
// `env nix` cannot reach nix; (b) under the explicit opt-in the fixture IS
// registered and runs — which is what makes (a) a real filter assertion. (r5.)
// ---------------------------------------------------------------------------
describe("exec wrappers are filtered from discovery by default", () => {
  function seedFixtureWrapper(): { workspace: string; storeBin: string } {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "lobu-wrapper-"))
    );
    tempDirs.push(workspace);
    // A /nix/store-shaped dir is required: discoverBinaries only scans PATH
    // entries containing "/nix/store/".
    const storeBin = path.join(workspace, "nix", "store", "aaaa-env", "bin");
    fs.mkdirSync(storeBin, { recursive: true });
    const fakeEnv = path.join(storeBin, "env");
    // Prints a sentinel if the HOST binary ever runs, so a re-exec is
    // observable versus the safe builtin (which never prints it).
    fs.writeFileSync(fakeEnv, '#!/bin/sh\necho "HOST-ENV-RAN"\n', "utf8");
    fs.chmodSync(fakeEnv, 0o755);
    return { workspace, storeBin };
  }

  test("default: host env is not registered; env nix cannot reach nix", async () => {
    const { workspace, storeBin } = seedFixtureWrapper();
    process.env.PATH = `${storeBin}:${process.env.PATH ?? ""}`;
    // Opt-in OFF is the point: the discovery filter drops the host `env`, so the
    // safe builtin handles it. (The opt-in would bypass the filter.)
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
    delete process.env.LOBU_EXEC_SANDBOX;
    resetSandboxProbeForTests();

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });

    // The host fixture env must never run — the builtin handles `env`.
    const passthru: string[] = [];
    await ops.exec("env true", "/", {
      onData: (chunk) => passthru.push(chunk.toString()),
      timeout: 5,
    });
    expect(passthru.join("")).not.toContain("HOST-ENV-RAN");

    // And `env nix run` cannot reach a nix — the builtin resolves `nix` in the
    // just-bash registry, where it is filtered → command not found.
    const chunks: string[] = [];
    const nixResult = await ops.exec("env nix run nixpkgs#hello", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });
    expect(nixResult.exitCode).toBe(127);
    expect(chunks.join("")).toContain("command not found");
  });

  test("opt-in ON: the same fixture env IS registered and runs (filter is real)", async () => {
    const { workspace, storeBin } = seedFixtureWrapper();
    process.env.PATH = `${storeBin}:${process.env.PATH ?? ""}`;
    // Opt-in bypasses the filter, so the host `env` is registered and takes
    // precedence over the builtin; this proves the default suppression above is
    // the FILTER at work, not a missing fixture.
    registerWithoutOsSandbox();

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    await ops.exec("env true", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });
    expect(chunks.join("")).toContain("HOST-ENV-RAN");
  });
});
