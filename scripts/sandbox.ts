#!/usr/bin/env bun
/**
 * Per-worktree remote dev sandbox (Daytona).
 *
 * Why this exists: many concurrent worktrees exhaust local memory and compete
 * for ports and database resources. Each remote sandbox gets its own kernel,
 * ports, and embedded Postgres.
 *
 * HARD PLATFORM LIMITS, measured 2026-08-21 against this org:
 *   - 8GB maximum per sandbox (the API rejects more outright)
 *   - 10GB maximum TOTAL memory across RUNNING sandboxes
 * At the 4GB default that is two running at once. `pause` is not supported
 * on this tier, but `stop` frees the quota without rebuilding the image, so
 * the model here is: a sandbox per worktree, but only the ones you are
 * actively using are started. `up` enforces the cap before it starts one.
 *
 *   bun scripts/sandbox.ts up     create-or-start, sync, install, boot, print URL
 *   bun scripts/sandbox.ts sync   re-upload the tree without restarting the app
 *   bun scripts/sandbox.ts url    print the preview URL
 *   bun scripts/sandbox.ts stop   stop it (frees quota; disk and DB survive)
 *   bun scripts/sandbox.ts rm     delete it permanently
 *   bun scripts/sandbox.ts ls     every lobu sandbox + quota headroom
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  Daytona,
  DaytonaNotFoundError,
  Image,
  type Sandbox,
} from "@daytonaio/sdk";

const MEMORY_GB = Number(process.env.SANDBOX_MEMORY_GB ?? 4);
const CPU = Number(process.env.SANDBOX_CPU ?? 4);
const DISK_GB = Number(process.env.SANDBOX_DISK_GB ?? 10);
const TOTAL_MEMORY_CAP_GB = 10; // org tier limit; the API enforces it too
const APP_PORT = 8787; // fixed: a sandbox has no neighbours to collide with
const WORKSPACE = "/workspace/lobu";

function sh(
  cmd: string,
  args: string[],
  cwd?: string,
  extraEnv?: NodeJS.ProcessEnv
): string {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr?.trim()}`);
  }
  return r.stdout;
}

function repoRoot(): string {
  return sh("git", ["rev-parse", "--show-toplevel"]).trim();
}

/**
 * A private sandbox's preview host rejects an unauthenticated request. The
 * `x-daytona-preview-token` header is the API form; a browser cannot set one,
 * so the query parameter is what makes the printed link actually clickable.
 */
export function authenticatedUrl(url: string, token?: string): string {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}DAYTONA_SANDBOX_AUTH_KEY=${encodeURIComponent(token)}`;
}

/** Include the absolute path hash to avoid collisions between checkouts. */
export function sandboxName(root: string): string {
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace";
  const pathHash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `lobu-dev-${slug}-${pathHash}`;
}

/**
 * Tar the working tree as the sandbox should see it: tracked files plus
 * untracked-but-not-ignored, which is exactly what `-z -co --exclude-standard`
 * yields. That deliberately excludes node_modules and dist (the sandbox builds
 * its own). .env is NOT added back here: it is uploaded separately with its
 * host-only keys stripped, so the sandbox cannot inherit the Mac's
 * DATABASE_URL. The submodule is archived separately because git does not
 * descend into it.
 */
const NO_APPLEDOUBLE = { COPYFILE_DISABLE: "1" };

/**
 * AppleDouble sidecars keep the original extension, so `._<name>.sql` is picked
 * up by the migration runner's *.sql scan and its binary header is sent to
 * Postgres as a query — which fails the whole boot as `invalid message format`
 * (08P01), naming nothing that leads back here. They reach a sandbox two ways:
 * already on disk (a copy through a non-native filesystem), which this filters,
 * and minted by macOS tar for xattr-carrying files, which COPYFILE_DISABLE
 * suppresses. Neither is ever legitimate content.
 */
export function isAppleDouble(file: string): boolean {
  return basename(file).startsWith("._");
}

function gitFiles(root: string): string[] {
  return sh("git", ["ls-files", "-z", "-co", "--exclude-standard"], root)
    .split("\0")
    .filter(Boolean);
}

function writeNullList(path: string, files: string[]) {
  writeFileSync(path, files.length > 0 ? `${files.join("\0")}\0` : "");
}

export function buildTarball(root: string): string {
  const stage = mkdtempSync(join(tmpdir(), "lobu-sandbox-"));
  const tar = join(stage, "tree.tar.gz");
  const files = gitFiles(root)
    // .env is excluded explicitly rather than left to .gitignore: it is
    // uploaded separately with host-specific keys stripped (see
    // HOST_ONLY_ENV_KEYS), and a checkout that happens to track it would
    // otherwise send the Mac's DATABASE_URL straight into the sandbox.
    // .env.local is never sent at all — it is only this worktree's ports.
    .filter(
      (f) =>
        f !== "packages/owletto" &&
        !f.startsWith("packages/owletto/") &&
        f !== ".env" &&
        f !== ".env.local" &&
        !isAppleDouble(f)
    );

  const listFile = join(stage, "files.txt");
  writeNullList(listFile, files);
  sh(
    "tar",
    ["-czf", tar, "-C", root, "--null", "-T", listFile],
    undefined,
    NO_APPLEDOUBLE
  );

  // Submodule content at its current checkout. The sandbox has no .git and
  // owletto is private, so it cannot fetch this itself.
  const sub = join(root, "packages/owletto");
  let subFiles: string[] = [];
  if (existsSync(join(sub, ".git"))) {
    const subTar = join(stage, "owletto.tar.gz");
    subFiles = gitFiles(sub).filter(
      (f) => f !== ".env" && f !== ".env.local" && !isAppleDouble(f)
    );
    const subList = join(stage, "sub.txt");
    writeNullList(subList, subFiles);
    sh(
      "tar",
      ["-czf", subTar, "-C", sub, "--null", "-T", subList],
      undefined,
      NO_APPLEDOUBLE
    );
  }
  writeNullList(join(stage, "manifest.bin"), [
    ...files,
    ...subFiles.map((file) => `packages/owletto/${file}`),
  ]);
  return stage;
}

/**
 * Auth without asking anyone to set up a second credential: if DAYTONA_API_KEY
 * is not set, reuse the JWT the `daytona` CLI already stores after `daytona
 * login`. The SDK accepts jwtToken + organizationId directly, so a developer
 * who can run `daytona list` can run this with no extra configuration.
 */
function cliCredentials(): {
  jwtToken: string;
  organizationId: string;
  apiUrl?: string;
} | null {
  const cfgPath = join(
    homedir(),
    "Library/Application Support/daytona/config.json"
  );
  const xdg = join(homedir(), ".config/daytona/config.json");
  const path = existsSync(cfgPath) ? cfgPath : existsSync(xdg) ? xdg : null;
  if (!path) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const profile =
      (cfg.profiles ?? []).find(
        (p: { id?: string }) => p.id === cfg.activeProfile
      ) ?? (cfg.profiles ?? [])[0];
    const token = profile?.api?.token;
    if (!token?.accessToken || !profile?.activeOrganizationId) return null;
    if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
      console.error("daytona CLI token has expired — run: daytona login");
      process.exit(1);
    }
    return {
      jwtToken: token.accessToken,
      organizationId: profile.activeOrganizationId,
      apiUrl: profile?.api?.url,
    };
  } catch {
    return null;
  }
}

/**
 * Keys whose host values are actively wrong inside a sandbox. DATABASE_URL is
 * the dangerous one: the copied .env points at the Mac's Postgres, which is not
 * reachable at the same loopback address inside the sandbox — and dev-native.sh
 * selects its backend by the DATABASE_URL scheme, so dropping it is what makes
 * the sandbox provision its own embedded Postgres.
 * DAYTONA_* control-plane credentials are also never copied into the sandbox.
 */
export const HOST_ONLY_ENV_KEYS = [
  "DATABASE_URL",
  "PORT",
  "WORKER_PROXY_PORT",
  "PUBLIC_GATEWAY_URL",
  "HOST",
  "LOBU_EMBEDDED",
];

export function sanitizedEnv(root: string): string | null {
  const src = join(root, ".env");
  if (!existsSync(src)) return null;
  return readFileSync(src, "utf8")
    .split("\n")
    .filter((line) => {
      const key = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
      )?.[1];
      return (
        !key ||
        (!HOST_ONLY_ENV_KEYS.includes(key) && !key.startsWith("DAYTONA_"))
      );
    })
    .join("\n");
}

async function client() {
  if (process.env.DAYTONA_API_KEY) {
    return new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  }
  const creds = cliCredentials();
  if (creds) return new Daytona(creds);
  console.error(
    "No Daytona credentials. Run `daytona login`, or set DAYTONA_API_KEY."
  );
  process.exit(1);
}

/** `daytona.list()` is an AsyncIterableIterator, not an array. */
async function listAll(daytona: Awaited<ReturnType<typeof client>>) {
  const out: Sandbox[] = [];
  for await (const s of daytona.list()) out.push(s);
  return out;
}

async function findSandbox(
  daytona: Awaited<ReturnType<typeof client>>,
  name: string
) {
  try {
    return await daytona.get(name);
  } catch (err) {
    if (err instanceof DaytonaNotFoundError) return undefined;
    throw err;
  }
}

function stateOf(s: Sandbox): string {
  return String(s.state ?? "unknown");
}

async function runningMemoryGb(daytona: Awaited<ReturnType<typeof client>>) {
  const all = await listAll(daytona);
  return memoryOfRunning(all);
}

function memoryOfRunning(all: Sandbox[]) {
  const running = all.filter((s) => /start|running/i.test(stateOf(s)));
  const used = running.reduce((n, s) => n + s.memory, 0);
  return { used, running };
}

/** Refuse to blow the org cap; the API error is opaque, this one is not. */
async function assertQuota(
  daytona: Awaited<ReturnType<typeof client>>,
  need: number,
  self: string
) {
  const { running } = await runningMemoryGb(daytona);
  const others = running.filter((s) => s.name !== self);
  const usedByOthers = others.reduce((n, s) => n + s.memory, 0);
  if (usedByOthers + need <= TOTAL_MEMORY_CAP_GB) return;
  console.error(
    `\nStarting ${self} (${need}GB) would exceed the ${TOTAL_MEMORY_CAP_GB}GB org cap.` +
      `\n${usedByOthers}GB is already used by running sandboxes:\n` +
      others.map((s) => `  ${s.name}  ${stateOf(s)}`).join("\n") +
      `\n\nStop one first (its disk and database survive):` +
      `\n  bun scripts/sandbox.ts stop            # in that worktree` +
      "\n"
  );
  process.exit(1);
}

async function exec(sandbox: Sandbox, cmd: string, timeoutSec = 1800) {
  const res = await sandbox.process.executeCommand(
    cmd,
    WORKSPACE,
    undefined,
    timeoutSec
  );
  const out = String(res?.result ?? "");
  if (res?.exitCode !== 0) {
    throw new Error(
      `remote command failed (exit ${res?.exitCode}):\n${out.slice(-4000)}`
    );
  }
  return out;
}

async function syncTree(sandbox: Sandbox, root: string) {
  const stage = buildTarball(root);
  try {
    const fs = sandbox.fs;
    console.log(">> uploading tree");
    await fs.uploadFile(join(stage, "tree.tar.gz"), "/tmp/tree.tar.gz");
    await fs.uploadFile(
      join(stage, "manifest.bin"),
      "/tmp/lobu-sandbox-manifest"
    );
    await exec(
      sandbox,
      "rm -rf /tmp/lobu-source && mkdir -p /tmp/lobu-source && tar -xzf /tmp/tree.tar.gz -C /tmp/lobu-source"
    );
    if (existsSync(join(stage, "owletto.tar.gz"))) {
      await fs.uploadFile(join(stage, "owletto.tar.gz"), "/tmp/owletto.tar.gz");
      await exec(
        sandbox,
        "mkdir -p /tmp/lobu-source/packages/owletto && tar -xzf /tmp/owletto.tar.gz -C /tmp/lobu-source/packages/owletto"
      );
    }
    // Delete only files sent by the previous sync. Ignored runtime state
    // (node_modules, dist, workspaces, and .lobu-dev) is never in this manifest,
    // so source deletions propagate without erasing the warm install or database.
    await exec(
      sandbox,
      `mkdir -p ${WORKSPACE} && ` +
        `if [ -f /workspace/.lobu-sandbox-manifest ]; then ` +
        `(cd ${WORKSPACE} && while IFS= read -r -d '' path; do ` +
        `case "$path" in ''|.|..|/*|../*|*/../*|*/..) echo "invalid sync path: $path" >&2; exit 1;; esac; ` +
        `rm -rf -- "$path"; done < /workspace/.lobu-sandbox-manifest); fi && ` +
        `cp -a /tmp/lobu-source/. ${WORKSPACE}/ && ` +
        "cp /tmp/lobu-sandbox-manifest /workspace/.lobu-sandbox-manifest"
    );
    // Clean legacy sidecars from sandboxes created before the manifest existed.
    await exec(sandbox, `find ${WORKSPACE} -name '._*' -type f -delete`, 300);

    const env = sanitizedEnv(root);
    if (env !== null) {
      const envFile = join(stage, "env.sanitized");
      writeFileSync(envFile, env);
      await fs.uploadFile(envFile, `${WORKSPACE}/.env`);
    } else {
      await exec(sandbox, `rm -f ${WORKSPACE}/.env`, 60);
    }
    await exec(sandbox, `rm -f ${WORKSPACE}/.env.local`, 60);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function bootApp(sandbox: Sandbox, previewUrl: string) {
  // PUBLIC_GATEWAY_URL must be the preview URL before boot: the server hands
  // the SPA absolute sse/messages URLs, and a wrong origin breaks chat and
  // stamps MCP asset URLs the host sandbox then rejects.
  // No DATABASE_URL in the env or the sanitized .env, so dev-native.sh runs
  // its embedded Postgres (backend choice keys on the DATABASE_URL scheme).
  const env = [
    `PORT=${APP_PORT}`,
    "HOST=0.0.0.0",
    `PUBLIC_GATEWAY_URL=${previewUrl}/lobu`,
  ].join(" ");
  await exec(
    sandbox,
    "pkill -f '[d]ev-native.sh' || true; pkill -f '[l]obu run' || true",
    120
  );
  // `cmd &` alone is not enough: executeCommand waits on the whole process
  // group, so a bare background job hangs until the app exits. The subshell
  // plus closed stdin detaches it and lets exec return immediately.
  await exec(
    sandbox,
    `cd ${WORKSPACE} && ( env ${env} nohup ./scripts/dev-native.sh > /workspace/dev.log 2>&1 </dev/null & ) ; echo started`,
    120
  );
}

/**
 * The first boot builds every workspace package, which takes minutes — so
 * returning a URL right after launch would be a lie. Poll readiness from
 * inside the sandbox and say plainly whether it came up.
 */
async function waitReady(sandbox: Sandbox, timeoutSec = 900): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastNote = 0;
  while (Date.now() < deadline) {
    const out = await exec(
      sandbox,
      `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${APP_PORT}/health/ready || echo down`,
      60
    ).catch(() => "down");
    if (/^2\d\d/.test(out.trim())) return true;
    if (Date.now() - lastNote > 60_000) {
      lastNote = Date.now();
      const tail = await exec(
        sandbox,
        "tail -n 2 /workspace/dev.log || true",
        60
      ).catch(() => "");
      console.log(`   still starting… ${tail.trim().split("\n").pop() ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

async function main() {
  const cmd = process.argv[2] ?? "up";
  const commands = ["up", "sync", "run", "url", "logs", "stop", "rm", "ls"];
  if (!commands.includes(cmd)) {
    console.error(`unknown command '${cmd}' (${commands.join(" | ")})`);
    process.exit(1);
  }
  const remoteCommand = process.argv.slice(3).join(" ") || process.env.CMD;
  if (cmd === "run" && !remoteCommand) {
    console.error("usage: sandbox.ts run <command>");
    process.exit(1);
  }
  const root = repoRoot();
  const name = sandboxName(root);
  const daytona = await client();

  if (cmd === "ls") {
    const all = await listAll(daytona);
    const { used, running } = memoryOfRunning(all);
    for (const s of all) {
      const n = s.name;
      if (!n.startsWith("lobu-")) continue;
      console.log(`${n.padEnd(34)} ${stateOf(s).padEnd(10)} ${s.memory}GB`);
    }
    console.log(
      `\nrunning: ${used}GB / ${TOTAL_MEMORY_CAP_GB}GB cap (${running.length} started)`
    );
    return;
  }

  let sandbox = await findSandbox(daytona, name);

  if (cmd === "rm") {
    if (!sandbox) return console.log(`no sandbox ${name}`);
    await sandbox.delete();
    return console.log(`deleted ${name}`);
  }
  if (cmd === "stop") {
    if (!sandbox) return console.log(`no sandbox ${name}`);
    await sandbox.stop();
    return console.log(`stopped ${name} — quota freed, disk and database kept`);
  }
  if (cmd === "logs") {
    if (!sandbox) {
      console.error(`no sandbox ${name}; run: make sandbox`);
      process.exit(1);
    }
    // Request logs can be large, so the default stays small; N=<n> widens it.
    const lines =
      Number(process.env.N) > 0 ? Math.floor(Number(process.env.N)) : 40;
    console.log(
      await exec(
        sandbox,
        `tail -n ${lines} /workspace/dev.log || echo '(no log yet)'`,
        120
      )
    );
    return;
  }
  if (cmd === "run") {
    if (!sandbox) {
      console.error(`no sandbox ${name}; run: make sandbox`);
      process.exit(1);
    }
    // Offloading a build or test suite to the sandbox is the point of having
    // one, so this is a first-class command, not a debug hatch.
    try {
      console.log(
        await exec(sandbox, `cd ${WORKSPACE} && ${remoteCommand}`, 3600)
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }
  if (cmd === "url") {
    if (!sandbox) {
      console.error(`no sandbox ${name}; run: make sandbox`);
      process.exit(1);
    }
    const link = await sandbox.getPreviewLink(APP_PORT);
    console.log(authenticatedUrl(String(link?.url ?? link), link?.token));
    return;
  }

  if (cmd === "sync") {
    if (!sandbox) {
      console.error(`no sandbox ${name}; run: make sandbox`);
      process.exit(1);
    }
    // Tree only: Vite HMR and tsx watch pick the changes up in place, so
    // restarting would throw away a warm process for nothing. `up` is the
    // command that reboots.
    await syncTree(sandbox, root);
    return console.log(`synced ${name} (app left running)`);
  }

  if (!sandbox) {
    await assertQuota(daytona, MEMORY_GB, name);
    console.log(
      `>> creating ${name} (${CPU} cpu / ${MEMORY_GB}GB / ${DISK_GB}GB disk)`
    );
    sandbox = await daytona.create(
      {
        name,
        // A DECLARATIVE image (Image.base), not a snapshot name: passing a
        // plain string is read as a snapshot reference, and snapshots reject
        // a `resources` block ("Cannot specify Sandbox resources when using a
        // snapshot"). Baking bun into the image also means it is present on
        // every restart instead of being curl-installed each boot.
        image: Image.base("ubuntu:24.04")
          .runCommands(
            "apt-get update -qq && apt-get install -y -qq bash curl unzip xz-utils git ca-certificates python3 make build-essential",
            // isolated-vm has no Node 25+ build, and the runtime hard-refuses
            // anything outside 22.x-24.x, so pin to this repo's Node major.
            "curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1",
            "curl -fsSL https://bun.sh/install | bash",
            "ln -sf /root/.bun/bin/bun /usr/local/bin/bun"
          )
          .workdir(WORKSPACE),
        resources: { cpu: CPU, memory: MEMORY_GB, disk: DISK_GB },
        autoStopInterval: 0,
        autoDeleteInterval: -1,
      },
      {
        // Surface image-build output: without this a failed build reports only
        // "build_failed ... error reason: null", which is undiagnosable.
        onSnapshotCreateLogs: (chunk: string) => process.stdout.write(chunk),
        timeout: 1800,
      }
    );
    console.log(
      `>> bun ${(await exec(sandbox, "bun --version", 300)).trim()} in sandbox`
    );
  } else if (!/start|running/i.test(stateOf(sandbox))) {
    const existingMemory = sandbox.memory;
    await assertQuota(daytona, existingMemory, name);
    console.log(`>> starting ${name}`);
    await sandbox.start();
  }

  await syncTree(sandbox, root);
  console.log(">> bun install");
  await exec(sandbox, `cd ${WORKSPACE} && bun install --frozen-lockfile`, 1800);

  const link = await sandbox.getPreviewLink(APP_PORT);
  const url: string = link?.url ?? String(link);
  console.log(">> booting app (first boot builds every workspace package)");
  await bootApp(sandbox, url);
  const ready = await waitReady(sandbox);

  if (!ready) {
    console.error(
      `\n  ${name} did not become ready. Last log lines:\n` +
        (await exec(sandbox, "tail -n 25 /workspace/dev.log || true", 60).catch(
          () => ""
        ))
    );
    process.exit(1);
  }
  console.log(`\n  ${name} ready`);
  console.log(`  app:  ${authenticatedUrl(url, link?.token)}`);
  console.log(`  logs: make sandbox-logs`);
  console.log(`  stop: make sandbox-stop   (frees quota; DB survives)\n`);
}

// Importing this module (the tests do) must not launch a sandbox.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
