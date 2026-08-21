import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PLUGIN_MARKER = "// LOBU_OPENCODE_INTERACTIVE_PLUGIN=1";
const PLUGIN_FILENAME = "lobu-interactive-session.js";

export const OPENCODE_PLUGIN_SOURCE = `${PLUGIN_MARKER}
// Managed by \`lobu opencode-plugin\`. Reinstalling updates this file.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const REQUEST_CAP_BYTES = 8 * 1024 * 1024;
function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const LobuInteractiveSessionPlugin = async ({ client }) => {
  const bridgeDir = mkdtempSync(path.join(tmpdir(), "lobu-opencode-"));
  chmodSync(bridgeDir, 0o700);
  const socketPath = path.join(bridgeDir, "bridge.sock");
  const sessions = new Map();
  const sockets = new Set();
  let disposed = false;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const chunks = [];
    let total = 0;
    let handled = false;
    const reply = (value) => {
      if (handled) return;
      handled = true;
      socket.end(JSON.stringify(value) + "\\n");
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      total += chunk.length;
      if (total > REQUEST_CAP_BYTES) {
        reply({ ok: false });
        return;
      }
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0 && newline !== chunk.length - 1) {
        reply({ ok: false });
        return;
      }
      chunks.push(chunk);
      if (newline < 0) return;
      void (async () => {
        let request;
        try {
          request = JSON.parse(
            Buffer.concat(chunks, total).subarray(0, total - 1).toString("utf8")
          );
        } catch {
          reply({ ok: false });
          return;
        }
        const keys = request && typeof request === "object" ? Object.keys(request).sort() : [];
        if (
          disposed ||
          keys.join(",") !== "prompt,session_id,token,version" ||
          request.version !== 1 ||
          typeof request.session_id !== "string" ||
          typeof request.prompt !== "string"
        ) {
          reply({ ok: false });
          return;
        }
        const access = sessions.get(request.session_id);
        if (!access || !equalSecret(request.token, access.token)) {
          reply({ ok: false });
          return;
        }
        try {
          const result = await client.session.promptAsync({
            path: { id: request.session_id },
            body: { parts: [{ type: "text", text: request.prompt }] },
            query: { directory: access.directory },
          });
          if (result && result.error) {
            reply({ ok: false });
            return;
          }
          reply({ ok: true, session_id: request.session_id });
        } catch {
          reply({ ok: false });
        }
      })();
    });
    socket.on("error", () => {});
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    rmSync(bridgeDir, { recursive: true, force: true });
    throw error;
  }
  chmodSync(socketPath, 0o600);

  return {
    "shell.env": async (input, output) => {
      if (!input.sessionID) return;
      let access = sessions.get(input.sessionID);
      if (!access) {
        access = { token: randomBytes(32).toString("hex"), directory: input.cwd };
        sessions.set(input.sessionID, access);
      } else {
        access.directory = input.cwd;
      }
      output.env.OPENCODE_PID = String(process.pid);
      output.env.OPENCODE_SESSION_ID = input.sessionID;
      output.env.LOBU_OPENCODE_BRIDGE_SOCKET = socketPath;
      output.env.LOBU_OPENCODE_BRIDGE_TOKEN = access.token;
    },
    dispose: async () => {
      disposed = true;
      sessions.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(resolve);
      });
      rmSync(bridgeDir, { recursive: true, force: true });
    },
  };
};
`;

export type OpenCodePluginAction = "install" | "status" | "uninstall";

function pluginPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot =
    env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(configRoot, "opencode", "plugins", PLUGIN_FILENAME);
}

function assertOwnerSafe(target: string, kind: "directory" | "file"): void {
  const stat = lstatSync(target);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const expected = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (
    !expected ||
    stat.isSymbolicLink() ||
    (uid != null && stat.uid !== uid) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`refusing unsafe OpenCode plugin ${kind}: ${target}`);
  }
}

function managedPlugin(target: string): boolean {
  try {
    assertOwnerSafe(target, "file");
    return readFileSync(target, "utf8").startsWith(PLUGIN_MARKER);
  } catch {
    return false;
  }
}

export async function opencodePluginCommand(
  action: OpenCodePluginAction,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const target = pluginPath(env);
  const pluginsDir = path.dirname(target);

  if (action === "status") {
    if (!existsSync(target)) {
      console.log(`Lobu OpenCode plugin is not installed (${target})`);
      return;
    }
    if (!managedPlugin(target)) {
      throw new Error(
        `OpenCode plugin path exists but is not Lobu-managed: ${target}`
      );
    }
    const current = readFileSync(target, "utf8") === OPENCODE_PLUGIN_SOURCE;
    console.log(
      `Lobu OpenCode plugin is ${current ? "installed" : "outdated"} (${target})`
    );
    return;
  }

  if (action === "uninstall") {
    if (!existsSync(target)) {
      console.log(`Lobu OpenCode plugin is already absent (${target})`);
      return;
    }
    if (!managedPlugin(target)) {
      throw new Error(
        `refusing to remove a plugin not managed by Lobu: ${target}`
      );
    }
    rmSync(target);
    console.log(`Removed Lobu OpenCode plugin (${target})`);
    return;
  }

  if (existsSync(target) && !managedPlugin(target)) {
    throw new Error(
      `refusing to overwrite a plugin not managed by Lobu: ${target}`
    );
  }
  mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
  assertOwnerSafe(pluginsDir, "directory");
  const temporary = path.join(
    pluginsDir,
    `.${PLUGIN_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    writeFileSync(temporary, OPENCODE_PLUGIN_SOURCE, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`Installed Lobu OpenCode plugin (${target})`);
  console.log("Restart OpenCode to activate it.");
}
