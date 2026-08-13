#!/usr/bin/env bun

import {
  Daytona,
  type DaytonaConfig,
  type Sandbox,
  SandboxClass,
} from "@daytona/sdk";
import { file, sleep, spawnSync, write } from "bun";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const REMOTE_ROOT = "/home/daytona/lobu";
const REMOTE_STATE = "/home/daytona/.lobu-dev";
const DEV_PORT = 8787;
const DEV_SESSION = "lobu-dev";
const PREVIEW_LIFETIME_SECONDS = 24 * 60 * 60;
const PREVIEW_REUSE_SECONDS = 23 * 60 * 60;

type Command = "up" | "pause" | "status" | "logs";

type CliProfile = {
  id?: string;
  name?: string;
  activeOrganizationId?: string;
  api?: {
    key?: string;
    url?: string;
    token?: {
      accessToken?: string;
    };
  };
};

type CliConfig = {
  activeProfile?: string;
  profiles?: CliProfile[];
};

type StoredPreview = {
  url: string;
  expiresAt: number;
};

type RemoteDevelopmentOrchestration = {
  remoteSource: string | undefined;
  sourceId: string;
  storedPreview: StoredPreview | undefined;
  isHealthy: () => Promise<boolean>;
  sync: () => Promise<void>;
  prepare: () => Promise<void>;
  record: () => Promise<void>;
  createPreview: () => Promise<StoredPreview>;
  persistPreview: (preview: StoredPreview) => Promise<void>;
  start: (url: string) => Promise<void>;
  waitUntilHealthy: () => Promise<void>;
};

type HttpError = {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown };
};

type SessionDeleter = {
  deleteSession(sessionId: string): Promise<void>;
};

type SessionLogReader = {
  getSession(sessionId: string): Promise<{
    commands: Array<{ id: string }>;
  }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string
  ): Promise<{ stdout?: string; stderr?: string }>;
};

type RemoteCommandExecutor = {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number
  ): Promise<{ exitCode: number; result: string }>;
};

type SuspendableSandbox = Pick<
  Sandbox,
  | "labels"
  | "name"
  | "pause"
  | "public"
  | "setAutoDeleteInterval"
  | "state"
  | "stop"
>;

type SnapshotResolver = {
  snapshot: {
    get(name: string): Promise<{ sandboxClass?: string }>;
  };
};

export function sanitizeSandboxName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return sanitized || "developer";
}

export function defaultSandboxName(
  user = process.env.USER ?? "developer"
): string {
  return `lobu-dev-${sanitizeSandboxName(user)}`;
}

export async function snapshotUsesVm(
  daytona: SnapshotResolver,
  snapshotName: string
): Promise<boolean> {
  const snapshot = await daytona.snapshot.get(snapshotName);
  if (snapshot.sandboxClass === SandboxClass.LINUX_VM) return true;
  if (snapshot.sandboxClass === SandboxClass.CONTAINER) return false;
  throw new Error(
    `Daytona snapshot ${snapshotName} has unsupported sandbox class ${snapshot.sandboxClass ?? "missing"}; Lobu remote development requires linux-vm or container.`
  );
}

export function lifecycleIntervals(
  vm: boolean,
  idleInterval: number
): { autoStopInterval: number; autoPauseInterval?: number } {
  return vm
    ? { autoStopInterval: 0, autoPauseInterval: idleInterval }
    : { autoStopInterval: idleInterval };
}

export function pinnedBunEnvironment(
  bunVersion: string,
  binDirectory = `${REMOTE_STATE}/bin`
): string[] {
  return [
    `export PATH=${shellQuote(binDirectory)}:"$PATH"`,
    "actual_bun_version=$(bun --version)",
    `if [ "$actual_bun_version" != ${shellQuote(bunVersion)} ]; then echo "Expected Bun ${bunVersion}, got $actual_bun_version." >&2; exit 1; fi`,
  ];
}

export function daytonaConfigPath(
  home = homedir(),
  os = platform(),
  configDir = process.env.DAYTONA_CONFIG_DIR,
  xdgConfigHome = process.env.XDG_CONFIG_HOME
): string {
  if (configDir) return join(configDir, "config.json");
  if (os === "darwin")
    return join(
      home,
      "Library",
      "Application Support",
      "daytona",
      "config.json"
    );
  return join(xdgConfigHome || join(home, ".config"), "daytona", "config.json");
}

export function resolveCliProfile(config: CliConfig): DaytonaConfig {
  const profile = config.profiles?.find(
    (candidate) =>
      candidate.id === config.activeProfile ||
      candidate.name === config.activeProfile
  );
  if (!profile)
    throw new Error(
      "Daytona CLI has no active profile. Run `daytona login` first."
    );

  const apiUrl = profile.api?.url;
  if (profile.api?.key) return { apiKey: profile.api.key, apiUrl };

  const jwtToken = profile.api?.token?.accessToken;
  if (!jwtToken || !profile.activeOrganizationId) {
    throw new Error(
      "Daytona CLI login is incomplete. Run `daytona login` again."
    );
  }
  return { jwtToken, organizationId: profile.activeOrganizationId, apiUrl };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function canReusePreview(
  preview: StoredPreview | undefined,
  nowSeconds = Date.now() / 1000
): boolean {
  return Boolean(preview?.url && preview.expiresAt - nowSeconds > 60);
}

export async function orchestrateRemoteDevelopment({
  remoteSource,
  sourceId,
  storedPreview,
  isHealthy,
  sync,
  prepare,
  record,
  createPreview,
  persistPreview,
  start,
  waitUntilHealthy,
}: RemoteDevelopmentOrchestration): Promise<string> {
  const reusablePreview = canReusePreview(storedPreview)
    ? storedPreview
    : undefined;
  if (remoteSource === sourceId && reusablePreview && (await isHealthy())) {
    return reusablePreview.url;
  }

  const sourceChanged = remoteSource !== sourceId;
  if (sourceChanged) await sync();
  await prepare();
  if (sourceChanged) await record();
  const preview = reusablePreview ?? (await createPreview());
  await start(preview.url);
  await waitUntilHealthy();
  if (!reusablePreview) await persistPreview(preview);
  return preview.url;
}

export function assertReusableSandbox(
  sandbox: Pick<Sandbox, "labels" | "name" | "public">
): void {
  if (sandbox.public !== false) {
    throw new Error(
      `Daytona sandbox ${sandbox.name} is public; refusing to upload Lobu. Delete or rename it, or set DAYTONA_DEV_NAME to a private sandbox.`
    );
  }
  if (
    sandbox.labels.app !== "lobu" ||
    sandbox.labels.purpose !== "remote-development"
  ) {
    throw new Error(
      `Daytona sandbox ${sandbox.name} is not labeled as Lobu remote development; refusing to reuse it. Set DAYTONA_DEV_NAME to a dedicated sandbox.`
    );
  }
}

export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as HttpError;
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.response?.status === 404
  );
}

export async function deleteSessionIfPresent(
  processApi: SessionDeleter,
  sessionId: string
): Promise<void> {
  try {
    await processApi.deleteSession(sessionId);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export async function readSessionLogs(
  processApi: SessionLogReader,
  sessionId: string
): Promise<string> {
  try {
    const session = await processApi.getSession(sessionId);
    const command = session.commands.at(-1);
    if (!command) return "No remote development command has run yet.";
    const logs = await processApi.getSessionCommandLogs(sessionId, command.id);
    return [logs.stdout, logs.stderr].filter(Boolean).join("\n").trim();
  } catch (error) {
    if (isNotFoundError(error))
      return "No remote development session exists yet.";
    throw error;
  }
}

export async function readOptionalRemoteFile(
  processApi: RemoteCommandExecutor,
  path: string
): Promise<string | undefined> {
  const missingExitCode = 44;
  const result = await processApi.executeCommand(
    `if [ ! -e ${shellQuote(path)} ]; then exit ${missingExitCode}; fi; cat ${shellQuote(path)}`,
    undefined,
    undefined,
    30
  );
  if (result.exitCode === 0) return result.result.trim();
  if (result.exitCode === missingExitCode) return undefined;
  const detail = result.result.trim();
  throw new Error(
    `Remote file read failed for ${path}${detail ? `: ${detail}` : ""}`
  );
}

export async function suspendSandbox(
  sandbox: SuspendableSandbox,
  vm: boolean
): Promise<void> {
  assertReusableSandbox(sandbox);
  await sandbox.setAutoDeleteInterval(-1);
  if (sandbox.state === "paused" || sandbox.state === "stopped") {
    console.log(`Daytona sandbox ${sandbox.name} is already ${sandbox.state}.`);
    return;
  }
  if (vm) {
    console.log(
      `Pausing Daytona VM ${sandbox.name} (processes and memory are preserved)...`
    );
    await sandbox.pause(300);
    console.log(`Daytona VM ${sandbox.name} is paused.`);
  } else {
    console.log(
      `Stopping Daytona compute for ${sandbox.name} (remote files are preserved)...`
    );
    await sandbox.stop(300);
    console.log(`Daytona sandbox ${sandbox.name} is stopped.`);
  }
}

export function checkoutCleanupCommand(remoteRoot: string): string {
  return `find ${shellQuote(remoteRoot)} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +`;
}

export function embeddedPostgresStopCommand(
  dataRoot = `${REMOTE_STATE}/data`,
  checkoutRoot = REMOTE_ROOT,
  procRoot = "/proc"
): string {
  const pgData = `${dataRoot}/.lobu/pgdata`;
  return [
    "set -eu",
    `pgdata=${shellQuote(pgData)}`,
    'pid_file="$pgdata/postmaster.pid"',
    'if [ -f "$pid_file" ]; then',
    '  pid=$(sed -n "1p" "$pid_file")',
    '  case "$pid" in ""|*[!0-9]*) echo "Invalid embedded Postgres PID file: $pid_file" >&2; exit 1 ;; esac',
    '  if kill -0 "$pid" 2>/dev/null; then',
    `    proc_exe=$(readlink ${shellQuote(procRoot)}/"$pid"/exe 2>/dev/null || true)`,
    '    recorded_pgdata=$(sed -n "2p" "$pid_file")',
    '    if [ "${proc_exe##*/}" != postgres ] || [ "$recorded_pgdata" != "$pgdata" ]; then',
    '      echo "Refusing to stop PID $pid because it is not the expected embedded Postgres process." >&2',
    "      exit 1",
    "    fi",
    `    pg_ctl=$(find ${shellQuote(`${checkoutRoot}/node_modules`)} -type f -path '*/native/bin/pg_ctl' -print -quit)`,
    '    if [ -z "$pg_ctl" ]; then echo "Could not locate pg_ctl for the running embedded Postgres process." >&2; exit 1; fi',
    '    "$pg_ctl" stop -D "$pgdata" -m fast -w -t 30',
    "  else",
    '    rm -f "$pid_file"',
    "  fi",
    "fi",
  ].join("\n");
}

export function managedDevProcessStopCommand(
  stateRoot = REMOTE_STATE,
  checkoutRoot = REMOTE_ROOT,
  procRoot = "/proc"
): string {
  return [
    "set -eu",
    `pid_file=${shellQuote(`${stateRoot}/dev-process-group`)}`,
    'if [ -f "$pid_file" ]; then',
    '  pid=$(sed -n "1p" "$pid_file")',
    '  case "$pid" in ""|*[!0-9]*) echo "Invalid remote dev process-group PID file: $pid_file" >&2; exit 1 ;; esac',
    '  if kill -0 "$pid" 2>/dev/null; then',
    `    proc_root=${shellQuote(procRoot)}`,
    '    proc_cmdline="$proc_root/$pid/cmdline"',
    `    expected_cwd=${shellQuote(checkoutRoot)}`,
    '    actual_cwd=$(readlink "$proc_root/$pid/cwd" 2>/dev/null || true)',
    '    actual_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " " || true)',
    '    if [ ! -r "$proc_cmdline" ] || ! grep -a -F -q bun "$proc_cmdline" || [ "$actual_cwd" != "$expected_cwd" ] || [ "$actual_pgid" != "$pid" ]; then',
    '      echo "Refusing to stop process group $pid because it is not the managed Lobu dev process." >&2',
    "      exit 1",
    "    fi",
    '    kill -INT -- "-$pid"',
    "    attempts=0",
    '    while kill -0 -- "-$pid" 2>/dev/null && [ "$attempts" -lt 60 ]; do sleep 0.5; attempts=$((attempts + 1)); done',
    '    if kill -0 -- "-$pid" 2>/dev/null; then',
    '      kill -TERM -- "-$pid"',
    "      attempts=0",
    '      while kill -0 -- "-$pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do sleep 0.5; attempts=$((attempts + 1)); done',
    "    fi",
    '    if kill -0 -- "-$pid" 2>/dev/null; then echo "Managed Lobu dev process group $pid did not stop." >&2; exit 1; fi',
    "  fi",
    '  rm -f "$pid_file"',
    "fi",
  ].join("\n");
}

export function dependencyInstallCondition(
  lockHash: string,
  sourceId: string,
  stateRoot = REMOTE_STATE
): string {
  return `[ ! -d node_modules ] || [ "$(cat ${shellQuote(`${stateRoot}/bun-lock-sha`)} 2>/dev/null || true)" != ${shellQuote(lockHash)} ] || [ "$(cat ${shellQuote(`${stateRoot}/install-source-sha`)} 2>/dev/null || true)" != ${shellQuote(sourceId)} ]`;
}

export function assertOwlettoInManifest(manifest: string): void {
  if (
    !manifest.startsWith("packages/owletto/") &&
    !manifest.includes("\0packages/owletto/")
  ) {
    throw new Error(
      "Owletto is not initialized, so remote sync would omit the frontend. Run `git submodule update --init --recursive packages/owletto`."
    );
  }
}

export function buildSourceManifest(
  tracked: string,
  untracked: string,
  pathExists: (path: string) => boolean = (path) =>
    lstatSync(path, { throwIfNoEntry: false }) !== undefined
): string {
  const paths = new Set([...tracked.split("\0"), ...untracked.split("\0")]);
  return [...paths]
    .filter((path) => path.length > 0 && pathExists(path))
    .map((path) => `${path}\0`)
    .join("");
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function runLocal(command: string[]): string {
  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${command[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString();
}

function refreshCliLogin(): void {
  if (process.env.DAYTONA_API_KEY || process.env.DAYTONA_JWT_TOKEN) return;
  const result = spawnSync(["daytona", "list", "--format", "json"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "Daytona authentication is unavailable. Install the Daytona CLI and run `daytona login`."
    );
  }
}

async function createClient(): Promise<Daytona> {
  if (process.env.DAYTONA_API_KEY || process.env.DAYTONA_JWT_TOKEN)
    return new Daytona();

  refreshCliLogin();
  const configPath = daytonaConfigPath();
  if (!existsSync(configPath))
    throw new Error(
      "Daytona CLI config was not found. Run `daytona login` first."
    );
  const cliConfig = (await file(configPath).json()) as CliConfig;
  return new Daytona(resolveCliProfile(cliConfig));
}

async function disposeClient(daytona: Daytona): Promise<void> {
  await daytona[Symbol.asyncDispose]();
}

async function findSandbox(
  daytona: Daytona,
  name: string
): Promise<Sandbox | undefined> {
  for await (const sandbox of daytona.list({ name, limit: 10 })) {
    if (sandbox.name === name) return sandbox;
  }
  return undefined;
}

async function sandboxUsesVm(
  daytona: SnapshotResolver,
  sandbox: Sandbox
): Promise<boolean> {
  if (!sandbox.snapshot) await sandbox.refreshData();
  if (!sandbox.snapshot) {
    throw new Error(
      `Daytona sandbox ${sandbox.name} has no snapshot metadata; refusing to infer its lifecycle.`
    );
  }
  return await snapshotUsesVm(daytona, sandbox.snapshot);
}

async function getOrCreateSandbox(
  daytona: Daytona
): Promise<{ sandbox: Sandbox; vm: boolean }> {
  const name = process.env.DAYTONA_DEV_NAME || defaultSandboxName();
  const existing = await findSandbox(daytona, name);
  if (existing) {
    assertReusableSandbox(existing);
    return { sandbox: existing, vm: await sandboxUsesVm(daytona, existing) };
  }

  const snapshot = process.env.DAYTONA_DEV_SNAPSHOT || "daytona-large";
  const idleInterval = integerEnv("DAYTONA_DEV_IDLE_MINUTES", 15);
  const vm = await snapshotUsesVm(daytona, snapshot);
  console.log(`Creating private Daytona sandbox ${name} (${snapshot})...`);
  const sandbox = await daytona.create(
    {
      snapshot,
      name,
      labels: { app: "lobu", purpose: "remote-development" },
      public: false,
      ...lifecycleIntervals(vm, idleInterval),
      autoDeleteInterval: -1,
      ttlMinutes: 0,
    },
    { timeout: 300 }
  );
  return { sandbox, vm };
}

async function ensureStarted(sandbox: Sandbox): Promise<void> {
  if (sandbox.state === "started") return;
  console.log(`Resuming Daytona sandbox ${sandbox.name}...`);
  await sandbox.start(300);
  await sandbox.refreshData();
}

async function remoteCommand(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds = 60
): Promise<string> {
  const result = await sandbox.process.executeCommand(
    command,
    undefined,
    undefined,
    timeoutSeconds
  );
  if (result.exitCode !== 0) {
    const detail = result.result.trim();
    throw new Error(`Remote command failed${detail ? `: ${detail}` : ""}`);
  }
  return result.result.trim();
}

async function readRemoteFile(
  sandbox: Sandbox,
  path: string
): Promise<string | undefined> {
  return await readOptionalRemoteFile(sandbox.process, path);
}

async function readStoredPreview(
  sandbox: Sandbox
): Promise<StoredPreview | undefined> {
  const raw = await readRemoteFile(sandbox, `${REMOTE_STATE}/preview.json`);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as StoredPreview;
    return typeof value.url === "string" && typeof value.expiresAt === "number"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function healthy(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.process.executeCommand(
    `curl --fail --silent --max-time 3 http://127.0.0.1:${DEV_PORT}/health/ready >/dev/null`,
    undefined,
    undefined,
    10
  );
  return result.exitCode === 0;
}

function assertCleanTree(): void {
  if (process.env.DAYTONA_DEV_ALLOW_DIRTY === "1") return;
  const status = runLocal([
    "git",
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (status.trim()) {
    throw new Error(
      "Remote development syncs committed code only. Commit this worktree first (or set DAYTONA_DEV_ALLOW_DIRTY=1 for an intentional one-off test)."
    );
  }
}

function sourceIdentity(): string {
  const sha = runLocal(["git", "rev-parse", "HEAD"]).trim();
  return process.env.DAYTONA_DEV_ALLOW_DIRTY === "1"
    ? `${sha}-dirty-${Date.now()}`
    : sha;
}

async function deleteDevSession(sandbox: Sandbox): Promise<void> {
  await remoteCommand(sandbox, managedDevProcessStopCommand(), 45);
  await remoteCommand(sandbox, embeddedPostgresStopCommand(), 45);
  await deleteSessionIfPresent(sandbox.process, DEV_SESSION);
}

async function syncSource(sandbox: Sandbox): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "lobu-daytona-"));
  const manifestPath = join(tempRoot, "manifest");
  const archivePath = join(tempRoot, "source.tar.gz");
  try {
    const tracked = runLocal(["git", "ls-files", "-z", "--recurse-submodules"]);
    const untracked = runLocal([
      "git",
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ]);
    const manifest = buildSourceManifest(tracked, untracked);
    assertOwlettoInManifest(manifest);
    await write(manifestPath, manifest);
    runLocal([
      "env",
      "COPYFILE_DISABLE=1",
      "tar",
      "--null",
      "-czf",
      archivePath,
      "-T",
      manifestPath,
    ]);

    console.log("Uploading committed Lobu worktree...");
    await remoteCommand(
      sandbox,
      `mkdir -p ${shellQuote(REMOTE_ROOT)} ${shellQuote(REMOTE_STATE)}`
    );
    await sandbox.fs.uploadFile(
      archivePath,
      `${REMOTE_STATE}/source.next.tar.gz`,
      300
    );
    await deleteDevSession(sandbox);
    await remoteCommand(
      sandbox,
      [
        "set -eu",
        `mkdir -p ${shellQuote(REMOTE_ROOT)} ${shellQuote(REMOTE_STATE)}`,
        checkoutCleanupCommand(REMOTE_ROOT),
        `tar -xzf ${shellQuote(`${REMOTE_STATE}/source.next.tar.gz`)} -C ${shellQuote(REMOTE_ROOT)}`,
        `find ${shellQuote(REMOTE_ROOT)} -type f -name '._*' -delete`,
        `rm -f ${shellQuote(`${REMOTE_STATE}/source.next.tar.gz`)}`,
      ].join("\n"),
      300
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function prepareRuntime(
  sandbox: Sandbox,
  sourceId: string
): Promise<void> {
  const lockHash = runLocal(["shasum", "-a", "256", "bun.lock"]).split(
    /\s+/
  )[0];
  const bunVersion = runLocal(["bun", "--version"]).trim();
  console.log("Preparing remote dependencies and packages...");
  await remoteCommand(
    sandbox,
    [
      "set -eu",
      "umask 077",
      `mkdir -p ${shellQuote(REMOTE_STATE)} ${shellQuote(`${REMOTE_STATE}/data`)}`,
      `if [ ! -f ${shellQuote(`${REMOTE_STATE}/runtime.env`)} ]; then`,
      `  encryption_key=$(openssl rand -hex 32)`,
      `  auth_secret=$(openssl rand -hex 32)`,
      `  printf '%s\\n' ${shellQuote(`DATABASE_URL=file://${REMOTE_STATE}/data`)} "ENCRYPTION_KEY=$encryption_key" "BETTER_AUTH_SECRET=$auth_secret" 'NODE_ENV=development' 'LOG_LEVEL=info' > ${shellQuote(`${REMOTE_STATE}/runtime.env`)}`,
      "fi",
      `cp ${shellQuote(`${REMOTE_STATE}/runtime.env`)} ${shellQuote(`${REMOTE_ROOT}/.env`)}`,
      `cd ${shellQuote(REMOTE_ROOT)}`,
      `mkdir -p ${shellQuote(`${REMOTE_STATE}/bin`)}`,
      `if [ ! -x ${shellQuote(`${REMOTE_STATE}/bun-install/bin/bun`)} ] || [ "$(${shellQuote(`${REMOTE_STATE}/bun-install/bin/bun`)} --version 2>/dev/null || true)" != ${shellQuote(bunVersion)} ]; then`,
      `  curl -fsSL https://bun.sh/install | BUN_INSTALL=${shellQuote(`${REMOTE_STATE}/bun-install`)} bash -s -- ${shellQuote(`bun-v${bunVersion}`)}`,
      "fi",
      `ln -sf ${shellQuote(`${REMOTE_STATE}/bun-install/bin/bun`)} ${shellQuote(`${REMOTE_STATE}/bin/bun`)}`,
      "export NVM_DIR=/usr/local/share/nvm",
      '. "$NVM_DIR/nvm.sh"',
      "nvm install 22 >/dev/null",
      "nvm use 22 >/dev/null",
      ...pinnedBunEnvironment(bunVersion),
      "node_major=$(node -p 'process.versions.node.split(`.`)[0]')",
      'case "$node_major" in 22|23|24) ;; *) echo "Lobu requires Node 22-24; Daytona has $(node --version)." >&2; exit 1 ;; esac',
      `if ${dependencyInstallCondition(lockHash, sourceId)}; then`,
      "  bun install --frozen-lockfile",
      `  printf '%s\\n' ${shellQuote(lockHash)} > ${shellQuote(`${REMOTE_STATE}/bun-lock-sha`)}`,
      `  printf '%s\\n' ${shellQuote(sourceId)} > ${shellQuote(`${REMOTE_STATE}/install-source-sha`)}`,
      "fi",
      `if [ "$(cat ${shellQuote(`${REMOTE_STATE}/packages-source-sha`)} 2>/dev/null || true)" != ${shellQuote(sourceId)} ]; then`,
      "  make build-packages",
      `  printf '%s\\n' ${shellQuote(sourceId)} > ${shellQuote(`${REMOTE_STATE}/packages-source-sha`)}`,
      "fi",
    ].join("\n"),
    900
  );
}

async function recordSourceIdentity(
  sandbox: Sandbox,
  sourceId: string
): Promise<void> {
  await remoteCommand(
    sandbox,
    `printf '%s\\n' ${shellQuote(sourceId)} > ${shellQuote(`${REMOTE_STATE}/source-sha`)}`
  );
}

async function createPreview(sandbox: Sandbox): Promise<StoredPreview> {
  const preview = await sandbox.getSignedPreviewUrl(
    DEV_PORT,
    PREVIEW_LIFETIME_SECONDS
  );
  return {
    url: preview.url,
    expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_REUSE_SECONDS,
  };
}

async function persistPreview(
  sandbox: Sandbox,
  preview: StoredPreview
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(preview)).toString("base64");
  await remoteCommand(
    sandbox,
    `umask 077; printf '%s' ${shellQuote(encoded)} | base64 --decode > ${shellQuote(`${REMOTE_STATE}/preview.next.json`)} && mv ${shellQuote(`${REMOTE_STATE}/preview.next.json`)} ${shellQuote(`${REMOTE_STATE}/preview.json`)}`
  );
}

async function startDevServer(sandbox: Sandbox, url: string): Promise<void> {
  const bunVersion = runLocal(["bun", "--version"]).trim();
  await deleteDevSession(sandbox);
  await sandbox.process.createSession(DEV_SESSION);
  const managedCommand = [
    `printf '%s\\n' "$$" > ${shellQuote(`${REMOTE_STATE}/dev-process-group`)}`,
    [
      "exec env",
      "HOST=0.0.0.0",
      `PORT=${DEV_PORT}`,
      "WORKER_PROXY_PORT=8118",
      `PUBLIC_GATEWAY_URL=${shellQuote(`${url}/lobu`)}`,
      `DATABASE_URL=${shellQuote(`file://${REMOTE_STATE}/data`)}`,
      "./scripts/dev-native.sh",
    ].join(" \\\n  "),
  ].join("\n");
  const command = [
    `cd ${shellQuote(REMOTE_ROOT)}`,
    `test -x ${shellQuote(`${REMOTE_STATE}/bin/bun`)}`,
    "command -v setsid >/dev/null",
    "export NVM_DIR=/usr/local/share/nvm",
    '. "$NVM_DIR/nvm.sh"',
    "nvm use 22 >/dev/null",
    ...pinnedBunEnvironment(bunVersion),
    `exec setsid sh -c ${shellQuote(managedCommand)}`,
  ].join("\n");
  await sandbox.process.executeSessionCommand(
    DEV_SESSION,
    { command, runAsync: true },
    30
  );
}

async function devLogs(sandbox: Sandbox): Promise<string> {
  return await readSessionLogs(sandbox.process, DEV_SESSION);
}

async function waitUntilHealthy(sandbox: Sandbox): Promise<void> {
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await healthy(sandbox)) return;
    await sleep(2_000);
  }
  const logs = (await devLogs(sandbox)).split("\n").slice(-120).join("\n");
  throw new Error(
    `Remote app did not become ready within 6 minutes. Last logs:\n${logs}`
  );
}

type UpContext = {
  assertCleanTree: () => void;
  sourceIdentity: () => string;
};

export async function up(
  daytona: Daytona,
  context: UpContext = { assertCleanTree, sourceIdentity }
): Promise<void> {
  context.assertCleanTree();
  const sourceId = context.sourceIdentity();
  const { sandbox, vm } = await getOrCreateSandbox(daytona);
  await ensureStarted(sandbox);
  const idleInterval = integerEnv("DAYTONA_DEV_IDLE_MINUTES", 15);
  await sandbox.setAutostopInterval(vm ? 0 : idleInterval);
  if (vm) await sandbox.setAutoPauseInterval(idleInterval);
  await sandbox.setTtl(0);
  await sandbox.setAutoDeleteInterval(-1);

  const remoteSource = await readRemoteFile(
    sandbox,
    `${REMOTE_STATE}/source-sha`
  );
  const storedPreview = await readStoredPreview(sandbox);
  const url = await orchestrateRemoteDevelopment({
    remoteSource,
    sourceId,
    storedPreview,
    isHealthy: () => healthy(sandbox),
    sync: () => syncSource(sandbox),
    prepare: () => prepareRuntime(sandbox, sourceId),
    record: () => recordSourceIdentity(sandbox, sourceId),
    createPreview: () => createPreview(sandbox),
    persistPreview: (preview) => persistPreview(sandbox, preview),
    start: async (preview) => {
      console.log("Starting Lobu remotely...");
      await startDevServer(sandbox, preview);
    },
    waitUntilHealthy: () => waitUntilHealthy(sandbox),
  });
  console.log(`Remote Lobu is ready: ${url}`);
  console.log(
    `Daytona auto-${vm ? "pauses" : "stops"} compute after ${idleInterval} minutes without Daytona activity (preview traffic does not reset the timer).`
  );
  if (process.env.OPEN === "1" && platform() === "darwin")
    runLocal(["open", url]);
}

async function pause(daytona: Daytona): Promise<void> {
  const name = process.env.DAYTONA_DEV_NAME || defaultSandboxName();
  const sandbox = await findSandbox(daytona, name);
  if (!sandbox) {
    console.log(`No Daytona sandbox named ${name} exists.`);
    return;
  }
  await suspendSandbox(sandbox, await sandboxUsesVm(daytona, sandbox));
}

async function status(daytona: Daytona): Promise<void> {
  const name = process.env.DAYTONA_DEV_NAME || defaultSandboxName();
  const sandbox = await findSandbox(daytona, name);
  if (!sandbox) {
    console.log(
      `No Daytona sandbox named ${name} exists. Run make dev-remote to create it.`
    );
    return;
  }
  assertReusableSandbox(sandbox);
  await sandbox.refreshData();
  const vm = await sandboxUsesVm(daytona, sandbox);
  console.log(`${sandbox.name}: ${sandbox.state ?? "unknown"}`);
  console.log(
    `${sandbox.cpu} CPU, ${sandbox.memory} GiB RAM, ${sandbox.disk} GiB disk; private=${!sandbox.public}`
  );
  if (vm) {
    console.log(`auto-pause=${sandbox.autoPauseInterval ?? "unknown"} minutes`);
  } else {
    console.log(`auto-stop=${sandbox.autoStopInterval ?? "unknown"} minutes`);
  }
  if (sandbox.state === "started") {
    const source = await readRemoteFile(sandbox, `${REMOTE_STATE}/source-sha`);
    const preview = await readStoredPreview(sandbox);
    if (source) console.log(`source=${source}`);
    if (canReusePreview(preview)) console.log(`preview=${preview?.url}`);
  }
}

async function logs(daytona: Daytona): Promise<void> {
  const name = process.env.DAYTONA_DEV_NAME || defaultSandboxName();
  const sandbox = await findSandbox(daytona, name);
  if (!sandbox) throw new Error(`No Daytona sandbox named ${name} exists.`);
  assertReusableSandbox(sandbox);
  if (sandbox.state !== "started")
    throw new Error(
      `Daytona sandbox ${name} is ${sandbox.state}; run make dev-remote first.`
    );
  console.log(await devLogs(sandbox));
}

async function main(): Promise<void> {
  const command = (process.argv[2] || "up") as Command;
  if (!["up", "pause", "status", "logs"].includes(command)) {
    throw new Error("Usage: bun scripts/dev-remote.ts [up|pause|status|logs]");
  }

  const daytona = await createClient();
  try {
    if (command === "up") await up(daytona);
    else if (command === "pause") await pause(daytona);
    else if (command === "status") await status(daytona);
    else await logs(daytona);
  } finally {
    await disposeClient(daytona);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `dev-remote: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
