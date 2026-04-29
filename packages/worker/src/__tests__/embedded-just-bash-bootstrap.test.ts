import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBinaryInvocation } from "../embedded/just-bash-bootstrap";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  test("sandbox=none falls through to inner invocation", () => {
    const r = buildBinaryInvocation("/bin/echo", ["hi"], {
      strategy: { kind: "none" },
      workspaceDir: "/tmp",
    });
    expect(r).toEqual({ command: "/bin/echo", args: ["hi"] });
  });
});
