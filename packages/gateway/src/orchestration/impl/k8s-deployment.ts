import * as k8s from "@kubernetes/client-node";
import {
  createChildSpan,
  createLogger,
  ErrorCode,
  type ModelProviderModule,
  OrchestratorError,
  SpanStatusCode,
} from "@lobu/core";
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
  LOBU_FINALIZER,
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

export class K8sDeploymentManager extends BaseDeploymentManager {
  private kc: k8s.KubeConfig;
  private appsV1Api: k8s.AppsV1Api;
  private coreV1Api: k8s.CoreV1Api;
  private nodeV1Api: k8s.NodeV1Api;
  private informer: k8s.Informer<k8s.V1Deployment> | null = null;

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
      const results: DeploymentInfo[] = [];

      for (const deployment of response.body?.items || []) {
        const deploymentName = deployment.metadata?.name || "";

        // Clean up orphaned finalizers on Terminating deployments (avoids extra API call)
        if (
          deployment.metadata?.deletionTimestamp &&
          deployment.metadata?.finalizers?.includes(LOBU_FINALIZER)
        ) {
          logger.info(
            `Removing orphaned finalizer from Terminating deployment ${deploymentName}`
          );
          this.removeFinalizerFromResource("deployment", deploymentName).catch(
            (err) =>
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

  /**
   * Create a PersistentVolumeClaim for a space.
   * Multiple threads in the same space share the same PVC.
   */
  private async createPVC(
    pvcName: string,
    agentId: string,
    traceparent?: string,
    sizeOverride?: string
  ): Promise<void> {
    const pvcSize =
      sizeOverride || this.config.worker.persistence?.size || "1Gi";
    const pvc = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvcName,
        namespace: this.config.kubernetes.namespace,
        labels: {
          ...BASE_WORKER_LABELS,
          "app.kubernetes.io/component": "worker-storage",
          "lobu.io/agent-id": agentId,
        },
        finalizers: [LOBU_FINALIZER],
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: pvcSize,
          },
        },
        ...(this.config.worker.persistence?.storageClass
          ? { storageClassName: this.config.worker.persistence.storageClass }
          : {}),
      },
    };

    // Create child span for PVC setup (linked to parent via traceparent)
    const span = createChildSpan("pvc_setup", traceparent, {
      "lobu.pvc_name": pvcName,
      "lobu.agent_id": agentId,
      "lobu.pvc_size": pvcSize,
    });

    logger.info(
      { traceparent, pvcName, agentId, size: pvcSize },
      "Creating PVC"
    );

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
        span?.setAttribute("lobu.pvc_exists", true);
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
    const pvcName = `lobu-workspace-${agentId}`;

    // Check if Nix packages are configured (need init container + subPath mounts)
    const hasNixConfig =
      (messageData?.nixConfig?.packages?.length ?? 0) > 0 ||
      !!messageData?.nixConfig?.flakeUrl;

    // Use larger PVC when Nix packages are configured (Chromium etc. need space)
    const pvcSize = hasNixConfig ? "5Gi" : undefined;
    await this.createPVC(pvcName, agentId, traceparent, pvcSize);

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

    const platform = messageData?.platform || "unknown";

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
            serviceAccountName: "lobu-worker",
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
                      image: `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
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
              {
                name: "bun-cache",
                emptyDir: {
                  medium: "Memory",
                  sizeLimit: WORKER_SECURITY.BUN_CACHE_SIZE_LIMIT,
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
    await this.removeFinalizerFromResource("deployment", deploymentName);

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
   * Remove the lobu.io/cleanup finalizer from a deployment or PVC.
   * No-ops if the finalizer is already absent.
   */
  private async removeFinalizerFromResource(
    kind: "deployment" | "pvc",
    name: string
  ): Promise<void> {
    try {
      // Read current finalizers
      let currentFinalizers: string[] | undefined;
      if (kind === "deployment") {
        const resource = await this.appsV1Api.readNamespacedDeployment(
          name,
          this.config.kubernetes.namespace
        );
        currentFinalizers = (resource as any).body?.metadata?.finalizers;
      } else {
        const resource =
          await this.coreV1Api.readNamespacedPersistentVolumeClaim(
            name,
            this.config.kubernetes.namespace
          );
        currentFinalizers = (resource as any).body?.metadata?.finalizers;
      }

      if (!currentFinalizers || !currentFinalizers.includes(LOBU_FINALIZER)) {
        return; // Finalizer not present, nothing to do
      }

      const updatedFinalizers = currentFinalizers.filter(
        (f) => f !== LOBU_FINALIZER
      );
      const patch = {
        metadata: {
          finalizers: updatedFinalizers.length > 0 ? updatedFinalizers : null,
        },
      };

      if (kind === "deployment") {
        await this.appsV1Api.patchNamespacedDeployment(
          name,
          this.config.kubernetes.namespace,
          patch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            headers: {
              "Content-Type": "application/merge-patch+json",
            },
          }
        );
      } else {
        await this.coreV1Api.patchNamespacedPersistentVolumeClaim(
          name,
          this.config.kubernetes.namespace,
          patch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            headers: {
              "Content-Type": "application/merge-patch+json",
            },
          }
        );
      }

      logger.debug(`Removed finalizer from ${kind} ${name}`);
    } catch (error) {
      const k8sError = error as { statusCode?: number };
      if (k8sError.statusCode === 404) {
        // Resource already gone, nothing to do
        return;
      }
      logger.warn(
        `Failed to remove finalizer from ${kind} ${name}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - finalizer removal failure should not block deletion
    }
  }

  /**
   * Clean up PVCs stuck in Terminating state with our finalizer.
   * Deployment orphans are handled inline in reconcileDeployments to avoid
   * a duplicate list API call.
   */
  private async cleanupOrphanedPvcFinalizers(): Promise<void> {
    try {
      const pvcs = await this.coreV1Api.listNamespacedPersistentVolumeClaim(
        this.config.kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        "app.kubernetes.io/component=worker-storage"
      );

      const pvcResponse = pvcs as {
        body?: { items?: k8s.V1PersistentVolumeClaim[] };
      };

      for (const pvc of pvcResponse.body?.items || []) {
        const name = pvc.metadata?.name;
        const deletionTimestamp = pvc.metadata?.deletionTimestamp;
        const finalizers = pvc.metadata?.finalizers;

        if (name && deletionTimestamp && finalizers?.includes(LOBU_FINALIZER)) {
          logger.info(
            `Removing orphaned finalizer from Terminating PVC ${name}`
          );
          await this.removeFinalizerFromResource("pvc", name);
        }
      }
    } catch (error) {
      logger.warn(
        "Failed to clean up orphaned PVC finalizers:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Override reconcileDeployments to also clean up orphaned PVC finalizers.
   * Deployment orphan cleanup is handled inside listDeployments() to avoid
   * duplicate API calls (listDeployments already iterates raw K8s objects).
   */
  async reconcileDeployments(): Promise<void> {
    await this.cleanupOrphanedPvcFinalizers();
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
    if (this.informer) return;

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
