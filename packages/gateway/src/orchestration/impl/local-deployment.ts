import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createLogger, ErrorCode, OrchestratorError } from "@peerbot/core";

// Type for SandboxManager singleton - using minimal interface for dynamic import
interface ISandboxManager {
  initialize(
    config: SandboxRuntimeConfig,
    callback?: unknown,
    enableLogMonitor?: boolean
  ): Promise<void>;
  wrapWithSandbox(command: string): Promise<string>;
  reset(): Promise<void>;
}

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

interface LocalProcess {
  process: ChildProcess;
  createdAt: Date;
  lastActivity: Date;
  agentId: string;
}

/**
 * LocalDeploymentManager - Spawns peerbot workers as local subprocesses
 *
 * This deployment manager runs workers directly on the host machine using
 * child_process.spawn(). Useful for development and single-machine deployments.
 *
 * Key features:
 * - No Docker or Kubernetes required
 * - Workers run as child processes of the gateway
 * - Workspaces stored in local filesystem
 * - Process cleanup on idle timeout
 */
export class LocalDeploymentManager extends BaseDeploymentManager {
  private processes: Map<string, LocalProcess> = new Map();
  private workerEntryPath: string;

  // Sandbox runtime state
  private sandboxEnabled = false;
  private sandboxInitialized = false;
  private SandboxManager: ISandboxManager | null = null;

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder
  ) {
    super(config, moduleEnvVarsBuilder);

    // Resolve worker entry point path
    // In development: packages/worker/src/index.ts
    // In production: packages/worker/dist/index.js (built)
    const projectRoot = this.findProjectRoot();
    this.workerEntryPath = path.join(
      projectRoot,
      "packages/worker/src/index.ts"
    );

    // Verify worker entry point exists
    if (!fs.existsSync(this.workerEntryPath)) {
      // Try dist path for production builds
      const distPath = path.join(projectRoot, "packages/worker/dist/index.js");
      if (fs.existsSync(distPath)) {
        this.workerEntryPath = distPath;
      } else {
        logger.warn(
          `⚠️ Worker entry point not found at ${this.workerEntryPath} or ${distPath}`
        );
      }
    }

    logger.info(`✅ LocalDeploymentManager initialized`);
    logger.info(`   Worker entry: ${this.workerEntryPath}`);

    // Detect sandbox support (async, but don't block constructor)
    this.detectSandboxSupport().catch((err) => {
      logger.warn(`Failed to detect sandbox support: ${err}`);
    });
  }

  /**
   * Detect if sandbox runtime is available and should be enabled
   */
  private async detectSandboxSupport(): Promise<void> {
    // Explicit opt-out via environment variable
    if (process.env.SANDBOX_ENABLED === "false") {
      logger.info("🔓 Sandbox disabled via SANDBOX_ENABLED=false");
      return;
    }

    // Try to import sandbox runtime
    try {
      const sandboxModule = await import("@anthropic-ai/sandbox-runtime");
      this.SandboxManager = sandboxModule.SandboxManager;
    } catch {
      logger.warn(
        "⚠️ Sandbox runtime not available. Local mode running without OS-level isolation."
      );
      logger.warn("   Install with: bun add @anthropic-ai/sandbox-runtime");
      return;
    }

    // Default: enable if available
    this.sandboxEnabled = true;
    logger.info("🔒 Sandbox runtime detected, OS-level isolation enabled");
  }

  /**
   * Initialize sandbox with configuration for worker processes
   */
  private async initializeSandbox(workspaceDir: string): Promise<void> {
    if (!this.SandboxManager || this.sandboxInitialized) {
      return;
    }

    const config: SandboxRuntimeConfig = {
      network: {
        // Only allow gateway communication at OS level
        // Workers use HTTP_PROXY for external access (existing proxy handles domain filtering)
        allowedDomains: ["localhost", "127.0.0.1"],
        deniedDomains: [],
      },
      filesystem: {
        allowWrite: [
          workspaceDir,
          "/tmp",
          "/private/tmp", // macOS uses /private/tmp
          path.join(workspaceDir, ".claude"),
          path.join(workspaceDir, "input"),
          path.join(workspaceDir, "output"),
          "/tmp/agent-processes",
          "/tmp/claude-logs",
        ],
        denyRead: [
          "~/.ssh",
          "~/.aws",
          "~/.config/gcloud",
          "~/.azure",
          "~/.kube",
        ],
        denyWrite: [".env"],
        allowGitConfig: true, // Required for git init/commit in sandbox
      },
    };

    try {
      await this.SandboxManager.initialize(config);
      this.sandboxInitialized = true;
      logger.info("🔒 Sandbox initialized with workspace isolation");
    } catch (err) {
      logger.error(`Failed to initialize sandbox: ${err}`);
      this.sandboxEnabled = false;
    }
  }

  /**
   * Find the peerbot project root directory
   */
  private findProjectRoot(): string {
    // Check environment variable first
    if (process.env.PEERBOT_PROJECT_ROOT) {
      return process.env.PEERBOT_PROJECT_ROOT;
    }

    // Walk up from current directory looking for package.json with peerbot
    let currentDir = process.cwd();
    for (let i = 0; i < 10; i++) {
      const packageJsonPath = path.join(currentDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, "utf-8")
          );
          // Check if this is the monorepo root:
          // - Has workspaces array (monorepo indicator)
          // - Or has name "peerbot" or "create-peerbot"
          if (
            packageJson.name === "peerbot" ||
            packageJson.name === "create-peerbot" ||
            (Array.isArray(packageJson.workspaces) &&
              packageJson.workspaces.length > 0)
          ) {
            return currentDir;
          }
        } catch {
          // Ignore parse errors
        }
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    // Fallback to cwd
    return process.cwd();
  }

  /**
   * Get the workspace directory for a space
   */
  private getWorkspaceDir(agentId: string): string {
    const baseDir =
      process.env.PEERBOT_WORKSPACES_DIR ||
      path.join(this.findProjectRoot(), "workspaces");
    return path.join(baseDir, agentId);
  }

  /**
   * Ensure workspace directory exists with proper permissions
   */
  private async ensureWorkspace(agentId: string): Promise<string> {
    const workspaceDir = this.getWorkspaceDir(agentId);

    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o755 });
      logger.info(`✅ Created workspace directory: ${workspaceDir}`);
    }

    return workspaceDir;
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    const now = Date.now();
    const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
    const veryOldDays = getVeryOldThresholdDays(this.config);

    return Array.from(this.processes.entries()).map(
      ([deploymentName, localProcess]) => {
        const replicas =
          localProcess.process.exitCode === null && !localProcess.process.killed
            ? 1
            : 0;

        return buildDeploymentInfoSummary({
          deploymentName,
          lastActivity: localProcess.lastActivity,
          now,
          idleThresholdMinutes,
          veryOldDays,
          replicas,
        });
      }
    );
  }

  async createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload,
    userEnvVars?: Record<string, string>
  ): Promise<void> {
    // Check if deployment already exists
    const existingProcess = this.processes.get(deploymentName);
    if (
      existingProcess &&
      existingProcess.process.exitCode === null &&
      !existingProcess.process.killed
    ) {
      logger.info(
        `Deployment ${deploymentName} already running (PID: ${existingProcess.process.pid})`
      );
      existingProcess.lastActivity = new Date();
      return;
    }

    try {
      // Use agentId for workspace (shared across threads in same space)
      const agentId = messageData?.agentId!;

      // Ensure workspace exists
      const workspaceDir = await this.ensureWorkspace(agentId);

      // Generate environment variables using base class method
      const envVars = await this.generateEnvironmentVariables(
        username,
        userId,
        deploymentName,
        messageData,
        true, // Include secrets
        userEnvVars ?? {}
      );

      // Override workspace directory for local mode
      envVars.WORKSPACE_DIR = workspaceDir;

      // Skip git templates - they fail in sandbox (nested directory writes)
      envVars.GIT_TEMPLATE_DIR = "";

      // Initialize sandbox if enabled
      if (this.sandboxEnabled && !this.sandboxInitialized) {
        await this.initializeSandbox(workspaceDir);
      }

      // Determine which runtime to use
      const runtime = this.detectRuntime();

      // Resolve entry path for selected runtime
      let entryPath = this.workerEntryPath;
      if (runtime === "node" && entryPath.endsWith(".ts")) {
        const distPath = entryPath
          .replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`)
          .replace(/\.ts$/, ".js");
        if (fs.existsSync(distPath)) {
          entryPath = distPath;
        } else {
          throw new Error(
            "Local deployment with node requires built worker dist or bun runtime"
          );
        }
      }

      // Build spawn arguments
      const spawnArgs = this.buildSpawnArgs(runtime, entryPath);

      logger.info(`🚀 Spawning local worker: ${deploymentName}`);
      logger.info(`   Runtime: ${runtime}`);
      logger.info(`   Entry: ${entryPath}`);
      logger.info(`   Workspace: ${workspaceDir}`);
      logger.info(
        `   Sandbox: ${this.sandboxEnabled ? "enabled" : "disabled"}`
      );

      // Spawn worker process (optionally wrapped in sandbox)
      let proc: ChildProcess;

      if (this.sandboxEnabled && this.SandboxManager) {
        // Wrap command with sandbox isolation
        const fullCommand = `${runtime} ${spawnArgs.join(" ")}`;
        const wrappedCommand =
          await this.SandboxManager.wrapWithSandbox(fullCommand);

        logger.debug(`Sandbox wrapped command: ${wrappedCommand}`);

        proc = spawn(wrappedCommand, [], {
          env: { ...process.env, ...envVars },
          cwd: workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          detached: false,
          shell: true, // Required for sandbox-wrapped commands
        });
      } else {
        // Standard spawn without sandbox
        proc = spawn(runtime, spawnArgs, {
          env: { ...process.env, ...envVars },
          cwd: workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          detached: false,
        });
      }

      // Handle process output
      proc.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          logger.info(`[${deploymentName}] ${line}`);
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          logger.error(`[${deploymentName}] ${line}`);
        }
      });

      // Handle process exit
      proc.on("exit", (code, signal) => {
        logger.info(
          `Worker ${deploymentName} exited with code ${code}, signal ${signal}`
        );
        // Don't remove from map - let reconciliation handle cleanup
      });

      proc.on("error", (error) => {
        logger.error(`Worker ${deploymentName} error:`, error);
      });

      // Store process reference
      this.processes.set(deploymentName, {
        process: proc,
        createdAt: new Date(),
        lastActivity: new Date(),
        agentId,
      });

      logger.info(
        `✅ Created local worker deployment: ${deploymentName} (PID: ${proc.pid})`
      );
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to spawn local worker: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, error },
        true
      );
    }
  }

  /**
   * Detect which JavaScript runtime to use
   */
  private detectRuntime(): string {
    // Check for bun first (preferred for this project)
    if (process.env.BUN_INSTALL || this.commandExists("bun")) {
      return "bun";
    }

    // Fall back to node
    return "node";
  }

  /**
   * Check if a command exists in PATH
   */
  private commandExists(command: string): boolean {
    try {
      const { execSync } = require("node:child_process");
      execSync(`which ${command}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build spawn arguments for the runtime
   */
  private buildSpawnArgs(runtime: string, entryPath: string): string[] {
    if (runtime === "bun") {
      return ["run", entryPath];
    }
    return [entryPath];
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    const localProcess = this.processes.get(deploymentName);

    if (!localProcess) {
      if (replicas > 0) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_SCALE_FAILED,
          `Cannot scale deployment ${deploymentName}: not found`,
          { deploymentName, replicas },
          true
        );
      }
      return;
    }

    if (replicas === 0) {
      // Scale down - kill the process
      if (
        localProcess.process.exitCode === null &&
        !localProcess.process.killed
      ) {
        logger.info(
          `Stopping worker ${deploymentName} (PID: ${localProcess.process.pid})`
        );
        localProcess.process.kill("SIGTERM");

        // Give it time to shutdown gracefully
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (!localProcess.process.killed) {
              logger.warn(
                `Worker ${deploymentName} did not exit gracefully, sending SIGKILL`
              );
              localProcess.process.kill("SIGKILL");
            }
            resolve();
          }, 5000);

          localProcess.process.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        logger.info(`✅ Stopped worker ${deploymentName}`);
      }
    } else if (replicas === 1) {
      // Scale up - restart if not running
      if (
        localProcess.process.exitCode !== null ||
        localProcess.process.killed
      ) {
        // Process is dead, remove and let caller recreate
        this.processes.delete(deploymentName);
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_SCALE_FAILED,
          `Worker ${deploymentName} is not running, needs recreation`,
          { deploymentName, replicas },
          true
        );
      }
      // Already running
      localProcess.lastActivity = new Date();
    }
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    const localProcess = this.processes.get(deploymentName);

    if (!localProcess) {
      logger.warn(`⚠️ Deployment ${deploymentName} not found (already deleted)`);
      return;
    }

    // Kill the process if still running
    if (
      localProcess.process.exitCode === null &&
      !localProcess.process.killed
    ) {
      logger.info(
        `Killing worker ${deploymentName} (PID: ${localProcess.process.pid})`
      );
      localProcess.process.kill("SIGTERM");

      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!localProcess.process.killed) {
            localProcess.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        localProcess.process.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    // Remove from tracking map
    this.processes.delete(deploymentName);
    logger.info(`✅ Deleted deployment: ${deploymentName}`);

    // NOTE: Workspace directories are NOT deleted
    // They persist for future conversations in the same space
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    const localProcess = this.processes.get(deploymentName);
    if (localProcess) {
      localProcess.lastActivity = new Date();
      logger.debug(`Updated activity timestamp for ${deploymentName}`);
    }
  }

  protected getDispatcherHost(): string {
    // Local mode - gateway and workers run on the same machine
    return "localhost";
  }

  /**
   * Cleanup all running workers (called on gateway shutdown)
   */
  async cleanup(): Promise<void> {
    logger.info(
      `🧹 Cleaning up ${this.processes.size} local worker processes...`
    );

    const shutdownPromises: Promise<void>[] = [];

    for (const [, localProcess] of this.processes) {
      if (
        localProcess.process.exitCode === null &&
        !localProcess.process.killed
      ) {
        shutdownPromises.push(
          new Promise<void>((resolve) => {
            localProcess.process.kill("SIGTERM");

            const timeout = setTimeout(() => {
              if (!localProcess.process.killed) {
                localProcess.process.kill("SIGKILL");
              }
              resolve();
            }, 3000);

            localProcess.process.once("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          })
        );
      }
    }

    await Promise.all(shutdownPromises);
    this.processes.clear();

    // Reset sandbox if it was initialized
    if (this.sandboxInitialized && this.SandboxManager) {
      try {
        await this.SandboxManager.reset();
        this.sandboxInitialized = false;
        logger.info("🔓 Sandbox runtime reset");
      } catch (err) {
        logger.warn(`Failed to reset sandbox: ${err}`);
      }
    }

    logger.info("✅ All local workers cleaned up");
  }
}
