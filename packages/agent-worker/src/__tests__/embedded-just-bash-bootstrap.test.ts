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
  OWLETTO_EXEC_SANDBOX: process.env.OWLETTO_EXEC_SANDBOX,
  LOBU_ALLOW_UNSANDBOXED_EXEC: process.env.LOBU_ALLOW_UNSANDBOXED_EXEC,
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
  restoreEnv("OWLETTO_EXEC_SANDBOX");
  restoreEnv("LOBU_ALLOW_UNSANDBOXED_EXEC");
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
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;

    const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
    const chunks: string[] = [];
    const result = await ops.exec("hostcat /etc/passwd", "/", {
      onData: (chunk) => chunks.push(chunk.toString()),
      timeout: 5,
    });

    expect(result.exitCode).not.toBe(0);
    expect(chunks.join("")).not.toContain("root:");
  });
});

describe("buildBinaryInvocation", () => {
  test("runs node shebang scripts through node", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lobu-owletto-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "owletto");
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
