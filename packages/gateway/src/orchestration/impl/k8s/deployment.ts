import * as k8s from "@kubernetes/client-node";
import {
  createChildSpan,
  createLogger,
  ErrorCode,
  OrchestratorError,
  SpanStatusCode,
} from "@lobu/core";
import type { ModelProviderModule } from "../../../modules/module-system";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type MessagePayload,
  type ModuleEnvVarsBuilder,
  type OrchestratorConfig,
} from "../../base-deployment-manager";
import {
  BASE_WORKER_LABELS,
  buildDeploymentInfoSummary,
  getVeryOldThresholdDays,
  resolvePlatformDeploymentMetadata,
} from "../../deployment-utils";
import {
  cleanupOrphanedPvcFinalizers,
  createPVC,
  reconcileWorkerDeploymentImages,
  removeFinalizerFromResource,
  runImagePullPreflight,
  waitForWorkerReady,
} from "./helpers";

export const LOBU_FINALIZER = "lobu.io/cleanup";

export const WORKER_SECURITY = {
  USER_ID: 1001,
  GROUP_ID: 1001,
  TMP_SIZE_LIMIT: "100Mi",
} as const;

const WORKER_SELECTOR_LABELS = {
  "app.kubernetes.io/name": BASE_WORKER_LABELS["app.kubernetes.io/name"],
  "app.kubernetes.io/component":
    BASE_WORKER_LABELS["app.kubernetes.io/component"],
} as const;

export interface K8sProbe {
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

export interface SimpleDeployment {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    finalizers?: string[];
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
        imagePullSecrets?: Array<{ name: string }>;
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
          resources?: {
            requests?: Record<string, string>;
            limits?: Record<string, string>;
          };
          volumeMounts?: Array<{
            name: string;
            mountPath: string;
            subPath?: string;
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
            subPath?: string;
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

export const IMAGE_PULL_FAILURE_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "RegistryUnavailable",
]);

const logger = createLogger("k8s-deployment");

export class K8sDeploymentManager extends BaseDeploymentManager {
  private kc: k8s.KubeConfig;
  private appsV1Api: k8s.AppsV1Api;
  private coreV1Api: k8s.CoreV1Api;
  private nodeV1Api: k8s.NodeV1Api;
  private informer: k8s.Informer<k8s.V1Deployment> | null = null;
  private informerInitializing = false;

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    super(config, moduleEnvVarsBuilder, providerModules);

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

    // Store KubeConfig for informer creation
    this.kc = kc;

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

  private getWorkerServiceAccountName(): string {
    return this.config.worker.serviceAccountName || "lobu-worker";
  }

  private getWorkerImagePullSecrets(): Array<{ name: string }> | undefined {
    const configured = this.config.worker.imagePullSecrets || [];
    const names = configured.map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return undefined;
    return names.map((name) => ({ name }));
  }

  private getWorkerStartupTimeoutMs(): number {
    const timeoutSeconds = this.config.worker.startupTimeoutSeconds ?? 90;
    return Math.max(timeoutSeconds, 5) * 1000;
  }

  private async listRawWorkerDeployments(): Promise<k8s.V1Deployment[]> {
    const k8sDeployments = await this.appsV1Api.listNamespacedDeployment(
      this.config.kubernetes.namespace,
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // _continue
      undefined, // fieldSelector
      "app.kubernetes.io/component=worker" // labelSelector - only worker deployments
    );

    const response = k8sDeployments as {
      body?: { items?: k8s.V1Deployment[] };
    };

    return response.body?.items || [];
  }

  /**
   * Validate that the worker image exists and is pullable
   * Called on gateway startup to ensure workers can be created
   */
  async validateWorkerImage(): Promise<void> {
    const imageName = this.getWorkerImageReference();
    logger.info(
      `ℹ️  Worker image configured: ${imageName} (pullPolicy: ${this.config.worker.image.pullPolicy || "Always"})`
    );

    if (this.config.worker.image.pullPolicy === "Never") {
      logger.warn(
        `⚠️  Worker image pullPolicy is 'Never'. Ensure image ${imageName} is pre-loaded on all nodes.`
      );
      return;
    }

    await runImagePullPreflight(
      this.coreV1Api,
      this.config.kubernetes.namespace,
      imageName,
      this.config.worker.image.pullPolicy || "Always",
      this.getWorkerServiceAccountName(),
      this.getWorkerImagePullSecrets()
    );
  }

  async reconcileWorkerDeploymentImages(): Promise<void> {
    await reconcileWorkerDeploymentImages(
      this.appsV1Api,
      this.config.kubernetes.namespace,
      this.getWorkerImageReference(),
      this.config.worker.image.pullPolicy || "Always",
      this.getWorkerServiceAccountName(),
      this.getWorkerImagePullSecrets(),
      () => this.listRawWorkerDeployments()
    );
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    try {
      const now = Date.now();
      const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
      const veryOldDays = getVeryOldThresholdDays(this.config);
      const results: DeploymentInfo[] = [];

      for (const deployment of await this.listRawWorkerDeployments()) {
        const deploymentName = deployment.metadata?.name || "";

        // Clean up orphaned finalizers on Terminating deployments (avoids extra API call)
        if (
          deployment.metadata?.deletionTimestamp &&
          deployment.metadata?.finalizers?.includes(LOBU_FINALIZER)
        ) {
          logger.info(
            `Removing orphaned finalizer from Terminating deployment ${deploymentName}`
          );
          removeFinalizerFromResource(
            this.appsV1Api,
            this.coreV1Api,
            this.config.kubernetes.namespace,
            "deployment",
            deploymentName
          ).catch((err) =>
            logger.warn(
              `Failed to remove orphaned finalizer from ${deploymentName}:`,
              err instanceof Error ? err.message : String(err)
            )
          );
          continue; // Skip Terminating deployments from the active list
        }

        // Get last activity from annotations or fallback to creation time
        const lastActivityStr =
          deployment.metadata?.annotations?.["lobu.io/last-activity"] ||
          deployment.metadata?.annotations?.["lobu.io/created"] ||
          deployment.metadata?.creationTimestamp;

        const lastActivity = lastActivityStr
          ? new Date(lastActivityStr)
          : new Date();
        const replicas = deployment.spec?.replicas || 0;
        results.push(
          buildDeploymentInfoSummary({
            deploymentName,
            lastActivity,
            now,
            idleThresholdMinutes,
            veryOldDays,
            replicas,
          })
        );
      }

      return results;
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to list deployments: ${error instanceof Error ? error.message : String(error)}`,
        { error },
        true
      );
    }
  }

  async createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
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
    const agentId = messageData?.agentId;
    if (!agentId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Missing agentId in message payload"
      );
    }
    const pvcName = `lobu-workspace-${agentId}`;

    // Check if Nix packages are configured (need init container + subPath mounts)
    const hasNixConfig =
      (messageData?.nixConfig?.packages?.length ?? 0) > 0 ||
      !!messageData?.nixConfig?.flakeUrl;

    // Use larger PVC when Nix packages are configured (Chromium etc. need space)
    const pvcSize = hasNixConfig ? "5Gi" : undefined;
    await createPVC(
      this.coreV1Api,
      this.config.kubernetes.namespace,
      pvcName,
      agentId,
      this.config.worker.persistence?.storageClass,
      traceparent,
      pvcSize,
      this.config.worker.persistence?.size
    );

    // Get environment variables before creating the deployment spec
    // Include secrets (same as Docker behavior) - secrets are passed via env vars
    const envVars = await this.generateEnvironmentVariables(
      username,
      userId,
      deploymentName,
      messageData,
      true // Include secrets to match Docker behavior
    );

    const platform = messageData?.platform || "unknown";
    const workerImage = this.getWorkerImageReference();

    const deployment: SimpleDeployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deploymentName,
        namespace: this.config.kubernetes.namespace,
        labels: {
          ...BASE_WORKER_LABELS,
          "lobu.io/platform": platform,
          "lobu.io/agent-id": agentId,
        },
        annotations: {
          "lobu.io/status": "running",
          "lobu.io/created": new Date().toISOString(),
        },
        finalizers: [LOBU_FINALIZER],
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
              "lobu.io/created": new Date().toISOString(),
              "lobu.io/agent-id": agentId,
              ...(traceparent ? { "lobu.io/traceparent": traceparent } : {}),
            },
            labels: {
              ...BASE_WORKER_LABELS,
              "lobu.io/platform": platform,
            },
          },
          spec: {
            serviceAccountName: this.getWorkerServiceAccountName(),
            imagePullSecrets: this.getWorkerImagePullSecrets(),
            // Only set runtimeClassName if configured and available (validated on startup)
            ...(this.config.worker.runtimeClassName
              ? { runtimeClassName: this.config.worker.runtimeClassName }
              : {}),
            securityContext: {
              fsGroup: WORKER_SECURITY.GROUP_ID,
              fsGroupChangePolicy: "OnRootMismatch",
            },
            // Init container to bootstrap Nix store from image to PVC (first time only)
            ...(hasNixConfig
              ? {
                  initContainers: [
                    {
                      name: "nix-bootstrap",
                      image: workerImage,
                      imagePullPolicy:
                        this.config.worker.image.pullPolicy || "Always",
                      command: [
                        "bash",
                        "-c",
                        "if [ ! -f /workspace/.nix-bootstrapped ]; then " +
                          'echo "Bootstrapping Nix store to PVC..." && ' +
                          "cp -a /nix/store /workspace/.nix-store && " +
                          "cp -a /nix/var /workspace/.nix-var && " +
                          "mkdir -p /workspace/.nix-store/.nix-pvc-mounted && " +
                          "touch /workspace/.nix-bootstrapped && " +
                          'echo "Nix bootstrap complete"; ' +
                          'else echo "Nix store already bootstrapped"; fi',
                      ],
                      securityContext: {
                        runAsUser: WORKER_SECURITY.USER_ID,
                        runAsGroup: WORKER_SECURITY.GROUP_ID,
                      },
                      volumeMounts: [
                        {
                          name: "workspace",
                          mountPath: "/workspace",
                        },
                      ],
                    },
                  ],
                }
              : {}),
            containers: [
              {
                name: "worker",
                image: workerImage,
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
                  // /dev/shm for shared memory (needed by Chromium and other apps)
                  {
                    name: "dshm",
                    mountPath: "/dev/shm",
                  },
                  // When Nix packages configured, mount PVC subpaths at /nix/store and /nix/var
                  ...(hasNixConfig
                    ? [
                        {
                          name: "workspace",
                          mountPath: "/nix/store",
                          subPath: ".nix-store",
                        },
                        {
                          name: "workspace",
                          mountPath: "/nix/var",
                          subPath: ".nix-var",
                        },
                      ]
                    : []),
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
              // Shared memory for Chromium and other apps requiring /dev/shm
              {
                name: "dshm",
                emptyDir: {
                  medium: "Memory",
                  sizeLimit: "256Mi",
                },
              },
            ],
          },
        },
      },
    };

    // Create child span for worker creation (linked to parent via traceparent)
    const workerSpan = createChildSpan("worker_creation", traceparent, {
      "lobu.deployment_name": deploymentName,
      "lobu.user_id": userId,
      "lobu.agent_id": agentId,
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
      await waitForWorkerReady(
        this.appsV1Api,
        this.coreV1Api,
        this.config.kubernetes.namespace,
        deploymentName,
        this.getWorkerStartupTimeoutMs()
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
        "Deployment created and worker became ready"
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

      // Clean up the PVC that was created before the deployment failed
      try {
        await this.coreV1Api.deleteNamespacedPersistentVolumeClaim(
          pvcName,
          this.config.kubernetes.namespace
        );
        logger.info(
          `Cleaned up orphaned PVC ${pvcName} after deployment creation failure`
        );
      } catch (pvcCleanupError) {
        const pvcError = pvcCleanupError as { statusCode?: number };
        if (pvcError.statusCode === 404) {
          logger.debug(`PVC ${pvcName} already deleted, skipping cleanup`);
        } else {
          logger.error(
            `Failed to clean up orphaned PVC ${pvcName}:`,
            pvcCleanupError instanceof Error
              ? pvcCleanupError.message
              : String(pvcCleanupError)
          );
        }
      }

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
        const patch = {
          metadata: {
            annotations: {
              "lobu.io/status": replicas > 0 ? "running" : "scaled-down",
            },
          },
          spec: {
            replicas: replicas,
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
            headers: {
              "Content-Type": "application/strategic-merge-patch+json",
            },
          }
        );
      }

      if (replicas > 0) {
        await waitForWorkerReady(
          this.appsV1Api,
          this.coreV1Api,
          this.config.kubernetes.namespace,
          deploymentName,
          this.getWorkerStartupTimeoutMs()
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
    // Remove our finalizer before deleting so the resource can be garbage-collected
    await removeFinalizerFromResource(
      this.appsV1Api,
      this.coreV1Api,
      this.config.kubernetes.namespace,
      "deployment",
      deploymentName
    );

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

  /**
   * Override reconcileDeployments to also clean up orphaned PVC finalizers.
   * Deployment orphan cleanup is handled inside listDeployments() to avoid
   * duplicate API calls (listDeployments already iterates raw K8s objects).
   */
  async reconcileDeployments(): Promise<void> {
    await this.reconcileWorkerDeploymentImages();
    await cleanupOrphanedPvcFinalizers(
      this.appsV1Api,
      this.coreV1Api,
      this.config.kubernetes.namespace
    );
    await super.reconcileDeployments();
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const patch = {
        metadata: {
          annotations: {
            "lobu.io/last-activity": timestamp,
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
      process.env.DISPATCHER_SERVICE_NAME || "lobu-dispatcher";
    return `${dispatcherService}.${this.config.kubernetes.namespace}.svc.cluster.local`;
  }

  /**
   * Start a watch-based informer for worker deployments.
   * The informer maintains a local cache that is updated via K8s watch events,
   * reducing the need for frequent list API calls.
   */
  async startInformer(): Promise<void> {
    if (this.informer || this.informerInitializing) return;

    this.informerInitializing = true;

    const namespace = this.config.kubernetes.namespace;
    const listFn = () =>
      this.appsV1Api.listNamespacedDeployment(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        "app.kubernetes.io/component=worker"
      );

    try {
      this.informer = k8s.makeInformer(
        this.kc,
        `/apis/apps/v1/namespaces/${namespace}/deployments`,
        listFn,
        "app.kubernetes.io/component=worker"
      );

      this.informer.on("error", (err: unknown) => {
        logger.warn(
          "Informer error, will auto-restart:",
          err instanceof Error ? err.message : String(err)
        );
      });

      await this.informer.start();
      logger.info("K8s deployment informer started");
    } catch (error) {
      logger.warn(
        "Failed to start informer, falling back to polling:",
        error instanceof Error ? error.message : String(error)
      );
      this.informer = null;
    } finally {
      this.informerInitializing = false;
    }
  }

  /**
   * Stop the informer and clear the cache.
   */
  async stopInformer(): Promise<void> {
    if (this.informer) {
      this.informer.stop();
      this.informer = null;
      logger.info("K8s deployment informer stopped");
    }
  }

  /**
   * Whether the informer is active and has a populated cache.
   */
  isInformerActive(): boolean {
    return this.informer !== null;
  }
}
