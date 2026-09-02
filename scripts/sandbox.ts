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
import { createHash, randomBytes } from "node:crypto";
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
/**
 * The embedded Postgres data root sits deliberately OUTSIDE the checkout. The
 * dev server runs Vite in middleware mode, and Vite's `server.fs.allow` spans
 * the whole workspace root, so anything under WORKSPACE is reachable as
 * `/@fs/<path>` — and the cluster's `session` heap holds raw session tokens.
 * Keeping the cluster a sibling of the checkout is what makes a public preview
 * safe to hand out.
 */
const DATA_ROOT = "/workspace/lobu-data";
/** The seat credentials live outside the served tree for the same reason. */
const SEAT_FILE = "/workspace/.lobu-sandbox-seat";

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
 * A PRIVATE sandbox's preview host rejects an unauthenticated request. The
 * `x-daytona-preview-token` header is the API form; a browser cannot set one,
 * so the query parameter is what makes the printed link actually clickable.
 *
 * `up` makes the sandbox public once the seat is claimed, so this is the
 * fallback for a sandbox that is not public (yet) — see previewUrlFor.
 */
export function authenticatedUrl(url: string, token?: string): string {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}DAYTONA_SANDBOX_AUTH_KEY=${encodeURIComponent(token)}`;
}

/**
 * A public preview needs no key in the URL, and a key in a link that gets
 * pasted around is a liability, so it is only added when it is actually needed.
 */
export function previewUrlFor(
  isPublic: boolean,
  url: string,
  token?: string
): string {
  return isPublic ? url : authenticatedUrl(url, token);
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
 * is not set, reuse whatever the `daytona` CLI already stored. The CLI writes
 * TWO shapes depending on how the developer authenticated, and both are valid:
 * `daytona login` stores a browser JWT under `api.token.accessToken`, while
 * `daytona login --api-key` stores a long-lived key under `api.key` (leaving
 * an empty `api.token` object beside it). Reading only the JWT shape reports
 * "No Daytona credentials" on an authenticated machine, which reads as a
 * login failure rather than an unread field.
 */
type DaytonaCredentials =
  | { apiKey: string; apiUrl?: string }
  | { jwtToken: string; organizationId: string; apiUrl?: string };

/**
 * The stored JWT is stale and no API key stands behind it. Thrown rather than
 * exited so the branch stays reachable from a test: `process.exit` inside the
 * pure reader kills the test runner mid-suite instead of failing an assertion,
 * which makes the regression look like a crash rather than a caught bug.
 */
export class ExpiredCliTokenError extends Error {}

/** Split from disk access so both credential shapes are testable. */
export function credentialsFromConfig(cfg: unknown): DaytonaCredentials | null {
  const root = cfg as {
    activeProfile?: string;
    profiles?: {
      id?: string;
      activeOrganizationId?: string;
      api?: {
        url?: string;
        key?: string;
        token?: { accessToken?: string; expiresAt?: string };
      };
    }[];
  };
  const profiles = root?.profiles ?? [];
  const profile =
    profiles.find((p) => p.id === root?.activeProfile) ?? profiles[0];
  if (!profile) return null;
  const apiUrl = profile.api?.url;

  // An API key carries its own org scope, so no activeOrganizationId is needed.
  const apiKey = profile.api?.key;
  const token = profile.api?.token;
  if (token?.accessToken && profile.activeOrganizationId) {
    const expired =
      !!token.expiresAt && new Date(token.expiresAt).getTime() < Date.now();
    if (!expired) {
      return {
        jwtToken: token.accessToken,
        organizationId: profile.activeOrganizationId,
        apiUrl,
      };
    }
    // A stale JWT must not mask a key that still works.
    if (!apiKey) throw new ExpiredCliTokenError();
  }

  if (apiKey) return { apiKey, apiUrl };

  return null;
}

function cliCredentials(): DaytonaCredentials | null {
  const cfgPath = join(
    homedir(),
    "Library/Application Support/daytona/config.json"
  );
  const xdg = join(homedir(), ".config/daytona/config.json");
  const path = existsSync(cfgPath) ? cfgPath : existsSync(xdg) ? xdg : null;
  if (!path) return null;
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  // Only the parse is best-effort. An expired token is a real, actionable
  // state, so it must not be swallowed by the same catch that tolerates an
  // unreadable config file.
  try {
    return credentialsFromConfig(cfg);
  } catch (err) {
    if (err instanceof ExpiredCliTokenError) {
      console.error("daytona CLI token has expired — run: daytona login");
      process.exit(1);
    }
    throw err;
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

/**
 * Keys the sandbox decides for itself. dev-native.sh preserves only a fixed
 * preset list across `source .env`, and none of these is on it, so any left in
 * the uploaded .env would silently OVERRIDE the boot environment — reopening
 * sign-up or dropping /api/workers/* back to its anonymous fallback on a public
 * preview. LOBU_DEV_DATA_ROOT is the same decision one level down: it names the
 * cluster directory whenever DATABASE_URL is absent, so a host value there
 * would put the database back inside the served tree.
 */
export const SANDBOX_CONTROLLED_ENV_KEYS = [
  "LOBU_SINGLE_USER",
  "WORKER_API_TOKEN",
  "EMBEDDINGS_SERVICE_TOKEN",
  "LOBU_DEV_DATA_ROOT",
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
        (!HOST_ONLY_ENV_KEYS.includes(key) &&
          !SANDBOX_CONTROLLED_ENV_KEYS.includes(key) &&
          !key.startsWith("DAYTONA_"))
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
    // (node_modules, dist, workspaces) is never in this manifest, so source
    // deletions propagate without erasing the warm install. The database is
    // not even in the tree: it lives at DATA_ROOT, beside the checkout.
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

/** Both bearers below only have to be unguessable; each is compared verbatim. */
export function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The boot environment, as `env K='V'` words. Every value here is a security
 * decision for a preview that is handed out publicly, so they live in one
 * exported, tested place rather than inline at the call site.
 */
export function bootEnv(options: {
  previewUrl: string;
  workerApiToken: string;
  embeddingsServiceToken: string;
}): string {
  const values: Array<[string, string]> = [
    ["PORT", String(APP_PORT)],
    ["HOST", "0.0.0.0"],
    // PUBLIC_GATEWAY_URL must be the preview URL before boot: the server hands
    // the SPA absolute sse/messages URLs, a wrong origin breaks chat and stamps
    // MCP asset URLs the host sandbox then rejects, and Better Auth derives its
    // baseURL and trustedOrigins from this origin.
    ["PUBLIC_GATEWAY_URL", `${options.previewUrl}/lobu`],
    // dev-native.sh picks its backend from the DATABASE_URL *scheme*, so a
    // file:// path is what keeps embedded Postgres — here, out of the Vite root.
    ["DATABASE_URL", `file://${DATA_ROOT}`],
    // A public preview must accept exactly one account: the owner's.
    ["LOBU_SINGLE_USER", "1"],
    // …and must not leave /api/workers/* on its unauthenticated fallback,
    // which only applies while WORKER_API_TOKEN is unset.
    ["WORKER_API_TOKEN", options.workerApiToken],
    // The embeddings sidecar is a second listener the preview proxy exposes,
    // and its bearer check is skipped entirely while this is unset. Server and
    // sidecar both read this one variable, so injecting it authenticates the
    // caller and closes the endpoint in the same step.
    ["EMBEDDINGS_SERVICE_TOKEN", options.embeddingsServiceToken],
  ];
  return values
    .map(([key, value]) => {
      if (value.includes("'")) {
        throw new Error(`refusing to pass ${key}: the value contains a quote`);
      }
      return `${key}='${value}'`;
    })
    .join(" ");
}

/**
 * Stopping the old server is load-bearing, not hygiene. dev-native.sh `exec`s
 * into `bun run --filter @lobu/server dev:local`, so once it is up NO process
 * cmdline contains "dev-native.sh" any more: the old single pattern matched
 * nothing, the replacement boot died on EADDRINUSE, and waitReady then passed
 * against the STALE process — which still had the previous environment. A boot
 * env that silently does not apply is exactly the failure this file must not
 * have, so a port that stays busy is a hard error.
 */
async function stopApp(sandbox: Sandbox) {
  await exec(
    sandbox,
    "pkill -f '[d]ev-native.sh' || true; " +
      "pkill -f '[@]lobu/server' || true; " +
      "pkill -f '[s]rc/server.ts' || true; " +
      "pkill -f '[l]obu run' || true",
    120
  );
  // The image ships no ss/netstat/lsof, so the listen socket is read straight
  // from /proc — and an unreadable /proc is a hard error rather than a silent
  // "the port looks free", which is how this check would fail open.
  const portHex = APP_PORT.toString(16).toUpperCase().padStart(4, "0");
  const portState = await exec(
    sandbox,
    `[ -r /proc/net/tcp ] || { echo 'cannot read /proc/net/tcp' >&2; exit 1; }; ` +
      "for _ in $(seq 1 30); do " +
      `if ! cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -qE ':${portHex} [0-9A-F]{8,32}:[0-9A-F]{4} 0A'; then echo free; exit 0; fi; ` +
      "sleep 1; done; echo busy",
    120
  );
  if (!portState.includes("free")) {
    throw new Error(
      `port ${APP_PORT} is still held after stopping the app; refusing to boot a second server over it`
    );
  }
  // The cluster has to be down before its data root can move underneath it.
  const pgState = await exec(
    sandbox,
    "pkill -f '[p]ostgres -D' || true; " +
      "for _ in $(seq 1 30); do " +
      "if ! pgrep -f '[p]ostgres -D' > /dev/null; then echo stopped; exit 0; fi; " +
      "sleep 1; done; echo running",
    120
  );
  if (!pgState.includes("stopped")) {
    throw new Error(
      "embedded Postgres is still running; refusing to move its data root underneath it"
    );
  }
}

async function bootApp(
  sandbox: Sandbox,
  previewUrl: string,
  tokens: { workerApiToken: string; embeddingsServiceToken: string }
) {
  await stopApp(sandbox);
  // One-time relocation for sandboxes created before the cluster moved out of
  // the served tree. An EMPTY destination is just the leftover of a boot that
  // failed after mkdir, so it is replaced; two non-empty clusters is a real
  // conflict this script must not resolve by guessing which one to delete.
  await exec(
    sandbox,
    `if [ -d ${WORKSPACE}/.lobu-dev ]; then ` +
      `if [ -n "$(ls -A ${DATA_ROOT} 2>/dev/null)" ]; then ` +
      `echo "both ${WORKSPACE}/.lobu-dev and ${DATA_ROOT} hold data; move or delete one" >&2; exit 1; fi; ` +
      `rmdir ${DATA_ROOT} 2>/dev/null || true; ` +
      `mv ${WORKSPACE}/.lobu-dev ${DATA_ROOT}; fi; ` +
      `mkdir -p ${DATA_ROOT}`,
    300
  );
  const env = bootEnv({ previewUrl, ...tokens });
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
 * The single seat this install allows, kept inside the sandbox so a re-run does
 * not mint a second password and `url` can hand out a fresh login link.
 */
export type Seat = { email: string; password: string; created_at: string };

/** The session token is absent only when a freshly claimed seat cannot sign in. */
type ClaimedSeat = { seat: Seat; sessionToken?: string };

/**
 * Never a hardcoded address: the repo forbids personal state in shipping code,
 * and the sandbox owner is whoever is driving this checkout.
 */
export function resolveOwnerEmail(
  configuredEmail: string | undefined,
  gitEmail: string | undefined
): string {
  const email = (configuredEmail ?? gitEmail ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error(
      "No owner email for the sandbox seat. Set SANDBOX_OWNER_EMAIL, or configure git user.email in this worktree."
    );
  }
  return email;
}

/** 24 base64url characters — well inside Better Auth's 128-character ceiling. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * The credentials reach the remote shell base64-encoded so that no part of an
 * email or a generated password is ever shell-quoted.
 */
function jsonPostScript(path: string, body: unknown, curlFlags = ""): string {
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
  return (
    `printf %s '${encoded}' | base64 -d | ` +
    `curl -s ${curlFlags} -H 'Content-Type: application/json' --data-binary @- ` +
    `http://127.0.0.1:${APP_PORT}${path}`
  );
}

export function signInScript(email: string, password: string): string {
  return `${jsonPostScript("/api/auth/sign-in/email", { email, password }, "-D /tmp/lobu-signin.h")}; echo; cat /tmp/lobu-signin.h; rm -f /tmp/lobu-signin.h`;
}

export function signUpScript(
  email: string,
  password: string,
  name: string
): string {
  return `${jsonPostScript("/api/auth/sign-up/email", { email, password, name }, "-o /tmp/lobu-seat.json -w '%{http_code}'")}; echo; cat /tmp/lobu-seat.json; rm -f /tmp/lobu-seat.json`;
}

export type SignUpOutcome =
  | { status: "claimed" }
  | { status: "seat_taken" }
  | { status: "error"; detail: string };

/**
 * Reads `<http status>\n<body>`. "seat_taken" is recognised by the hook's own
 * error code rather than a bare 403, so an unrelated 403 can never be mistaken
 * for proof that the seat is closed.
 */
export function interpretSignUp(output: string): SignUpOutcome {
  const newline = output.indexOf("\n");
  const code = (newline === -1 ? output : output.slice(0, newline)).trim();
  const body = newline === -1 ? "" : output.slice(newline + 1).trim();
  if (/^2\d\d$/.test(code)) return { status: "claimed" };
  if (code === "403" && body.includes("SIGN_UP_DISABLED_IN_SINGLE_USER_MODE")) {
    return { status: "seat_taken" };
  }
  return {
    status: "error",
    detail: `HTTP ${code || "(none)"}: ${body.slice(0, 400)}`,
  };
}

/**
 * Better Auth returns the raw session token in the sign-in body; if a build
 * ever stops doing that, the cookie carries `<token>.<base64 HMAC>` and the
 * exchange endpoint wants the token half alone.
 */
export function sessionTokenFrom(output: string): string | undefined {
  const fromBody = output.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
  if (fromBody) return fromBody;
  const cookie = output.match(/better-auth\.session_token=([^;\s]+)/i)?.[1];
  if (!cookie) return undefined;
  return decodeURIComponent(cookie).split(".")[0] || undefined;
}

/**
 * A link, not just a password, because the preview origin is long and the
 * exchange endpoint sets a first-party session cookie and redirects to the SPA.
 */
export function loginLink(previewUrl: string, sessionToken: string): string {
  const base = previewUrl.replace(/\/+$/, "");
  return `${base}/api/exchange-token?token=${encodeURIComponent(sessionToken)}&next=%2F`;
}

async function readSeat(sandbox: Sandbox): Promise<Seat | undefined> {
  const raw = await exec(
    sandbox,
    `cat ${SEAT_FILE} 2>/dev/null || true`,
    60
  ).catch(() => "");
  const text = raw.trim();
  if (!text) return undefined;
  try {
    const seat = JSON.parse(text) as Seat;
    return seat?.email && seat?.password ? seat : undefined;
  } catch {
    return undefined;
  }
}

async function writeSeat(sandbox: Sandbox, seat: Seat) {
  const encoded = Buffer.from(JSON.stringify(seat), "utf8").toString("base64");
  await exec(
    sandbox,
    `umask 077 && printf %s '${encoded}' | base64 -d > ${SEAT_FILE} && chmod 600 ${SEAT_FILE}`,
    60
  );
}

/**
 * Claims the one seat single-user mode allows, so that making the preview
 * public cannot hand the install to whoever opens the URL first.
 */
async function claimSeat(sandbox: Sandbox, root: string): Promise<ClaimedSeat> {
  const existing = await readSeat(sandbox);
  if (existing) {
    // A seat file that no longer signs in means the database was replaced
    // underneath it. The seat is then unclaimed again and the next visitor's
    // sign-up would take the install, so this must never reach setPublic.
    const sessionToken = await signIn(sandbox, existing);
    if (!sessionToken) {
      throw new Error(
        `the seat recorded at ${SEAT_FILE} no longer signs in, so the account that owns this install is unknown. ` +
          "Refusing to make it public; delete the sandbox (make sandbox-rm) and run up again."
      );
    }
    return { seat: existing, sessionToken };
  }

  const gitEmail = spawnSync("git", ["-C", root, "config", "user.email"], {
    encoding: "utf8",
  }).stdout?.trim();
  const email = resolveOwnerEmail(process.env.SANDBOX_OWNER_EMAIL, gitEmail);
  const password = generatePassword();
  const outcome = interpretSignUp(
    await exec(sandbox, signUpScript(email, password, "Sandbox Owner"), 120)
  );
  if (outcome.status === "error") {
    throw new Error(`could not claim the sandbox seat — ${outcome.detail}`);
  }
  if (outcome.status === "seat_taken") {
    throw new Error(
      `this sandbox already has an account but no seat record at ${SEAT_FILE}, so its login is unknown. ` +
        "Refusing to make it public; delete the sandbox (make sandbox-rm) and run up again."
    );
  }
  const seat: Seat = {
    email,
    password,
    created_at: new Date().toISOString(),
  };
  await writeSeat(sandbox, seat);
  // codeql[js/clear-text-logging]: printing the generated seat password once to
  // the operator's own terminal is the point — it is the only moment the value
  // is shown, it was minted here rather than taken from a store, and the same
  // value is written to SEAT_FILE inside the developer's own sandbox anyway.
  console.log(`\n  seat:  ${email} / ${password}`);
  console.log(`         (shown once; kept in the sandbox at ${SEAT_FILE})`);
  return { seat, sessionToken: await signIn(sandbox, seat) };
}

/**
 * Proves the door is shut BEFORE it is opened. A boot env that failed to apply
 * would leave sign-up wide open, and every other check here would still pass.
 */
async function assertSignUpClosed(sandbox: Sandbox) {
  const probeEmail = `probe-${randomBytes(6).toString("hex")}@example.com`;
  const probe = interpretSignUp(
    await exec(
      sandbox,
      signUpScript(probeEmail, generatePassword(), "probe"),
      120
    )
  );
  if (probe.status === "seat_taken") return;
  throw new Error(
    probe.status === "claimed"
      ? `sign-up is still OPEN (${probeEmail} was created); refusing to make the sandbox public`
      : `could not prove sign-up is closed — ${probe.detail}; refusing to make the sandbox public`
  );
}

type PublicToggleApi = {
  updatePublicStatus?: (id: string, isPublic: boolean) => Promise<unknown>;
};

/**
 * `public` is also a create-time option, but flipping it AFTER the seat is
 * claimed is what removes the first-visitor race, and it gives sandboxes that
 * already exist the same code path. The SDK keeps its generated client private,
 * and reaching through it is narrower than depending on @daytona/api-client
 * directly (a transitive package under a different org name).
 */
async function setPublic(sandbox: Sandbox, isPublic: boolean) {
  const api = (sandbox as unknown as { sandboxApi?: PublicToggleApi })
    .sandboxApi;
  if (typeof api?.updatePublicStatus !== "function") {
    throw new Error(
      "this Daytona SDK no longer exposes sandboxApi.updatePublicStatus; the preview cannot be made public"
    );
  }
  await api.updatePublicStatus(sandbox.id, isPublic);
  await sandbox.refreshData();
  if (sandbox.public !== isPublic) {
    throw new Error(
      `the sandbox public flag did not change (still ${String(sandbox.public)})`
    );
  }
}

/** The raw session token, or undefined when the credentials no longer work. */
async function signIn(
  sandbox: Sandbox,
  seat: Seat
): Promise<string | undefined> {
  const out = await exec(
    sandbox,
    signInScript(seat.email, seat.password),
    120
  ).catch(() => "");
  return sessionTokenFrom(out);
}

/** Re-mintable, so a lost password is inconvenient rather than fatal. */
async function mintLoginLink(
  sandbox: Sandbox,
  previewUrl: string,
  seat: Seat
): Promise<string | undefined> {
  const token = await signIn(sandbox, seat);
  return token ? loginLink(previewUrl, token) : undefined;
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
    const previewUrl = String(link?.url ?? link);
    await sandbox.refreshData();
    console.log(previewUrlFor(sandbox.public, previewUrl, link?.token));
    // A stopped sandbox can still report its URL, but nothing inside it can
    // sign in, so the link is only minted when the app is actually up.
    if (/start|running/i.test(stateOf(sandbox))) {
      const seat = await readSeat(sandbox);
      const login = seat && (await mintLoginLink(sandbox, previewUrl, seat));
      if (login) console.log(login);
    }
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
  await bootApp(sandbox, url, {
    workerApiToken: generateBearerToken(),
    embeddingsServiceToken: generateBearerToken(),
  });
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
  // The order is the whole point: take the one seat single-user mode allows,
  // PROVE that sign-up is shut, and only then drop the preview key.
  const { seat, sessionToken } = await claimSeat(sandbox, root);
  await assertSignUpClosed(sandbox);
  await setPublic(sandbox, true);
  const login = sessionToken ? loginLink(url, sessionToken) : undefined;

  console.log(`\n  ${name} ready`);
  console.log(`  app:   ${previewUrlFor(sandbox.public, url, link?.token)}`);
  console.log(
    login
      ? `  login: ${login}`
      : `  login: sign in as ${seat.email} (could not mint a link; see ${SEAT_FILE})`
  );
  console.log("  logs:  make sandbox-logs");
  console.log("  stop:  make sandbox-stop   (frees quota; DB survives)\n");
}

// Importing this module (the tests do) must not launch a sandbox.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
