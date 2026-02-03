import * as k8s from "@kubernetes/client-node";
import {
  createChildSpan,
  createLogger,
  ErrorCode,
  OrchestratorError,
  SpanStatusCode,
} from "@peerbot/core";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type MessagePayload,
  type ModuleEnvVarsBuilder,
  type OrchestratorConfig,
} from "../base-deployment-manager";
import {
  BASE_WORKER_LABELS,
  buildDeploymentInfoSummary,
  getVeryOldThresholdDays,
  resolvePlatformDeploymentMetadata,
  WORKER_SECURITY,
  WORKER_SELECTOR_LABELS,
} from "../deployment-utils";

const logger = createLogger("k8s-deployment");

// K8s-specific type definitions
interface K8sProbe {
  httpGet?: {
    path: string;
    port: number | string;
    scheme?: string;
  };
  exec?: {
    command: string[];
  };
  tcpSocket?: {
    port: number | string;
  };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

interface SimpleDeployment {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
  };
  spec: {
    replicas: number;
    selector: {
      matchLabels: Record<string, string>;
    };
    template: {
      metadata: {
        labels: Record<string, string>;
        annotations?: Record<string, string>;
      };
      spec: {
        serviceAccountName?: string;
        runtimeClassName?: string;
        securityContext?: {
          fsGroup?: number;
          fsGroupChangePolicy?: "Always" | "OnRootMismatch";
          runAsUser?: number;
          runAsGroup?: number;
          runAsNonRoot?: boolean;
        };
        initContainers?: Array<{
          name: string;
          image: string;
          command?: string[];
          args?: string[];
          securityContext?: {
            runAsUser?: number;
            runAsGroup?: number;
            runAsNonRoot?: boolean;
            readOnlyRootFilesystem?: boolean;
            allowPrivilegeEscalation?: boolean;
            capabilities?: {
              drop?: string[];
              add?: string[];
            };
          };
          resources?: {
            requests?: Record<string, string>;
            limits?: Record<string, string>;
          };
          volumeMounts?: Array<{
            name: string;
            mountPath: string;
          }>;
        }>;
        containers: Array<{
          name: string;
          image: string;
          imagePullPolicy?: string;
          command?: string[];
          args?: string[];
          securityContext?: {
            runAsUser?: number;
            runAsGroup?: number;
            runAsNonRoot?: boolean;
            readOnlyRootFilesystem?: boolean;
            allowPrivilegeEscalation?: boolean;
            capabilities?: {
              drop?: string[];
              add?: string[];
            };
          };
          env?: Array<{
            name: string;
            value?: string;
            valueFrom?: {
              secretKeyRef?: {
                name: string;
                key: string;
              };
            };
          }>;
          ports?: Array<{
            name: string;
            containerPort: number;
            protocol?: string;
          }>;
          livenessProbe?: K8sProbe;
          readinessProbe?: K8sProbe;
          resources?: {
            requests?: Record<string, string>;
            limits?: Record<string, string>;
          };
          volumeMounts?: Array<{
            name: string;
            mountPath: string;
          }>;
        }>;
        volumes?: Array<{
          name: string;
          persistentVolumeClaim?: {
            claimName: string;
          };
          emptyDir?: {
            sizeLimit?: string;
            medium?: string;
          };
          hostPath?: {
            path: string;
            type?: string;
          };
        }>;
      };
    };
  };
}

export class K8sDeploymentManager extends BaseDeploymentManager {
  private appsV1Api: k8s.AppsV1Api;
  private coreV1Api: k8s.CoreV1Api;
  private nodeV1Api: k8s.NodeV1Api;

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder
  ) {
    super(config, moduleEnvVarsBuilder);

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
    this.nodeV1Api = kc.makeApiClient(k8s.NodeV1Api);

    // API clients are already configured with authentication through makeApiClient

    logger.info(
      `🔧 K8s client initialized for namespace: ${this.config.kubernetes.namespace}`
    );

    // Validate namespace exists and we have access
    this.validateNamespace();

    // Check runtime class availability on initialization (like Docker's gVisor check)
    this.checkRuntimeClassAvailability();
  }

  /**
   * Validate that the target namespace exists and we have access to it
   */
  private async validateNamespace(): Promise<void> {
    const namespace = this.config.kubernetes.namespace;

    try {
      await this.coreV1Api.readNamespace(namespace);
      logger.info(`✅ Namespace '${namespace}' validated`);
    } catch (error) {
      const k8sError = error as { statusCode?: number };

      if (k8sError.statusCode === 404) {
        logger.error(
          `❌ Namespace '${namespace}' does not exist. ` +
            `Create it with: kubectl create namespace ${namespace}`
        );
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Namespace '${namespace}' does not exist`,
          { namespace },
          true
        );
      } else if (k8sError.statusCode === 403) {
        // 403 Forbidden for namespace read is expected with namespace-scoped Roles
        // The gateway can still create resources in the namespace without cluster-level namespace read permission
        logger.info(
          `ℹ️  Namespace '${namespace}' access check skipped (namespace-scoped RBAC). ` +
            `Will validate via resource operations.`
        );
        // Don't throw - we're running in this namespace so it exists
      } else {
        logger.warn(
          `⚠️  Could not validate namespace '${namespace}': ${error instanceof Error ? error.message : String(error)}`
        );
        // Don't throw - let operations fail with more specific errors
      }
    }
  }

  /**
   * Check if the configured RuntimeClass exists in the cluster
   * Similar to Docker's checkGvisorAvailability()
   */
  private async checkRuntimeClassAvailability(): Promise<void> {
    const runtimeClassName = this.config.worker.runtimeClassName || "kata";

    try {
      await this.nodeV1Api.readRuntimeClass(runtimeClassName);
      logger.info(
        `✅ RuntimeClass '${runtimeClassName}' verified and will be used for worker isolation`
      );
    } catch (error) {
      const k8sError = error as { statusCode?: number };
      if (k8sError.statusCode === 404) {
        logger.warn(
          `⚠️  RuntimeClass '${runtimeClassName}' not found in cluster. ` +
            `Workers will use default runtime. Consider installing ${runtimeClassName} for enhanced isolation.`
        );
      } else {
        logger.warn(
          `⚠️  Failed to verify RuntimeClass '${runtimeClassName}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // Clear runtime class if not available or verification failed (workers will use default)
      this.config.worker.runtimeClassName = undefined;
    }
  }

  /**
   * Validate that the worker image exists and is pullable
   * Called on gateway startup to ensure workers can be created
   */
  async validateWorkerImage(): Promise<void> {
    const imageName = `${this.config.worker.image.repository}:${this.config.worker.image.tag}`;

    // For K8s, we can't directly validate if the image exists without creating a pod
    // Instead, we log a warning and rely on imagePullPolicy and K8s error handling
    logger.info(
      `ℹ️  Worker image configured: ${imageName} (pullPolicy: ${this.config.worker.image.pullPolicy || "Always"})`
    );

    // If pull policy is "Never", warn that image must be pre-loaded
    if (this.config.worker.image.pullPolicy === "Never") {
      logger.warn(
        `⚠️  Worker image pullPolicy is 'Never'. Ensure image ${imageName} is pre-loaded on all nodes.`
      );
    }
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    try {
      // Only list worker deployments using label selector
      const k8sDeployments = await this.appsV1Api.listNamespacedDeployment(
        this.config.kubernetes.namespace,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        undefined, // fieldSelector
        "app.kubernetes.io/component=worker" // labelSelector - only worker deployments
      );

      const now = Date.now();
      const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
      const veryOldDays = getVeryOldThresholdDays(this.config);

      const response = k8sDeployments as {
        body?: { items?: k8s.V1Deployment[] };
      };
      return (response.body?.items || []).map(
        (deployment: k8s.V1Deployment) => {
          const deploymentName = deployment.metadata?.name || "";

          // Get last activity from annotations or fallback to creation time
          const lastActivityStr =
            deployment.metadata?.annotations?.["peerbot.io/last-activity"] ||
            deployment.metadata?.annotations?.["peerbot.io/created"] ||
            deployment.metadata?.creationTimestamp;

          const lastActivity = lastActivityStr
            ? new Date(lastActivityStr)
            : new Date();
          const replicas = deployment.spec?.replicas || 0;
          return buildDeploymentInfoSummary({
            deploymentName,
            lastActivity,
            now,
            idleThresholdMinutes,
            veryOldDays,
            replicas,
          });
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

  /**
   * Create a PersistentVolumeClaim for a space.
   * Multiple threads in the same space share the same PVC.
   */
  private async createPVC(
    pvcName: string,
    agentId: string,
    traceparent?: string
  ): Promise<void> {
    const pvc = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvcName,
        namespace: this.config.kubernetes.namespace,
        labels: {
          ...BASE_WORKER_LABELS,
          "app.kubernetes.io/component": "worker-storage",
          "peerbot.io/agent-id": agentId,
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: this.config.worker.persistence?.size || "1Gi",
          },
        },
        ...(this.config.worker.persistence?.storageClass
          ? { storageClassName: this.config.worker.persistence.storageClass }
          : {}),
      },
    };

    // Create child span for PVC setup (linked to parent via traceparent)
    const span = createChildSpan("pvc_setup", traceparent, {
      "peerbot.pvc_name": pvcName,
      "peerbot.agent_id": agentId,
      "peerbot.pvc_size": this.config.worker.persistence?.size || "1Gi",
    });

    logger.info({ traceparent, pvcName, agentId, size: "1Gi" }, "Creating PVC");

    try {
      await this.coreV1Api.createNamespacedPersistentVolumeClaim(
        this.config.kubernetes.namespace,
        pvc
      );
      span?.setStatus({ code: SpanStatusCode.OK });
      span?.end();
      logger.info({ pvcName }, "Created PVC");
    } catch (error) {
      const k8sError = error as {
        statusCode?: number;
        body?: unknown;
        message?: string;
      };
      logger.error(`PVC creation error for ${pvcName}:`, {
        statusCode: k8sError.statusCode,
        message: k8sError.message,
        body: k8sError.body,
      });
      if (k8sError.statusCode === 409) {
        span?.setAttribute("peerbot.pvc_exists", true);
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.end();
        logger.info(`PVC ${pvcName} already exists (reusing)`);
      } else {
        span?.setStatus({
          code: SpanStatusCode.ERROR,
          message: k8sError.message || "PVC creation failed",
        });
        span?.end();
        throw error;
      }
    }
  }

  async createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload,
    userEnvVars: Record<string, string> = {}
  ): Promise<void> {
    // Extract traceparent for distributed tracing
    const traceparent = messageData?.platformMetadata?.traceparent as
      | string
      | undefined;

    logger.info(
      { traceparent, deploymentName, userId },
      "Creating K8s deployment"
    );

    // Use agentId for PVC naming (shared across threads in same space)
    const agentId = messageData?.agentId!;
    const pvcName = `peerbot-workspace-${agentId}`;
    await this.createPVC(pvcName, agentId, traceparent);

    // Get environment variables before creating the deployment spec
    // Include secrets (same as Docker behavior) - secrets are passed via env vars
    const envVars = await this.generateEnvironmentVariables(
      username,
      userId,
      deploymentName,
      messageData,
      true, // Include secrets to match Docker behavior
      userEnvVars
    );

    const deployment: SimpleDeployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deploymentName,
        namespace: this.config.kubernetes.namespace,
        labels: { ...BASE_WORKER_LABELS },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { ...WORKER_SELECTOR_LABELS },
        },
        template: {
          metadata: {
            annotations: {
              // Add platform-specific metadata
              ...resolvePlatformDeploymentMetadata(messageData),
              "peerbot.io/created": new Date().toISOString(),
              "peerbot.io/agent-id": agentId,
              ...(traceparent ? { "peerbot.io/traceparent": traceparent } : {}),
            },
            labels: { ...BASE_WORKER_LABELS },
          },
          spec: {
            serviceAccountName: "peerbot-worker",
            // Only set runtimeClassName if configured and available (validated on startup)
            ...(this.config.worker.runtimeClassName
              ? { runtimeClassName: this.config.worker.runtimeClassName }
              : {}),
            securityContext: {
              fsGroup: WORKER_SECURITY.GROUP_ID,
              fsGroupChangePolicy: "OnRootMismatch",
            },
            containers: [
              {
                name: "worker",
                image: `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
                imagePullPolicy:
                  this.config.worker.image.pullPolicy || "Always",
                securityContext: {
                  runAsUser: WORKER_SECURITY.USER_ID,
                  runAsGroup: WORKER_SECURITY.GROUP_ID,
                  runAsNonRoot: true,
                  // Enable read-only root filesystem for security (matches Docker behavior)
                  readOnlyRootFilesystem: true,
                  // Prevent privilege escalation
                  allowPrivilegeEscalation: false,
                  // Drop all capabilities (matches Docker CAP_DROP: ALL)
                  capabilities: {
                    drop: ["ALL"],
                  },
                },
                env: [
                  // Common environment variables from base class
                  // (includes HTTP_PROXY, HTTPS_PROXY, NO_PROXY, NODE_ENV, DEBUG)
                  ...Object.entries(envVars).map(([key, value]) => ({
                    name: key,
                    value: value,
                  })),
                  // Add traceparent for distributed tracing (passed to worker)
                  ...(traceparent
                    ? [{ name: "TRACEPARENT", value: traceparent }]
                    : []),
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
                  // Tmpfs mounts for writable directories (matches Docker behavior)
                  {
                    name: "tmp",
                    mountPath: "/tmp",
                  },
                  {
                    name: "bun-cache",
                    mountPath: "/home/bun/.cache",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "workspace",
                // Use per-deployment PVC for session persistence across scale-to-zero
                persistentVolumeClaim: {
                  claimName: pvcName,
                },
              },
              // Tmpfs volumes for temporary files (in-memory, matches Docker Tmpfs)
              {
                name: "tmp",
                emptyDir: {
                  medium: "Memory",
                  sizeLimit: WORKER_SECURITY.TMP_SIZE_LIMIT,
                },
              },
              {
                name: "bun-cache",
                emptyDir: {
                  medium: "Memory",
                  sizeLimit: WORKER_SECURITY.BUN_CACHE_SIZE_LIMIT,
                },
              },
            ],
          },
        },
      },
    };

    // Create child span for worker creation (linked to parent via traceparent)
    const workerSpan = createChildSpan("worker_creation", traceparent, {
      "peerbot.deployment_name": deploymentName,
      "peerbot.user_id": userId,
      "peerbot.agent_id": agentId,
    });

    logger.info(
      { traceparent, deploymentName },
      "Submitting deployment to K8s API"
    );

    try {
      const response = await this.appsV1Api.createNamespacedDeployment(
        this.config.kubernetes.namespace,
        deployment
      );
      const statusResponse = response as { response?: { statusCode?: number } };
      workerSpan?.setAttribute(
        "http.status_code",
        statusResponse.response?.statusCode || 0
      );
      workerSpan?.setStatus({ code: SpanStatusCode.OK });
      workerSpan?.end();
      logger.info(
        { deploymentName, status: statusResponse.response?.statusCode },
        "Deployment created successfully"
      );
    } catch (error) {
      const k8sError = error as {
        statusCode?: number;
        message?: string;
        body?: unknown;
        response?: { statusMessage?: string };
        code?: string;
      };
      // Log detailed error information
      logger.error(`❌ Failed to create deployment ${deploymentName}:`, {
        statusCode: k8sError.statusCode,
        message: k8sError.message,
        body: k8sError.body,
        response: k8sError.response?.statusMessage,
      });

      // End span with error
      workerSpan?.setStatus({
        code: SpanStatusCode.ERROR,
        message: k8sError.message || "Deployment failed",
      });
      workerSpan?.end();

      // Check for specific error conditions and throw OrchestratorError
      if (k8sError.statusCode === 409) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Deployment ${deploymentName} already exists`,
          { deploymentName, statusCode: 409 },
          false
        );
      } else if (k8sError.statusCode === 403) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Insufficient permissions to create deployment ${deploymentName}`,
          { deploymentName, statusCode: 403 },
          true
        );
      } else if (k8sError.statusCode === 422) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Invalid deployment specification for ${deploymentName}: ${JSON.stringify(k8sError.body)}`,
          { deploymentName, statusCode: 422, body: k8sError.body },
          true
        );
      } else if (
        k8sError.message?.includes("timeout") ||
        k8sError.code === "ETIMEDOUT"
      ) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Timeout creating deployment ${deploymentName} - K8s API may be overloaded`,
          { deploymentName, code: k8sError.code },
          true
        );
      } else {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `HTTP request failed: ${k8sError.message || k8sError.response?.statusMessage || "Unknown error"}`,
          { deploymentName, error },
          true
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
          {
            headers: {
              "Content-Type": "application/strategic-merge-patch+json",
            },
          }
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

  async deleteDeployment(deploymentName: string): Promise<void> {
    // Delete the deployment with propagation policy
    try {
      await this.appsV1Api.deleteNamespacedDeployment(
        deploymentName,
        this.config.kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        "Foreground" // Wait for pods to terminate before returning
      );
      logger.info(`✅ Deleted deployment: ${deploymentName}`);
    } catch (error) {
      const k8sError = error as { statusCode?: number };
      if (k8sError.statusCode === 404) {
        logger.info(
          `⚠️  Deployment ${deploymentName} not found (already deleted)`
        );
      } else {
        throw error;
      }
    }

    // NOTE: Space PVCs are NOT deleted on deployment deletion
    // They are shared across threads in the same space and persist
    // for future conversations. Cleanup is done manually or via separate process.
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
        {
          headers: { "Content-Type": "application/strategic-merge-patch+json" },
        }
      );
    } catch (error) {
      logger.error(
        `❌ Failed to update activity for deployment ${deploymentName}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - activity tracking should not block message processing
    }
  }

  protected getDispatcherHost(): string {
    const dispatcherService =
      process.env.DISPATCHER_SERVICE_NAME || "peerbot-dispatcher";
    return `${dispatcherService}.${this.config.kubernetes.namespace}.svc.cluster.local`;
  }
}
