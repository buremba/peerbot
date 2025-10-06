import * as k8s from "@kubernetes/client-node";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
} from "../base/BaseDeploymentManager";
import type { DatabaseAdapter } from "@peerbot/shared";
import {
  ErrorCode,
  type OrchestratorConfig,
  OrchestratorError,
  type SimpleDeployment,
} from "../types";
import { K8sSecretManager } from "./K8sSecretManager";
import { createLogger } from "@peerbot/shared";

const logger = createLogger("k8s-deployment");

export class K8sDeploymentManager extends BaseDeploymentManager {
  private appsV1Api: k8s.AppsV1Api;
  private coreV1Api: k8s.CoreV1Api;

  constructor(config: OrchestratorConfig, database: DatabaseAdapter) {
    const secretManager = new K8sSecretManager(config);
    super(config, database, secretManager);

    const kc = new k8s.KubeConfig();
    try {
      // Try in-cluster config first, then fall back to default
      if (process.env.KUBERNETES_SERVICE_HOST) {
        try {
          kc.loadFromCluster();
        } catch (_clusterError) {
          kc.loadFromDefault();
        }
      } else {
        kc.loadFromDefault();
      }

      // For development environments, disable TLS verification to avoid certificate issues
      if (
        process.env.NODE_ENV === "development" ||
        process.env.KUBERNETES_SERVICE_HOST?.includes("127.0.0.1") ||
        process.env.KUBERNETES_SERVICE_HOST?.includes("192.168") ||
        process.env.KUBERNETES_SERVICE_HOST?.includes("localhost")
      ) {
        const cluster = kc.getCurrentCluster();
        if (
          cluster &&
          typeof cluster === "object" &&
          cluster.skipTLSVerify !== true
        ) {
          // Safely set skipTLSVerify property with type checking
          Object.defineProperty(cluster, "skipTLSVerify", {
            value: true,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    } catch (error) {
      logger.error("❌ Failed to load Kubernetes config:", error);
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to initialize Kubernetes client: ${error instanceof Error ? error.message : String(error)}`,
        { error },
        true
      );
    }

    // Configure K8s API clients
    this.appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
    this.coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

    // API clients are already configured with authentication through makeApiClient

    logger.info(
      `🔧 K8s client initialized with 30s timeout for namespace: ${this.config.kubernetes.namespace}`
    );

    // Pass the K8s API to the secret manager
    (this.secretManager as K8sSecretManager).setCoreV1Api(this.coreV1Api);
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    try {
      const k8sDeployments = await this.appsV1Api.listNamespacedDeployment(
        this.config.kubernetes.namespace
      );

      const now = Date.now();
      const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;

      return ((k8sDeployments as any).body?.items || []).map(
        (deployment: any) => {
          const deploymentName = deployment.metadata?.name || "";
          const deploymentId = deploymentName.replace("peerbot-worker-", "");

          // Get last activity from annotations or fallback to creation time
          const lastActivityStr =
            deployment.metadata?.annotations?.["peerbot.io/last-activity"] ||
            deployment.metadata?.annotations?.["peerbot.io/created"] ||
            deployment.metadata?.creationTimestamp;

          const lastActivity = lastActivityStr
            ? new Date(lastActivityStr)
            : new Date();
          const minutesIdle = (now - lastActivity.getTime()) / (1000 * 60);
          const daysSinceActivity = minutesIdle / (60 * 24);
          const replicas = deployment.spec?.replicas || 0;

          return {
            deploymentName,
            deploymentId,
            lastActivity,
            minutesIdle,
            daysSinceActivity,
            replicas,
            isIdle: minutesIdle >= idleThresholdMinutes,
            isVeryOld: daysSinceActivity >= 7,
          };
        }
      );
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to list deployments: ${error instanceof Error ? error.message : String(error)}`,
        { error },
        true
      );
    }
  }

  private async ensurePersistentVolume(
    deploymentName: string,
    userId: string
  ): Promise<void> {
    const threadId = deploymentName
      .replace("peerbot-worker-", "")
      .replace(/[^a-zA-Z0-9]/g, "-")
      .toLowerCase();
    const pvcName = `peerbot-thread-workspace-${threadId}`;

    try {
      // Check if PVC already exists
      await this.coreV1Api.readNamespacedPersistentVolumeClaim(
        pvcName,
        this.config.kubernetes.namespace
      );
      logger.info(`📁 PVC ${pvcName} already exists`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        logger.info(`📁 Creating new PVC: ${pvcName}`);
        // PVC doesn't exist, create it
        const pvc = {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: pvcName,
            namespace: this.config.kubernetes.namespace,
            labels: {
              "app.kubernetes.io/name": "peerbot",
              "app.kubernetes.io/component": "thread-workspace",
              "peerbot.io/user-id": userId,
              "peerbot.io/thread-id": threadId,
            },
          },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: {
                storage: "1Gi",
              },
            },
          },
        };

        try {
          await this.coreV1Api.createNamespacedPersistentVolumeClaim(
            this.config.kubernetes.namespace,
            pvc
          );
          logger.info(`✅ PVC ${pvcName} created successfully`);
        } catch (pvcError: any) {
          logger.error(`❌ Failed to create PVC ${pvcName}:`, {
            statusCode: pvcError.statusCode,
            message: pvcError.message,
            body: pvcError.body,
          });

          // Extract meaningful error message
          let errorMessage = pvcError.message || "Unknown error";
          if (pvcError.body?.message) {
            errorMessage = pvcError.body.message;
            // Check for quota exceeded
            if (errorMessage.includes("exceeded quota")) {
              errorMessage = `PVC quota exceeded: ${errorMessage}. Please clean up unused PVCs.`;
            }
          }
          throw new Error(`Failed to create PVC: ${errorMessage}`);
        }
      } else {
        logger.error(`❌ Failed to check PVC ${pvcName}:`, {
          statusCode: error.statusCode,
          message: error.message,
        });
        throw new Error(
          `Failed to check PVC: ${error.message || "Unknown error"}`
        );
      }
    }
  }

  async createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: any,
    userEnvVars: Record<string, string> = {}
  ): Promise<void> {
    logger.info(
      `🚀 Creating K8s deployment: ${deploymentName} for user ${userId}`
    );

    try {
      // Create per-thread PVC for workspace persistence
      await this.ensurePersistentVolume(deploymentName, userId);
    } catch (error: any) {
      logger.error(
        `Failed during PVC setup for ${deploymentName}:`,
        error.message
      );
      throw error;
    }

    // Get environment variables before creating the deployment spec
    const envVars = await this.generateEnvironmentVariables(
      username,
      userId,
      deploymentName,
      messageData,
      false,
      userEnvVars
    );

    const deployment: SimpleDeployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deploymentName,
        namespace: this.config.kubernetes.namespace,
        labels: {
          "app.kubernetes.io/name": "peerbot",
          "app.kubernetes.io/component": "worker",
          "peerbot/managed-by": "orchestrator",
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": "peerbot",
            "app.kubernetes.io/component": "worker",
          },
        },
        template: {
          metadata: {
            annotations: {
              // Add Slack thread link for visibility
              ...(messageData?.channelId && messageData?.threadId
                ? {
                    thread_url: `https://app.slack.com/client/${messageData?.platformMetadata?.teamId || "unknown"}/${messageData.channelId}/thread/${messageData.threadId}`,
                  }
                : {}),
              // Add Slack user profile link
              ...(messageData?.platformUserId &&
              messageData?.platformMetadata?.teamId
                ? {
                    user_url: `https://app.slack.com/team/${messageData.platformMetadata.teamId}/${messageData.platformUserId}`,
                  }
                : {}),
              "peerbot.io/created": new Date().toISOString(),
            },
            labels: {
              "app.kubernetes.io/name": "peerbot",
              "app.kubernetes.io/component": "worker",
            },
          },
          spec: {
            serviceAccountName: "peerbot-worker",
            runtimeClassName: this.config.worker.runtimeClassName || "kata",
            securityContext: {
              fsGroup: 1001,
              fsGroupChangePolicy: "OnRootMismatch",
            },
            containers: [
              {
                name: "worker",
                image: `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
                imagePullPolicy:
                  this.config.worker.image.pullPolicy || "Always",
                // Override the entrypoint to set ANTHROPIC_API_KEY before running the worker
                command: ["/bin/bash", "-c"],
                args: [
                  `export ANTHROPIC_API_KEY="$PEERBOT_DATABASE_USERNAME:$PEERBOT_DATABASE_PASSWORD" && exec /app/entrypoint.sh`,
                ],
                securityContext: {
                  runAsUser: 1001,
                  runAsGroup: 1001,
                  runAsNonRoot: true,
                  readOnlyRootFilesystem: false,
                },
                env: [
                  // Get the database username for constructing ANTHROPIC_API_KEY
                  {
                    name: "PEERBOT_DATABASE_USERNAME",
                    valueFrom: {
                      secretKeyRef: {
                        name: `peerbot-user-secret-${username.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`,
                        key: "PEERBOT_DATABASE_USERNAME",
                      },
                    },
                  },
                  // Get the database password for constructing ANTHROPIC_API_KEY
                  {
                    name: "PEERBOT_DATABASE_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: `peerbot-user-secret-${username.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`,
                        key: "PEERBOT_DATABASE_PASSWORD",
                      },
                    },
                  },
                  // Common environment variables from base class (excluding secrets)
                  ...Object.entries(envVars).map(([key, value]) => ({
                    name: key,
                    value: value,
                  })),
                  // Pass NODE_ENV to worker pods
                  {
                    name: "NODE_ENV",
                    value: process.env.NODE_ENV || "production",
                  },
                  // Module-specific environment variables are added through base class
                ],
                resources: {
                  requests: this.config.worker.resources.requests,
                  limits: this.config.worker.resources.limits,
                },
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "workspace",
                // Use ephemeral storage instead of PVC to avoid quota and multi-attach issues
                emptyDir: {
                  sizeLimit: "2Gi",
                },
              },
            ],
          },
        },
      },
    };

    try {
      logger.info(`📦 Submitting deployment ${deploymentName} to K8s API...`);
      const response = await this.appsV1Api.createNamespacedDeployment(
        this.config.kubernetes.namespace,
        deployment
      );
      logger.info(
        `✅ Deployment ${deploymentName} created successfully with status: ${(response as any).response?.statusCode || "unknown"}`
      );
    } catch (error: any) {
      // Log detailed error information
      logger.error(`❌ Failed to create deployment ${deploymentName}:`, {
        statusCode: error.statusCode,
        message: error.message,
        body: error.body,
        response: error.response?.statusMessage,
      });

      // Check for specific error conditions
      if (error.statusCode === 409) {
        throw new Error(`Deployment ${deploymentName} already exists`);
      } else if (error.statusCode === 403) {
        throw new Error(
          `Insufficient permissions to create deployment ${deploymentName}`
        );
      } else if (error.statusCode === 422) {
        throw new Error(
          `Invalid deployment specification for ${deploymentName}: ${JSON.stringify(error.body)}`
        );
      } else if (
        error.message?.includes("timeout") ||
        error.code === "ETIMEDOUT"
      ) {
        throw new Error(
          `Timeout creating deployment ${deploymentName} - K8s API may be overloaded`
        );
      } else {
        throw new Error(
          `HTTP request failed: ${error.message || error.statusMessage || "Unknown error"}`
        );
      }
    }
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    try {
      const deployment = await this.appsV1Api.readNamespacedDeployment(
        deploymentName,
        this.config.kubernetes.namespace
      );

      if ((deployment as any).body?.spec?.replicas !== replicas) {
        // Use a proper JSON patch for scaling
        const patch = [
          {
            op: "replace",
            path: "/spec/replicas",
            value: replicas,
          },
        ];

        await this.appsV1Api.patchNamespacedDeployment(
          deploymentName,
          this.config.kubernetes.namespace,
          patch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/json-patch+json" } }
        );
      }
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_SCALE_FAILED,
        `Failed to scale deployment ${deploymentName}: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, replicas, error },
        true
      );
    }
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    const deploymentName = `peerbot-worker-${deploymentId}`;

    // Delete the deployment
    try {
      await this.appsV1Api.deleteNamespacedDeployment(
        deploymentName,
        this.config.kubernetes.namespace
      );
      logger.info(`✅ Deleted deployment: ${deploymentName}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        logger.info(
          `⚠️  Deployment ${deploymentName} not found (already deleted)`
        );
      } else {
        throw error;
      }
    }

    // Delete associated PVC if it exists (Note: We should NOT delete user PVCs automatically
    // as they contain user data across multiple threads - they should only be deleted manually)
    // const pvcName = `peerbot-user-workspace-${deploymentId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
    logger.info(
      `ℹ️  User PVC preserved for future threads (not auto-deleted): peerbot-user-workspace-${deploymentId.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`
    );

    // Delete associated secret if it exists
    try {
      const secretName = `peerbot-user-secret-${deploymentId.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`;
      await this.coreV1Api.deleteNamespacedSecret(
        secretName,
        this.config.kubernetes.namespace
      );
      logger.info(`✅ Deleted secret: ${secretName}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        logger.info(
          `⚠️  Secret for ${deploymentName} not found (already deleted)`
        );
      } else {
        logger.info(
          `⚠️  Failed to delete secret for ${deploymentName}:`,
          error.message
        );
      }
    }
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const patch = {
        metadata: {
          annotations: {
            "peerbot.io/last-activity": timestamp,
          },
        },
      };

      await this.appsV1Api.patchNamespacedDeployment(
        deploymentName,
        this.config.kubernetes.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { "Content-Type": "application/json-patch+json" } }
      );
    } catch (error) {
      logger.error(
        `❌ Failed to update activity for deployment ${deploymentName}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - activity tracking should not block message processing
    }
  }
}
