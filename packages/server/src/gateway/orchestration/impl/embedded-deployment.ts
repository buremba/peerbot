import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLogger, ErrorCode, OrchestratorError } from "@lobu/core";
import type { ModelProviderModule } from "../../modules/module-system.js";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type MessagePayload,
  type ModuleEnvVarsBuilder,
  type OrchestratorConfig,
} from "../base-deployment-manager.js";
import {
  buildDeploymentInfoSummary,
  getVeryOldThresholdDays,
} from "../deployment-utils.js";

const logger = createLogger("orchestrator");

/** Timeout (ms) to wait for graceful shutdown before SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;

/**
 * Detect once whether `systemd-run --user` is available. On Linux production
 * hosts this lets us spawn each worker as a transient systemd unit with
 * cgroup limits + IPAddressDeny + capability drops. macOS dev hosts and
 * Linux hosts without user systemd fall back to plain `child_process.spawn`.
 */
let cachedSystemdRun: string | null | undefined;
function locateSystemdRun(): string | null {
  if (cachedSystemdRun !== undefined) return cachedSystemdRun;
  if (process.platform !== "linux") {
    cachedSystemdRun = null;
    return cachedSystemdRun;
  }
  if (process.env.LOBU_DISABLE_SYSTEMD_RUN === "1") {
    cachedSystemdRun = null;
    return cachedSystemdRun;
  }
  try {
    // Probe by dispatching a real transient unit: `--version` only prints the
    // package version and does not exercise dbus. Some Linux hosts ship the
    // binary with no user manager attached; we have to exercise the
    // user-bus path that the worker spawn will later use, or workers fail
    // at first request instead of falling back to plain spawn here.
    //
    //   --no-block  → return as soon as the request is queued (no waiting on
    //                 the dispatched command); still requires a reachable bus
    //   --collect   → auto-remove the transient unit when it exits, so the
    //                 probe leaves no residue in the user manager
    //   timeout     → guard against a hung dbus connection (rare, but cheap)
    execFileSync(
      "systemd-run",
      ["--user", "--quiet", "--collect", "--no-block", "/bin/true"],
      { stdio: "ignore", timeout: 3_000 }
    );
    cachedSystemdRun = "systemd-run";
  } catch {
    cachedSystemdRun = null;
  }
  return cachedSystemdRun;
}

/**
 * Build the systemd-run argv prefix for a hardened transient scope. Defaults
 * are tuned for a single Lobu worker; operators can override via
 * LOBU_WORKER_MEMORY_MAX / LOBU_WORKER_CPU_QUOTA / LOBU_WORKER_TASKS_MAX.
 */
function buildSystemdRunArgs(opts: {
  unitName: string;
  workspaceDir: string;
}): string[] {
  const memMax = process.env.LOBU_WORKER_MEMORY_MAX || "512M";
  const cpuQuota = process.env.LOBU_WORKER_CPU_QUOTA || "200%";
  const tasksMax = process.env.LOBU_WORKER_TASKS_MAX || "64";
  const fileMax = process.env.LOBU_WORKER_LIMIT_NOFILE || "1024";
  return [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${opts.unitName}`,
    "-p",
    "NoNewPrivileges=yes",
    "-p",
    "PrivateTmp=yes",
    "-p",
    "ProtectSystem=strict",
    "-p",
    "ProtectHome=yes",
    "-p",
    `ReadWritePaths=${opts.workspaceDir}`,
    "-p",
    `MemoryMax=${memMax}`,
    "-p",
    `CPUQuota=${cpuQuota}`,
    "-p",
    `TasksMax=${tasksMax}`,
    "-p",
    `LimitNOFILE=${fileMax}`,
    "-p",
    "IPAddressDeny=any",
    "-p",
    "IPAddressAllow=127.0.0.1",
    "-p",
    "CapabilityBoundingSet=",
    "-p",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ];
}

function makeUnitName(deploymentName: string): string {
  // systemd unit names allow only [A-Za-z0-9:_.\\-]; sanitize and add a
  // short random tag so concurrent workers don't collide if a prior unit
  // is still being torn down.
  const safe = deploymentName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  const tag = Math.random().toString(36).slice(2, 8);
  return `lobu-worker-${safe}-${tag}`;
}

interface EmbeddedWorkerEntry {
  process: ChildProcess;
  env: Record<string, string>;
  lastActivity: Date;
  workspaceDir: string;
}

function buildEmbeddedWorkerPath(
  binPathEntries: readonly string[] | undefined,
  existingPath?: string
): string | undefined {
  const segments = (existingPath || "").split(":").filter(Boolean);

  for (const candidate of [...(binPathEntries ?? [])].reverse()) {
    if (!fs.existsSync(candidate)) continue;
    if (segments.includes(candidate)) continue;
    segments.unshift(candidate);
  }

  return segments.length > 0 ? segments.join(":") : existingPath;
}

function getBunExecutable(): string {
  return path.basename(process.execPath).startsWith("bun")
    ? process.execPath
    : "bun";
}

function getNodeExecutable(): string {
  return path.basename(process.execPath).startsWith("node")
    ? process.execPath
    : "node";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildWorkerInvocation(entryPoint: string): {
  command: string;
  args: string[];
} {
  const ext = path.extname(entryPoint);
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return { command: getNodeExecutable(), args: [entryPoint] };
  }

  return { command: getBunExecutable(), args: ["run", entryPoint] };
}

function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export class EmbeddedDeploymentManager extends BaseDeploymentManager {
  private workers: Map<string, EmbeddedWorkerEntry> = new Map();

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    super(config, moduleEnvVarsBuilder, providerModules);
  }

  protected getDispatcherHost(): string {
    // Match the systemd-run scope's IPAddressAllow=127.0.0.1 — IPv6 ::1
    // resolution would be blocked under the hardened scope.
    return "127.0.0.1";
  }

  /**
   * Embedded gateway is served by `@lobu/server` at the `/lobu`
   * mount on the configured PORT (default 8787). Without overriding here,
   * `BaseDeploymentManager` would hand workers the standalone gateway default
   * port with no mount prefix, so the worker would 404 on every dispatch and
   * provider-proxy call.
   */
  protected getDispatcherUrl(): string {
    const port = process.env.PORT || process.env.GATEWAY_PORT || "8787";
    return `http://${this.getDispatcherHost()}:${port}/lobu`;
  }

  private getWorkerEntryPoint(): string {
    const entryPoint = this.config.worker.entryPoint;
    if (!entryPoint) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "OrchestratorConfig.worker.entryPoint is required for embedded mode. " +
          "Callers must supply an absolute path to the worker source file."
      );
    }
    return entryPoint;
  }

  async validateWorkerImage(): Promise<void> {
    const entryPoint = this.getWorkerEntryPoint();
    if (!fs.existsSync(entryPoint)) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Worker entry point not found: ${entryPoint}`
      );
    }
    logger.debug(`Worker entry point verified: ${entryPoint}`);
  }

  protected async spawnDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
  ): Promise<void> {
    // Embedded mode is single-process by definition, so there is no cross-
    // process orchestrator to enforce uniqueness. The base class's in-flight
    // cache catches concurrent calls; this guards the rare case where a
    // fully-completed worker is still in the map and a fresh create slips
    // past the upstream `listDeployments()` check (e.g. stale snapshot).
    if (this.workers.has(deploymentName)) {
      return;
    }

    const agentId = messageData?.agentId;
    if (!agentId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Missing agentId in message payload"
      );
    }
    const workspaceDir = path.resolve(`workspaces/${agentId}`);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const commonEnvVars = await this.generateEnvironmentVariables(
      username,
      userId,
      deploymentName,
      messageData,
      true
    );

    commonEnvVars.WORKSPACE_DIR = workspaceDir;
    const embeddedPath = buildEmbeddedWorkerPath(
      this.config.worker.binPathEntries,
      commonEnvVars.PATH || process.env.PATH
    );
    if (embeddedPath) {
      commonEnvVars.PATH = embeddedPath;
    }

    // Serialize allowed domains for worker-side just-bash bootstrap
    const allowedDomains = messageData?.networkConfig?.allowedDomains ?? [];
    if (allowedDomains.length > 0) {
      commonEnvVars.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify(allowedDomains);
    }

    // Determine spawn command based on nix packages. Monorepo development
    // runs the TypeScript worker via Bun; published CLI installs resolve the
    // compiled @lobu/worker dist entry and can run it with Node.
    const nixPackages = messageData?.nixConfig?.packages ?? [];
    const workerEntryPoint = this.getWorkerEntryPoint();
    const workerInvocation = buildWorkerInvocation(workerEntryPoint);

    let command: string;
    let spawnArgs: string[];

    if (nixPackages.length > 0) {
      // Wrap in nix-shell so nix binaries are on PATH.
      command = "nix-shell";
      spawnArgs = [
        "-p",
        ...nixPackages,
        "--run",
        buildShellCommand(workerInvocation.command, workerInvocation.args),
      ];
      logger.info(
        `Spawning embedded worker ${deploymentName} with nix packages: ${nixPackages.join(", ")}`
      );
    } else {
      command = workerInvocation.command;
      spawnArgs = workerInvocation.args;
    }

    // On Linux production hosts, wrap the worker in a transient systemd
    // user scope: cgroup limits + IPAddressDeny + capability drops. Falls
    // back transparently on macOS / Linux hosts without user systemd.
    const systemdRun = locateSystemdRun();
    if (systemdRun) {
      const unitName = makeUnitName(deploymentName);
      const innerCommand = command;
      const innerArgs = spawnArgs;
      command = systemdRun;
      spawnArgs = [
        ...buildSystemdRunArgs({ unitName, workspaceDir }),
        "--",
        innerCommand,
        ...innerArgs,
      ];
      logger.info(
        `Spawning embedded worker ${deploymentName} under systemd-run scope ${unitName}`
      );
    }

    const child = spawn(command, spawnArgs, {
      env: { ...process.env, ...commonEnvVars },
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Spawn errors (binary missing, EACCES, fork failure) fire on the child
    // *after* spawn() returns, so without an "error" listener Node would
    // throw an unhandled exception and crash the gateway. Drop the entry
    // and log so the next ensureDeployment can retry cleanly.
    child.once("error", (err) => {
      logger.error(
        `Embedded worker ${deploymentName} spawn error: ${err.message}`
      );
      this.workers.delete(deploymentName);
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().trimEnd().split("\n")) {
        logger.info({ worker: deploymentName }, line);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trimEnd().split("\n")) {
        logger.warn({ worker: deploymentName }, line);
      }
    });

    child.once("exit", (code, signal) => {
      const entry = this.workers.get(deploymentName);
      if (entry) {
        this.workers.delete(deploymentName);
      }
      if (signal) {
        logger.info(
          `Embedded worker ${deploymentName} exited with signal ${signal}`
        );
      } else if (code !== 0) {
        logger.error(
          `Embedded worker ${deploymentName} exited with code ${code}`
        );
      } else {
        logger.info(`Embedded worker ${deploymentName} exited cleanly`);
      }
    });

    this.workers.set(deploymentName, {
      process: child,
      env: commonEnvVars,
      lastActivity: new Date(),
      workspaceDir,
    });

    logger.info(
      `Started embedded worker subprocess for ${deploymentName} (pid=${child.pid})`
    );
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    const entry = this.workers.get(deploymentName);

    if (replicas === 0 && entry) {
      await this.killWorker(entry, deploymentName);
      logger.info(`Stopped embedded worker ${deploymentName}`);
    } else if (replicas === 1 && !entry) {
      logger.warn(
        `Cannot scale up ${deploymentName} — use ensureDeployment to re-spawn`
      );
    }
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    const entry = this.workers.get(deploymentName);
    if (entry) {
      await this.killWorker(entry, deploymentName);
      logger.info(`Stopped embedded worker: ${deploymentName}`);
    }
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    const now = Date.now();
    const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
    const veryOldDays = getVeryOldThresholdDays(this.config);

    const results: DeploymentInfo[] = [];
    for (const [deploymentName, entry] of this.workers) {
      results.push(
        buildDeploymentInfoSummary({
          deploymentName,
          lastActivity: entry.lastActivity,
          now,
          idleThresholdMinutes,
          veryOldDays,
          replicas: 1,
        })
      );
    }
    return results;
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    const entry = this.workers.get(deploymentName);
    if (entry) {
      entry.lastActivity = new Date();
    }
  }

  /** Send SIGTERM, then SIGKILL after timeout. Resolves on child exit. */
  private async killWorker(
    entry: EmbeddedWorkerEntry,
    deploymentName: string
  ): Promise<void> {
    const child = entry.process;

    // Delete from map first to prevent race with the exit handler.
    this.workers.delete(deploymentName);

    // Already exited — `exitCode`/`signalCode` are the only reliable
    // indicators here. `child.killed` is set the moment we *send* a signal,
    // so checking it would mis-treat "we just sent SIGTERM" as "already
    // exited" and skip the SIGKILL escalation below.
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    child.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(
          `Embedded worker ${deploymentName} did not exit after SIGTERM, sending SIGKILL`
        );
        child.kill("SIGKILL");
      }
    }, KILL_TIMEOUT_MS);

    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }
}
