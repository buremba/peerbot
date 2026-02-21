export * from "./base-deployment-manager";
export * from "./deployment-utils";
export * from "./impl";

import {
  createLogger,
  type ModelProviderModule,
  moduleRegistry,
} from "@lobu/core";
import type Redis from "ioredis";
import type {
  BaseDeploymentManager,
  OrchestratorConfig,
} from "./base-deployment-manager";
import { buildModuleEnvVars } from "./deployment-utils";
import {
  DockerDeploymentManager,
  FlyDeploymentManager,
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
  private shuttingDown = false;
  private cleanupInterval?: NodeJS.Timeout;
  private activeReconciliation: Promise<void> | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.deploymentManager = this.createDeploymentManager(config);
    this.queueConsumer = new MessageConsumer(config, this.deploymentManager);
  }

  /**
   * Inject core services into the orchestrator after gateway initialization.
   * Provider modules in the registry carry their own credential stores,
   * so only the Redis client is needed for secret placeholder generation.
   */
  async injectCoreServices(redisClient?: Redis): Promise<void> {
    // Inject Redis client into deployment manager for secret placeholder generation
    if (redisClient) {
      this.deploymentManager.setRedisClient(redisClient);
    }

    // Refresh provider modules after gateway/core services have registered them.
    const providerModules = moduleRegistry.getModelProviderModules();
    this.deploymentManager.setProviderModules(providerModules);
    this.queueConsumer.setProviderModules(providerModules);
    logger.info(
      `✅ Provider modules injected into orchestrator (${providerModules.length})`
    );

    logger.info("✅ Core services injected into orchestrator");
  }

  private createDeploymentManager(
    config: OrchestratorConfig
  ): BaseDeploymentManager {
    const deploymentMode = process.env.DEPLOYMENT_MODE;
    const providerModules: ModelProviderModule[] =
      moduleRegistry.getModelProviderModules();

    if (deploymentMode === "local") {
      logger.info("🏠 Using local deployment mode (subprocess workers)");
      return new LocalDeploymentManager(
        config,
        buildModuleEnvVars,
        providerModules
      );
    }

    if (deploymentMode === "docker") {
      if (!this.isDockerAvailable()) {
        logger.error("DEPLOYMENT_MODE=docker but Docker is not available");
        throw new Error("DEPLOYMENT_MODE=docker but Docker is not available");
      }
      return new DockerDeploymentManager(
        config,
        buildModuleEnvVars,
        providerModules
      );
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
      return new K8sDeploymentManager(
        config,
        buildModuleEnvVars,
        providerModules
      );
    }

    if (deploymentMode === "fly") {
      logger.info("🪁 Using Fly deployment mode (Machines API)");
      return new FlyDeploymentManager(
        config,
        buildModuleEnvVars,
        providerModules
      );
    }

    // Auto-detect deployment mode
    if (this.isKubernetesAvailable()) {
      logger.info("🎯 Auto-detected Kubernetes, using K8s deployment mode");
      return new K8sDeploymentManager(
        config,
        buildModuleEnvVars,
        providerModules
      );
    }

    if (this.isDockerAvailable()) {
      logger.info("🐳 Auto-detected Docker, using Docker deployment mode");
      return new DockerDeploymentManager(
        config,
        buildModuleEnvVars,
        providerModules
      );
    }

    // Fall back to local mode if nothing else is available
    logger.info(
      "🏠 No container runtime detected, falling back to local deployment mode"
    );
    return new LocalDeploymentManager(
      config,
      buildModuleEnvVars,
      providerModules
    );
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
      execSync("docker version", {
        stdio: "ignore",
        timeout: 5000,
        env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST },
      });
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

      // Module registration can happen during initAll(); refresh providers
      // so deployment/message processing uses the latest auth modules.
      const providerModules = moduleRegistry.getModelProviderModules();
      this.deploymentManager.setProviderModules(providerModules);
      this.queueConsumer.setProviderModules(providerModules);
      logger.info(
        `✅ Refreshed provider modules for orchestrator (${providerModules.length})`
      );

      // Validate configured worker runtime/image before consuming messages.
      await this.deploymentManager.validateWorkerImage();

      // Start K8s informer for watch-based reconciliation and reconcile stale worker templates
      if (this.deploymentManager instanceof K8sDeploymentManager) {
        await this.deploymentManager.startInformer();
        await this.deploymentManager.reconcileWorkerDeploymentImages();
      }

      // Start queue consumer
      await this.queueConsumer.start();

      // Setup periodic cleanup (reduced interval when informer is active)
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
    this.shuttingDown = true;

    try {
      // Stop scheduling new reconciliation cycles
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = undefined;
      }

      // Wait for in-flight reconciliation to finish (with 10s timeout)
      if (this.activeReconciliation) {
        logger.info("Waiting for in-flight reconciliation to complete...");
        await Promise.race([
          this.activeReconciliation,
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
        this.activeReconciliation = null;
      }

      await this.queueConsumer.stop();

      // Stop K8s informer
      if (this.deploymentManager instanceof K8sDeploymentManager) {
        await this.deploymentManager.stopInformer();
      }

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
      if (this.shuttingDown) return;
      const p = this.deploymentManager.reconcileDeployments().catch((error) => {
        logger.error("❌ Initial deployment reconciliation failed:", error);
      });
      this.activeReconciliation = p;
      p.finally(() => {
        if (this.activeReconciliation === p) this.activeReconciliation = null;
      });
    }, this.config.cleanup.initialDelayMs);

    // When informer is active, reduce polling to 5min safety-net interval
    const hasInformer =
      this.deploymentManager instanceof K8sDeploymentManager &&
      this.deploymentManager.isInformerActive();
    const intervalMs = hasInformer
      ? Math.max(this.config.cleanup.intervalMs, 5 * 60 * 1000)
      : this.config.cleanup.intervalMs;

    if (hasInformer) {
      logger.info(
        `Informer active, reconciliation interval set to ${intervalMs / 1000}s (safety net)`
      );
    }

    this.cleanupInterval = setInterval(async () => {
      if (this.shuttingDown) return;
      try {
        const p = this.deploymentManager.reconcileDeployments();
        this.activeReconciliation = p;
        await p;
      } catch (error) {
        logger.error(
          "Error during deployment reconciliation:",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.activeReconciliation = null;
      }
    }, intervalMs);
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
