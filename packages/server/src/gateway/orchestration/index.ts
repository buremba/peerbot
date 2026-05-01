export * from "./base-deployment-manager.js";
export * from "./deployment-utils.js";
export * from "./impl/index.js";

import { createLogger, moduleRegistry } from "@lobu/core";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import {
  getModelProviderModules,
  type ModelProviderModule,
} from "../modules/module-system.js";
import type { GrantStore } from "../permissions/grant-store.js";
import type { PolicyStore } from "../permissions/policy-store.js";
import type { WritableSecretStore } from "../secrets/index.js";
import type {
  BaseDeploymentManager,
  OrchestratorConfig,
} from "./base-deployment-manager.js";
import { buildModuleEnvVars } from "./deployment-utils.js";
import { EmbeddedDeploymentManager } from "./impl/index.js";
import { MessageConsumer } from "./message-consumer.js";

const logger = createLogger("orchestrator");

export class Orchestrator {
  private config: OrchestratorConfig;
  private deploymentManager: BaseDeploymentManager;
  private queueConsumer: MessageConsumer;
  private isRunning = false;
  private shuttingDown = false;
  private cleanupInterval?: NodeJS.Timeout;
  private initialReconcileTimer?: NodeJS.Timeout;
  private activeReconciliation: Promise<void> | null = null;
  private isReconciling = false;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    const providerModules: ModelProviderModule[] = getModelProviderModules();
    this.deploymentManager = new EmbeddedDeploymentManager(
      config,
      buildModuleEnvVars,
      providerModules
    );
    this.queueConsumer = new MessageConsumer(config, this.deploymentManager);
  }

  /**
   * Inject core services into the orchestrator after gateway initialization.
   * Provider modules in the registry carry their own credential stores;
   * the deployment manager wires its secret store + grant/policy stores from
   * here.
   */
  async injectCoreServices(
    secretStore: WritableSecretStore,
    providerCatalogService?: ProviderCatalogService,
    grantStore?: GrantStore,
    policyStore?: PolicyStore
  ): Promise<void> {
    this.deploymentManager.setSecretStore(secretStore);

    if (grantStore) {
      this.deploymentManager.setGrantStore(grantStore);
    }

    if (policyStore) {
      this.deploymentManager.setPolicyStore(policyStore);
    }

    if (providerCatalogService) {
      this.deploymentManager.setProviderCatalogService(providerCatalogService);
    }

    const providerModules = getModelProviderModules();
    this.deploymentManager.setProviderModules(providerModules);
    logger.debug(
      `Provider modules injected into orchestrator (${providerModules.length})`
    );
  }

  async start(): Promise<void> {
    try {
      await moduleRegistry.initAll();
      const providerModules = getModelProviderModules();
      this.deploymentManager.setProviderModules(providerModules);

      await this.deploymentManager.validateWorkerImage();

      await this.queueConsumer.start();

      this.setupIdleCleanup();

      this.isRunning = true;
      logger.debug("Orchestrator started");
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
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = undefined;
      }
      if (this.initialReconcileTimer) {
        clearTimeout(this.initialReconcileTimer);
        this.initialReconcileTimer = undefined;
      }

      if (this.activeReconciliation) {
        logger.info("Waiting for in-flight reconciliation to complete...");
        const safeReconciliation = this.activeReconciliation.catch((error) => {
          logger.error(
            "In-flight reconciliation failed during shutdown:",
            error
          );
        });
        await Promise.race([
          safeReconciliation,
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
        this.activeReconciliation = null;
      }

      await this.queueConsumer.stop();

      // Drain active worker subprocesses so SIGINT to `lobu run` doesn't
      // leave orphaned workers behind. The base manager's deleteDeployment
      // is the right exit path — embedded sends SIGTERM/SIGKILL and awaits
      // exit; other impls would no-op locally and that's fine.
      try {
        const active = await this.deploymentManager.listDeployments();
        await Promise.allSettled(
          active.map((d) =>
            this.deploymentManager.deleteDeployment(d.deploymentName)
          )
        );
      } catch (error) {
        logger.error("Error draining workers during shutdown:", error);
      }

      logger.info("✅ Orchestrator stopped");
    } catch (error) {
      logger.error("❌ Error stopping orchestrator:", error);
    }
  }

  private setupIdleCleanup(): void {
    this.initialReconcileTimer = setTimeout(() => {
      this.initialReconcileTimer = undefined;
      if (this.shuttingDown) return;
      const p = this.deploymentManager.reconcileDeployments().catch((error) => {
        logger.error("❌ Initial deployment reconciliation failed:", error);
      });
      this.activeReconciliation = p;
      p.finally(() => {
        if (this.activeReconciliation === p) this.activeReconciliation = null;
      });
    }, this.config.cleanup.initialDelayMs);

    this.cleanupInterval = setInterval(async () => {
      if (this.shuttingDown) return;
      if (this.isReconciling) {
        logger.debug(
          "Skipping reconciliation interval: previous run still in progress"
        );
        return;
      }
      this.isReconciling = true;
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
        this.isReconciling = false;
      }
    }, this.config.cleanup.intervalMs);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      config: {
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

  /**
   * Expose the deployment manager so host code can drop per-agent
   * caches (e.g. grant sync cache) on config reload.
   */
  getDeploymentManager(): BaseDeploymentManager {
    return this.deploymentManager;
  }
}
