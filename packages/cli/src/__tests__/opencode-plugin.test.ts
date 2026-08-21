import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPENCODE_PLUGIN_SOURCE,
  opencodePluginCommand,
} from "../commands/opencode-plugin";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function bridgeRequest(
  socketPath: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(response)));
  });
}

async function loadPlugin(client: Record<string, unknown>) {
  const dir = tempDir("lobu-opencode-plugin-runtime-");
  const sourcePath = path.join(dir, "plugin.mjs");
  writeFileSync(sourcePath, OPENCODE_PLUGIN_SOURCE, { mode: 0o600 });
  const module = await import(
    `${pathToFileURL(sourcePath).href}?test=${Date.now()}-${Math.random()}`
  );
  return module.LobuInteractiveSessionPlugin({ client });
}

describe("lobu opencode-plugin", () => {
  test("install is idempotent and does not rewrite OpenCode config", async () => {
    const configRoot = tempDir("lobu-opencode-install-");
    const opencodeDir = path.join(configRoot, "opencode");
    const configPath = path.join(opencodeDir, "opencode.json");
    const config = '{"model":"anthropic/claude"}\n';
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(configPath, config);
    const env = { XDG_CONFIG_HOME: configRoot };
    const output = spyOn(console, "log").mockImplementation(() => undefined);

    await opencodePluginCommand("install", env);
    await opencodePluginCommand("install", env);
    await opencodePluginCommand("status", env);

    const target = path.join(
      opencodeDir,
      "plugins",
      "lobu-interactive-session.js"
    );
    expect(readFileSync(target, "utf8")).toBe(OPENCODE_PLUGIN_SOURCE);
    expect(lstatSync(target).mode & 0o077).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(output.mock.calls.flat().join(" ")).toContain("is installed");

    await opencodePluginCommand("uninstall", env);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(config);
  });

  test("refuses to overwrite or remove an unrelated plugin file", async () => {
    const configRoot = tempDir("lobu-opencode-unmanaged-");
    const target = path.join(
      configRoot,
      "opencode",
      "plugins",
      "lobu-interactive-session.js"
    );
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export const UserPlugin = async () => ({})\n");
    const env = { XDG_CONFIG_HOME: configRoot };

    expect(opencodePluginCommand("install", env)).rejects.toThrow(
      "not managed by Lobu"
    );
    expect(opencodePluginCommand("uninstall", env)).rejects.toThrow(
      "not managed by Lobu"
    );
    expect(readFileSync(target, "utf8")).toContain("UserPlugin");
  });
});

describe("OpenCode interactive bridge plugin", () => {
  test("injects exact shell session metadata and routes only authenticated exact-session prompts", async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const hooks = await loadPlugin({
      session: {
        async promptAsync(input: Record<string, unknown>) {
          prompts.push(input);
          return { data: undefined };
        },
      },
    });
    const output = { env: {} as Record<string, string> };
    await hooks["shell.env"](
      { cwd: "/workspace/exact", sessionID: "ses_exact", callID: "call_1" },
      output
    );

    expect(output.env.OPENCODE_SESSION_ID).toBe("ses_exact");
    expect(output.env.OPENCODE_SESSION_DIRECTORY).toBeUndefined();
    expect(output.env.OPENCODE_SERVER_URL).toBeUndefined();
    expect(output.env.LOBU_OPENCODE_BRIDGE_TOKEN).toHaveLength(64);
    expect(lstatSync(output.env.LOBU_OPENCODE_BRIDGE_SOCKET).isSocket()).toBe(
      true
    );
    expect(lstatSync(output.env.LOBU_OPENCODE_BRIDGE_SOCKET).mode & 0o077).toBe(
      0
    );
    expect(
      lstatSync(path.dirname(output.env.LOBU_OPENCODE_BRIDGE_SOCKET)).mode &
        0o077
    ).toBe(0);

    const base = {
      version: 1,
      token: output.env.LOBU_OPENCODE_BRIDGE_TOKEN,
      session_id: "ses_exact",
      prompt: "Automation prompt",
    };
    expect(
      await bridgeRequest(output.env.LOBU_OPENCODE_BRIDGE_SOCKET, {
        ...base,
        token: "0".repeat(64),
      })
    ).toEqual({ ok: false });
    expect(
      await bridgeRequest(output.env.LOBU_OPENCODE_BRIDGE_SOCKET, {
        ...base,
        session_id: "ses_wrong",
      })
    ).toEqual({ ok: false });
    expect(
      await bridgeRequest(output.env.LOBU_OPENCODE_BRIDGE_SOCKET, base)
    ).toEqual({
      ok: true,
      session_id: "ses_exact",
    });
    expect(prompts).toEqual([
      {
        path: { id: "ses_exact" },
        body: { parts: [{ type: "text", text: "Automation prompt" }] },
        query: { directory: "/workspace/exact" },
      },
    ]);

    const bridgeDir = path.dirname(output.env.LOBU_OPENCODE_BRIDGE_SOCKET);
    await hooks.dispose();
    expect(existsSync(bridgeDir)).toBe(false);
  });

  test("isolates tokens per plugin instance and dispose closes accepted sockets", async () => {
    const client = { session: { promptAsync: async () => ({}) } };
    const first = await loadPlugin(client);
    const second = await loadPlugin(client);
    const firstOutput = { env: {} as Record<string, string> };
    const secondOutput = { env: {} as Record<string, string> };
    await first["shell.env"]({ cwd: "/one", sessionID: "same" }, firstOutput);
    await second["shell.env"]({ cwd: "/two", sessionID: "same" }, secondOutput);
    expect(firstOutput.env.LOBU_OPENCODE_BRIDGE_TOKEN).not.toBe(
      secondOutput.env.LOBU_OPENCODE_BRIDGE_TOKEN
    );

    const held = net.createConnection(
      firstOutput.env.LOBU_OPENCODE_BRIDGE_SOCKET
    );
    await new Promise<void>((resolve, reject) => {
      held.once("connect", resolve);
      held.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      held.once("close", () => resolve())
    );
    await first.dispose();
    await closed;
    expect(held.destroyed).toBe(true);
    await second.dispose();
  });
});
