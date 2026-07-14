import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetSandboxProbeForTests } from "../embedded/exec-sandbox";
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
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv("PATH");
  restoreEnv("LOBU_EXEC_SANDBOX");
  restoreEnv("LOBU_ALLOW_UNSANDBOXED_EXEC");
  restoreEnv("LOBU_WORKSPACE_BACKEND");
  restoreEnv("LOBU_RUNTIME_PROVIDER");
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
