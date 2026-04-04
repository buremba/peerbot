import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLogger, ErrorCode, OrchestratorError } from "@lobu/core";
import type { ModelProviderModule } from "../../modules/module-system";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type MessagePayload,
  type ModuleEnvVarsBuilder,
  type OrchestratorConfig,
} from "../base-deployment-manager";
import {
  buildDeploymentInfoSummary,
  getVeryOldThresholdDays,
} from "../deployment-utils";

const logger = createLogger("orchestrator");

/** Timeout (ms) to wait for graceful shutdown before SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;
const WORKER_BIN_DIR_CANDIDATES = [
  path.resolve("node_modules/.bin"),
  path.resolve("packages/worker/node_modules/.bin"),
  "/app/node_modules/.bin",
  "/app/packages/worker/node_modules/.bin",
] as const;

interface EmbeddedWorkerEntry {
  process: ChildProcess;
  env: Record<string, string>;
  lastActivity: Date;
  workspaceDir: string;
}

function buildEmbeddedWorkerPath(existingPath?: string): string | undefined {
  const segments = (existingPath || "").split(":").filter(Boolean);

  for (const candidate of [...WORKER_BIN_DIR_CANDIDATES].reverse()) {
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
    return "localhost";
  }

  async validateWorkerImage(): Promise<void> {
    const entryPoint = path.resolve("packages/worker/src/index.ts");
    if (!fs.existsSync(entryPoint)) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Worker entry point not found: ${entryPoint}. Run from the project root.`
      );
    }
    logger.debug(`Worker entry point verified: ${entryPoint}`);
  }

  async createDeployment(
    ...args: Parameters<BaseDeploymentManager["createDeployment"]>
  ): Promise<void> {
    const [deploymentName, username, userId, messageDataRaw] = args;
    const messageData = messageDataRaw as MessagePayload | undefined;

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
    commonEnvVars.DEPLOYMENT_MODE = "embedded";
    const embeddedPath = buildEmbeddedWorkerPath(
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

    // Determine spawn command based on nix packages
    const nixPackages = messageData?.nixConfig?.packages ?? [];
    const workerEntryPoint = path.resolve("packages/worker/src/index.ts");
    const bunExecutable = getBunExecutable();

    let command: string;
    let spawnArgs: string[];

    if (nixPackages.length > 0) {
      // Wrap in nix-shell so nix binaries are on PATH
      command = "nix-shell";
      spawnArgs = [
        "-p",
        ...nixPackages,
        "--run",
        `${bunExecutable} run ${workerEntryPoint}`,
      ];
      logger.info(
        `Spawning embedded worker ${deploymentName} with nix packages: ${nixPackages.join(", ")}`
      );
    } else {
      command = bunExecutable;
      spawnArgs = ["run", workerEntryPoint];
    }

    const child = spawn(command, spawnArgs, {
      env: { ...process.env, ...commonEnvVars },
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Pipe child stdout/stderr to gateway logger
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

    // Handle child exit (use once to prevent duplicate handler invocations)
    child.once("exit", (code, signal) => {
      const entry = this.workers.get(deploymentName);
      if (entry) {
        this.workers.delete(deploymentName);
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
      this.killWorker(entry, deploymentName);
      logger.info(`Stopped embedded worker ${deploymentName}`);
    } else if (replicas === 1 && !entry) {
      logger.warn(
        `Cannot scale up ${deploymentName} — use createDeployment to re-spawn`
      );
    }
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    const entry = this.workers.get(deploymentName);
    if (entry) {
      this.killWorker(entry, deploymentName);
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

  /** Send SIGTERM, then SIGKILL after timeout. */
  private killWorker(entry: EmbeddedWorkerEntry, deploymentName: string): void {
    const child = entry.process;

    // Delete from map first to prevent race with exit handler
    this.workers.delete(deploymentName);

    // Check if already exited after map deletion
    if (child.exitCode !== null || child.killed) return;

    child.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        logger.warn(
          `Embedded worker ${deploymentName} did not exit after SIGTERM, sending SIGKILL`
        );
        child.kill("SIGKILL");
      }
    }, KILL_TIMEOUT_MS);

    child.once("exit", () => clearTimeout(killTimer));
  }
}
