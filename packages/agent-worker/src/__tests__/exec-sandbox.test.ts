import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type SandboxStrategy,
  probeSandboxStrategy,
  resetSandboxProbeForTests,
  wrapInvocation,
} from "../embedded/exec-sandbox";

const execFile = promisify(execFileCb);

function tmpWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "exec-sandbox-test-"))
  );
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  resetSandboxProbeForTests();
  delete process.env.OWLETTO_EXEC_SANDBOX;
});

describe("probeSandboxStrategy", () => {
  beforeEach(() => {
    resetSandboxProbeForTests();
  });

  test("returns kind=none when OWLETTO_EXEC_SANDBOX=off", () => {
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    expect(probeSandboxStrategy()).toEqual({ kind: "none" });
  });

  test("auto-detects sandbox-exec on darwin", () => {
    if (process.platform !== "darwin") return;
    const s = probeSandboxStrategy();
    expect(s.kind).toBe("sandbox-exec");
    expect(s.path).toMatch(/sandbox-exec$/);
  });

  test("caches the result across calls", () => {
    const a = probeSandboxStrategy();
    const b = probeSandboxStrategy();
    expect(b).toBe(a);
  });

  test("ignores unknown override and falls back to auto", () => {
    process.env.OWLETTO_EXEC_SANDBOX = "garbage";
    const s = probeSandboxStrategy();
    if (process.platform === "darwin") {
      expect(s.kind).toBe("sandbox-exec");
    } else if (process.platform === "linux") {
      expect(["bwrap", "none"]).toContain(s.kind);
    }
  });

  test("explicit override fails closed when backend unavailable", () => {
    if (process.platform !== "darwin") return;
    process.env.OWLETTO_EXEC_SANDBOX = "bwrap";
    expect(() => probeSandboxStrategy()).toThrow(/bubblewrap is unavailable/);
  });

  test("cache invalidates when override env changes", () => {
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    const a = probeSandboxStrategy();
    expect(a.kind).toBe("none");
    process.env.OWLETTO_EXEC_SANDBOX = "auto";
    const b = probeSandboxStrategy();
    expect(b).not.toBe(a);
  });
});

describe("workspaceDir validation", () => {
  test("sandbox-exec rejects workspaceDir with double-quote", () => {
    expect(() =>
      wrapInvocation(
        { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
        { command: "/bin/cat", args: [] },
        { workspaceDir: '/tmp/evil"; (allow file-read*)', allowNet: false }
      )
    ).toThrow(/unsafe characters/);
  });

  test("sandbox-exec rejects workspaceDir with newline", () => {
    expect(() =>
      wrapInvocation(
        { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
        { command: "/bin/cat", args: [] },
        { workspaceDir: "/tmp/evil\n(allow file-read*)", allowNet: false }
      )
    ).toThrow(/unsafe characters/);
  });

  test("bwrap rejects workspaceDir with paren", () => {
    expect(() =>
      wrapInvocation(
        { kind: "bwrap", path: "/usr/bin/bwrap" },
        { command: "/bin/cat", args: [] },
        { workspaceDir: "/tmp/(evil)", allowNet: false }
      )
    ).toThrow(/unsafe characters/);
  });

  test("accepts plausible developer paths", () => {
    expect(() =>
      wrapInvocation(
        { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
        { command: "/bin/cat", args: [] },
        {
          workspaceDir: "/Users/dev/.lobu/workspaces/thread-123",
          allowNet: false,
        }
      )
    ).not.toThrow();
  });

  test.each([
    ["/", "root"],
    ["/tmp//evil", "double-slash"],
    ["/tmp/../etc", "dotdot segment"],
    ["/tmp/", "trailing slash"],
  ])("rejects non-canonical path: %s (%s)", (badPath) => {
    expect(() =>
      wrapInvocation(
        { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
        { command: "/bin/cat", args: [] },
        { workspaceDir: badPath, allowNet: false }
      )
    ).toThrow();
  });
});

describe("wrapInvocation", () => {
  test("pass-through when strategy.kind === none", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const r = wrapInvocation(
      { kind: "none" },
      { command: "/bin/echo", args: ["hi"] },
      { workspaceDir: ws }
    );
    expect(r).toEqual({ command: "/bin/echo", args: ["hi"] });
  });

  test("sandbox-exec wraps with -p <profile> <cmd> <args>", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const r = wrapInvocation(
      { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
      { command: "/bin/cat", args: ["foo"] },
      { workspaceDir: ws, allowNet: false }
    );
    expect(r.command).toBe("/usr/bin/sandbox-exec");
    expect(r.args[0]).toBe("-p");
    expect(r.args[1]).toContain(`(subpath "${ws}")`);
    expect(r.args[1]).toContain("(deny network*)");
    expect(r.args.slice(2)).toEqual(["/bin/cat", "foo"]);
  });

  test("sandbox-exec emits (allow network*) when allowNet=true", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const r = wrapInvocation(
      { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
      { command: "/bin/cat", args: [] },
      { workspaceDir: ws, allowNet: true }
    );
    expect(r.args[1]).toContain("(allow network*)");
  });

  test("bwrap wraps with bind mounts + -- <cmd> <args>", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const r = wrapInvocation(
      { kind: "bwrap", path: "/usr/bin/bwrap" },
      { command: "/bin/cat", args: ["foo"] },
      { workspaceDir: ws, allowNet: false }
    );
    expect(r.command).toBe("/usr/bin/bwrap");
    expect(r.args).toContain("--bind");
    expect(r.args).toContain(ws);
    expect(r.args).toContain("/workspace");
    const chdir = r.args.indexOf("--chdir");
    expect(r.args[chdir + 1]).toBe("/workspace");
    expect(r.args).toContain("--unshare-net");
    expect(r.args).toContain("--unshare-user");
    expect(r.args).toContain("--new-session");
    expect(r.args).toContain("--die-with-parent");
    expect(r.args).toContain("--");
    const sep = r.args.indexOf("--");
    expect(r.args.slice(sep + 1)).toEqual(["/bin/cat", "foo"]);
  });

  test("bwrap honors requested namespace cwd", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const r = wrapInvocation(
      { kind: "bwrap", path: "/usr/bin/bwrap" },
      { command: "/bin/pwd", args: [] },
      { workspaceDir: ws, bwrapCwd: "/workspace/subdir" }
    );
    const chdir = r.args.indexOf("--chdir");
    expect(r.args[chdir + 1]).toBe("/workspace/subdir");
  });

  test("bwrap rejects namespace cwd outside /workspace", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    expect(() =>
      wrapInvocation(
        { kind: "bwrap", path: "/usr/bin/bwrap" },
        { command: "/bin/pwd", args: [] },
        { workspaceDir: ws, bwrapCwd: "/usr" }
      )
    ).toThrow(/must be \/workspace or below/);
  });

  test("sandbox-exec profile denies var/run unix sockets", () => {
    const ws = tmpWorkspace();
    cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const r = wrapInvocation(
      { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
      { command: "/bin/cat", args: [] },
      { workspaceDir: ws }
    );
    expect(r.args[1]).toContain('(subpath "/var/run")');
    expect(r.args[1]).toContain('(subpath "/private/var/run")');
    expect(r.args[1]).toContain('(subpath "/Library/Preferences")');
  });
});

// Real escape-matrix tests against the live macOS sandbox. Skipped on other
// platforms — the bwrap counterpart runs under CI on Linux.
const isDarwin = process.platform === "darwin";
const describeDarwin = isDarwin ? describe : describe.skip;

describeDarwin("sandbox-exec escape matrix", () => {
  let strategy: SandboxStrategy;
  let workspace: string;

  beforeEach(() => {
    process.env.OWLETTO_EXEC_SANDBOX = "sandbox-exec";
    resetSandboxProbeForTests();
    strategy = probeSandboxStrategy();
    workspace = tmpWorkspace();
    fs.writeFileSync(path.join(workspace, "hello.txt"), "hi from workspace\n");
    cleanups.push(() => fs.rmSync(workspace, { recursive: true, force: true }));
  });

  async function runIn(cmd: string, args: string[]) {
    const r = wrapInvocation(
      strategy,
      { command: cmd, args },
      {
        workspaceDir: workspace,
        allowNet: false,
      }
    );
    try {
      // codeql[js/shell-command-injection-from-environment]: this test intentionally executes the sandbox wrapper via execFile (no shell) to validate isolation.
      const { stdout } = await execFile(r.command, r.args, {
        cwd: workspace,
        timeout: 5000,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: workspace },
      });
      return { ok: true, stdout: stdout.toString() };
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return {
        ok: false,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
        code: err.code,
      };
    }
  }

  test("blocks /etc/passwd", async () => {
    const r = await runIn("/bin/cat", ["/etc/passwd"]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("blocks listing real /Users", async () => {
    const r = await runIn("/bin/ls", ["/Users"]);
    expect(r.ok).toBe(false);
  });

  test("blocks ../../etc/passwd traversal", async () => {
    const r = await runIn("/bin/sh", ["-c", "cat ../../etc/passwd"]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("blocks symlink-to-/etc/passwd", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      "ln -sf /etc/passwd evil && cat evil",
    ]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("blocks write outside workspace", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      "echo pwn > /tmp/spike-pwn-write && cat /tmp/spike-pwn-write",
    ]);
    expect(r.ok).toBe(false);
  });

  test("blocks home-dir secrets", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      `cat ${os.homedir()}/.ssh/id_rsa || cat ${os.homedir()}/.ssh/id_ed25519`,
    ]);
    expect(r.ok).toBe(false);
  });

  test("allows reading workspace file", async () => {
    const r = await runIn("/bin/cat", ["hello.txt"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hi from workspace");
  });

  test("allows writing workspace file", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      "echo wrote > out.txt && cat out.txt",
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("wrote");
  });

  test("argv injection: shell metacharacters not interpreted by execFile", async () => {
    const r = await runIn("/bin/cat", ["hello.txt; cat /etc/passwd"]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });
});

// Real escape-matrix tests against bwrap. Auto-skip when not on Linux, when
// bwrap isn't on PATH, or when user namespaces are blocked at the OS level
// (Ubuntu 24.04 / GitHub Actions default until apparmor sysctl is flipped).
// Probed once at module load so each test starts with a known-good sandbox.
const isLinux = process.platform === "linux";
const linuxBwrapWorks = (() => {
  if (!isLinux) return false;
  const candidates = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
  const bwrapPath = candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!bwrapPath) return false;
  try {
    // Mirror `bwrapDeliversIsolation` in exec-sandbox.ts. /lib64 must be
    // bound because /usr/bin/true's ELF interpreter is /lib64/ld-linux-*.so.
    execFileSync(
      bwrapPath,
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind-try",
        "/bin",
        "/bin",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/usr/bin/true",
      ],
      { stdio: "ignore", timeout: 3000 }
    );
    return true;
  } catch {
    return false;
  }
})();
const describeBwrap = linuxBwrapWorks ? describe : describe.skip;

describeBwrap("bwrap escape matrix", () => {
  let strategy: SandboxStrategy;
  let workspace: string;

  beforeEach(() => {
    process.env.OWLETTO_EXEC_SANDBOX = "bwrap";
    resetSandboxProbeForTests();
    strategy = probeSandboxStrategy();
    workspace = tmpWorkspace();
    fs.writeFileSync(path.join(workspace, "hello.txt"), "hi from workspace\n");
    cleanups.push(() => fs.rmSync(workspace, { recursive: true, force: true }));
  });

  async function runIn(
    cmd: string,
    args: string[],
    allowNet = false,
    bwrapCwd = "/workspace"
  ) {
    if (!strategy || strategy.kind !== "bwrap") {
      return { ok: false, stdout: "", stderr: "skipped", code: -1 };
    }
    const r = wrapInvocation(
      strategy,
      { command: cmd, args },
      {
        workspaceDir: workspace,
        allowNet,
        bwrapCwd,
      }
    );
    try {
      // codeql[js/shell-command-injection-from-environment]: this test intentionally executes the sandbox wrapper via execFile (no shell) to validate isolation.
      const { stdout } = await execFile(r.command, r.args, {
        timeout: 5000,
        env: { PATH: "/usr/bin:/bin", HOME: "/workspace/.sandbox-home" },
      });
      return { ok: true, stdout: stdout.toString() };
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return {
        ok: false,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
        code: err.code,
      };
    }
  }

  test("blocks /etc/passwd outside the bind", async () => {
    // /etc is not bound, so the path doesn't exist inside the namespace at all.
    const r = await runIn("/bin/cat", ["/etc/passwd"]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("blocks listing /home", async () => {
    const r = await runIn("/bin/ls", ["/home"]);
    // /home is not bound; the path either doesn't exist or returns ENOENT.
    expect(r.ok).toBe(false);
  });

  test("blocks ../../etc/passwd traversal from /workspace", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      "cd /workspace && cat ../../etc/passwd",
    ]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("blocks symlink escape from workspace", async () => {
    fs.symlinkSync("/etc/passwd", path.join(workspace, "evil"));
    const r = await runIn("/bin/sh", ["-c", "cat /workspace/evil"]);
    // The symlink target /etc/passwd doesn't exist inside the namespace.
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("blocks writes to ro-bound /usr", async () => {
    // /usr is --ro-bind'd, so writes there are denied at the kernel level
    // regardless of namespace.
    const r = await runIn("/bin/sh", ["-c", "echo pwn > /usr/spike-pwn"]);
    expect(r.ok).toBe(false);
  });

  test("namespace writes don't escape to host filesystem", async () => {
    // The namespace's /etc is a writable empty dir created by bwrap (it's the
    // mountpoint for --ro-bind-try /etc/resolv.conf). Writes there succeed
    // *inside the namespace* but must not affect the host's /etc.
    const marker = `/etc/spike-pwn-${process.pid}-${Date.now()}`;
    await runIn("/bin/sh", ["-c", `echo pwn > ${marker} || true`]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("blocks read of host root filesystem dirs", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      "ls -la /root 2>/dev/null || ls -la /var/log 2>/dev/null",
    ]);
    expect(r.ok && r.stdout.length > 0).toBe(false);
  });

  test("allows reading workspace file via /workspace bind", async () => {
    const r = await runIn("/bin/cat", ["/workspace/hello.txt"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hi from workspace");
  });

  test("runs relative commands from requested bwrap cwd", async () => {
    fs.mkdirSync(path.join(workspace, "subdir"));
    fs.writeFileSync(
      path.join(workspace, "subdir", "local.txt"),
      "from subdir\n"
    );
    const r = await runIn(
      "/bin/cat",
      ["local.txt"],
      false,
      "/workspace/subdir"
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("from subdir");
  });

  test("allows writing inside /workspace", async () => {
    const r = await runIn("/bin/sh", [
      "-c",
      "echo wrote > /workspace/out.txt && cat /workspace/out.txt",
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("wrote");
    expect(fs.readFileSync(path.join(workspace, "out.txt"), "utf8")).toContain(
      "wrote"
    );
  });

  test("argv injection: shell metacharacters in execFile args don't escape", async () => {
    const r = await runIn("/bin/cat", [
      "/workspace/hello.txt; cat /etc/passwd",
    ]);
    expect(r.ok && r.stdout.includes("root:")).toBe(false);
  });

  test("--unshare-net blocks outbound network", async () => {
    // /usr/bin/getent uses libnss; cleanest is just to try a local socket.
    const r = await runIn("/bin/sh", [
      "-c",
      "exec 3<>/dev/tcp/8.8.8.8/53 2>&1; echo $?",
    ]);
    // bwrap's tmpfs at /dev only includes minimal nodes, and --unshare-net
    // means even if /dev/tcp works there's no route. Either is fine.
    if (r.ok) {
      expect(r.stdout.trim()).not.toBe("0");
    }
  });
});
