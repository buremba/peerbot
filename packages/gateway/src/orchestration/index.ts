export * from "./base-deployment-manager";
export * from "./deployment-utils";
export * from "./impl";

import { createLogger, moduleRegistry } from "@peerbot/core";
import type { ClaudeCredentialStore } from "../auth/claude/credential-store";
import type {
  BaseDeploymentManager,
  OrchestratorConfig,
} from "./base-deployment-manager";
import { buildModuleEnvVars } from "./deployment-utils";
import {
  DockerDeploymentManager,
  K8sDeploymentManager,
  LocalDeploymentManager,
} from "./impl";
import { MessageConsumer } from "./message-consumer";

const logger = createLogger("orchestrator");

export class Orchestrator {
  private config: OrchestratorConfig;
  private deploymentManager: BaseDeploymentManager;
  private queueConsumer: MessageConsumer;
  private isRunning = false;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.deploymentManager = this.createDeploymentManager(config);
    this.queueConsumer = new MessageConsumer(config, this.deploymentManager);
  }

  /**
   * Inject core services into the orchestrator after gateway initialization
   * This allows the message consumer to check authentication before creating workers
   */
  async injectCoreServices(
    credentialStore?: ClaudeCredentialStore,
    systemApiKey?: string
  ): Promise<void> {
    // Stop the old consumer if running
    if (this.isRunning) {
      await this.queueConsumer.stop();
    }

    // Create new consumer with injected services
    this.queueConsumer = new MessageConsumer(
      this.config,
      this.deploymentManager,
      credentialStore,
      systemApiKey
    );

    // Restart the consumer if orchestrator was running
    if (this.isRunning) {
      await this.queueConsumer.start();
    }

    logger.info("✅ Core services injected into orchestrator");
  }

  private createDeploymentManager(
    config: OrchestratorConfig
  ): BaseDeploymentManager {
    const deploymentMode = process.env.DEPLOYMENT_MODE;

    if (deploymentMode === "local") {
      logger.info("🏠 Using local deployment mode (subprocess workers)");
      return new LocalDeploymentManager(config, buildModuleEnvVars);
    }

    if (deploymentMode === "docker") {
      if (!this.isDockerAvailable()) {
        logger.error("DEPLOYMENT_MODE=docker but Docker is not available");
        throw new Error("DEPLOYMENT_MODE=docker but Docker is not available");
      }
      return new DockerDeploymentManager(config, buildModuleEnvVars);
    }

    if (deploymentMode === "kubernetes" || deploymentMode === "k8s") {
      if (!this.isKubernetesAvailable()) {
        logger.error(
          "DEPLOYMENT_MODE=kubernetes but Kubernetes is not available"
        );
        throw new Error(
          "DEPLOYMENT_MODE=kubernetes but Kubernetes is not available"
        );
      }
      return new K8sDeploymentManager(config, buildModuleEnvVars);
    }

    // Auto-detect deployment mode
    if (this.isKubernetesAvailable()) {
      logger.info("🎯 Auto-detected Kubernetes, using K8s deployment mode");
      return new K8sDeploymentManager(config, buildModuleEnvVars);
    }

    if (this.isDockerAvailable()) {
      logger.info("🐳 Auto-detected Docker, using Docker deployment mode");
      return new DockerDeploymentManager(config, buildModuleEnvVars);
    }

    // Fall back to local mode if nothing else is available
    logger.info(
      "🏠 No container runtime detected, falling back to local deployment mode"
    );
    return new LocalDeploymentManager(config, buildModuleEnvVars);
  }

  private isKubernetesAvailable(): boolean {
    try {
      if (process.env.KUBERNETES_SERVICE_HOST) {
        return true;
      }

      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");

      const kubeconfigPaths = [
        process.env.KUBECONFIG,
        path.join(os.homedir(), ".kube", "config"),
      ].filter(Boolean);

      return kubeconfigPaths.some((configPath) => {
        try {
          return fs.existsSync(configPath) && fs.statSync(configPath).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  private isDockerAvailable(): boolean {
    try {
      const { execSync } = require("node:child_process");
      execSync("docker version", { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    try {
      // Initialize modules
      await moduleRegistry.initAll();
      logger.info("✅ Modules initialized for orchestration");

      // Validate worker image exists (Docker mode only)
      if (this.deploymentManager instanceof DockerDeploymentManager) {
        await this.deploymentManager.validateWorkerImage();
      }

      // Start queue consumer
      await this.queueConsumer.start();

      // Setup periodic cleanup
      this.setupIdleCleanup();

      this.isRunning = true;
      logger.info("✅ Orchestrator started successfully");
    } catch (error) {
      logger.error("❌ Failed to start orchestrator:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = undefined;
      }

      await this.queueConsumer.stop();

      // Clean up local worker processes if using local deployment mode
      if (this.deploymentManager instanceof LocalDeploymentManager) {
        await this.deploymentManager.cleanup();
      }

      logger.info("✅ Orchestrator stopped");
    } catch (error) {
      logger.error("❌ Error stopping orchestrator:", error);
    }
  }

  private setupIdleCleanup(): void {
    setTimeout(() => {
      this.deploymentManager.reconcileDeployments().catch((error) => {
        logger.error("❌ Initial deployment reconciliation failed:", error);
      });
    }, this.config.cleanup.initialDelayMs);

    this.cleanupInterval = setInterval(async () => {
      try {
        await this.deploymentManager.reconcileDeployments();
      } catch (error) {
        logger.error(
          "Error during deployment reconciliation:",
          error instanceof Error ? error.message : String(error)
        );
      }
    }, this.config.cleanup.intervalMs);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      config: {
        kubernetes: {
          namespace: this.config.kubernetes.namespace,
        },
        queues: {
          retryLimit: this.config.queues.retryLimit,
          expireInSeconds: this.config.queues.expireInSeconds,
        },
      },
    };
  }

  async getQueueStats() {
    return this.queueConsumer.getQueueStats();
  }
}
