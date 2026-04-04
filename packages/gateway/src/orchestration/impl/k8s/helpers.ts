import type * as k8s from "@kubernetes/client-node";
import {
  createChildSpan,
  createLogger,
  ErrorCode,
  OrchestratorError,
  SpanStatusCode,
} from "@lobu/core";
import { BASE_WORKER_LABELS } from "../../deployment-utils";
import {
  IMAGE_PULL_FAILURE_REASONS,
  LOBU_FINALIZER,
  WORKER_SECURITY,
} from "./deployment";

const logger = createLogger("k8s-deployment");

/**
 * Run a short-lived preflight pod to verify the worker image can be pulled.
 */
export async function runImagePullPreflight(
  coreV1Api: k8s.CoreV1Api,
  namespace: string,
  imageName: string,
  pullPolicy: string,
  serviceAccountName: string,
  imagePullSecrets: Array<{ name: string }> | undefined
): Promise<void> {
  const podName = `lobu-worker-image-preflight-${Date.now().toString(36)}`;
  const timeoutMs = 45_000;
  const startMs = Date.now();

  const pod: k8s.V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
      labels: {
        "app.kubernetes.io/name": "lobu",
        "app.kubernetes.io/component": "worker-image-preflight",
        "lobu/managed-by": "orchestrator",
      },
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName,
      imagePullSecrets,
      containers: [
        {
          name: "preflight",
          image: imageName,
          imagePullPolicy: pullPolicy,
          command: ["/bin/sh", "-lc", "echo preflight"],
          securityContext: {
            runAsUser: WORKER_SECURITY.USER_ID,
            runAsGroup: WORKER_SECURITY.GROUP_ID,
            runAsNonRoot: true,
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };

  try {
    await coreV1Api.createNamespacedPod(namespace, pod);

    while (Date.now() - startMs < timeoutMs) {
      const podResp = await coreV1Api.readNamespacedPod(podName, namespace);
      const podBody = (podResp as { body?: k8s.V1Pod }).body;
      const status = podBody?.status;
      const containerStatus = status?.containerStatuses?.find(
        (c) => c.name === "preflight"
      );
      const waiting = containerStatus?.state?.waiting;

      if (waiting?.reason && IMAGE_PULL_FAILURE_REASONS.has(waiting.reason)) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Worker image preflight failed (${waiting.reason}): ${waiting.message || "image pull failed"}`,
          { imageName, waitingReason: waiting.reason },
          true
        );
      }

      if (
        containerStatus?.state?.running ||
        containerStatus?.state?.terminated
      ) {
        logger.info(`✅ Worker image preflight passed: ${imageName}`);
        return;
      }

      if (status?.phase === "Running" || status?.phase === "Succeeded") {
        logger.info(`✅ Worker image preflight passed: ${imageName}`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new OrchestratorError(
      ErrorCode.DEPLOYMENT_CREATE_FAILED,
      `Timed out validating worker image pullability: ${imageName}`,
      { imageName, timeoutMs },
      true
    );
  } catch (error) {
    const k8sError = error as { statusCode?: number; message?: string };
    if (k8sError.statusCode === 403) {
      logger.warn(
        `⚠️  Skipping worker image preflight due to RBAC restrictions (cannot create pods): ${k8sError.message || "forbidden"}`
      );
      return;
    }
    throw error;
  } finally {
    try {
      await coreV1Api.deleteNamespacedPod(
        podName,
        namespace,
        undefined,
        undefined,
        0
      );
    } catch (error) {
      const k8sError = error as { statusCode?: number };
      if (k8sError.statusCode !== 404) {
        logger.warn(
          `Failed to delete preflight pod ${podName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

/**
 * Reconcile all existing worker deployments to match the desired image,
 * pull policy, service account, and image pull secrets.
 */
export async function reconcileWorkerDeploymentImages(
  appsV1Api: k8s.AppsV1Api,
  namespace: string,
  desiredImage: string,
  desiredPullPolicy: string,
  desiredServiceAccount: string,
  desiredImagePullSecrets: Array<{ name: string }> | undefined,
  listRawWorkerDeployments: () => Promise<k8s.V1Deployment[]>
): Promise<void> {
  try {
    const deployments = await listRawWorkerDeployments();
    let patchedCount = 0;

    for (const deployment of deployments) {
      const deploymentName = deployment.metadata?.name;
      if (!deploymentName) continue;

      const templateSpec = deployment.spec?.template.spec;
      const workerContainer = templateSpec?.containers?.find(
        (container) => container.name === "worker"
      );
      if (!workerContainer) continue;

      const initContainer = templateSpec?.initContainers?.find(
        (container) => container.name === "nix-bootstrap"
      );
      const currentSecrets = (templateSpec?.imagePullSecrets || [])
        .map((secret) => secret.name || "")
        .filter(Boolean)
        .sort();
      const desiredSecrets = (desiredImagePullSecrets || [])
        .map((secret) => secret.name)
        .sort();
      const secretsMatch =
        currentSecrets.length === desiredSecrets.length &&
        currentSecrets.every(
          (secret, index) => secret === desiredSecrets[index]
        );

      const needsPatch =
        workerContainer.image !== desiredImage ||
        workerContainer.imagePullPolicy !== desiredPullPolicy ||
        (initContainer ? initContainer.image !== desiredImage : false) ||
        templateSpec?.serviceAccountName !== desiredServiceAccount ||
        !secretsMatch;

      if (!needsPatch) continue;

      const patch: Record<string, unknown> = {
        spec: {
          template: {
            spec: {
              serviceAccountName: desiredServiceAccount,
              imagePullSecrets: desiredImagePullSecrets || null,
              containers: [
                {
                  name: "worker",
                  image: desiredImage,
                  imagePullPolicy: desiredPullPolicy,
                },
              ],
            },
          },
        },
      };

      if (initContainer) {
        (
          patch.spec as {
            template: { spec: Record<string, unknown> };
          }
        ).template.spec.initContainers = [
          {
            name: "nix-bootstrap",
            image: desiredImage,
            imagePullPolicy: desiredPullPolicy,
          },
        ];
      }

      await appsV1Api.patchNamespacedDeployment(
        deploymentName,
        namespace,
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

      patchedCount += 1;
      logger.info(
        `🔁 Reconciled worker deployment image for ${deploymentName} -> ${desiredImage}`
      );
    }

    if (patchedCount > 0) {
      logger.info(
        `✅ Reconciled ${patchedCount} worker deployment(s) to image ${desiredImage}`
      );
    }
  } catch (error) {
    logger.warn(
      `Failed to reconcile worker deployment images: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Create a PersistentVolumeClaim for a space.
 * Multiple threads in the same space share the same PVC.
 */
export async function createPVC(
  coreV1Api: k8s.CoreV1Api,
  namespace: string,
  pvcName: string,
  agentId: string,
  storageClass: string | undefined,
  traceparent?: string,
  sizeOverride?: string,
  defaultSize?: string
): Promise<void> {
  const pvcSize = sizeOverride || defaultSize || "1Gi";
  const pvc = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: pvcName,
      namespace,
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
      ...(storageClass ? { storageClassName: storageClass } : {}),
    },
  };

  // Create child span for PVC setup (linked to parent via traceparent)
  const span = createChildSpan("pvc_setup", traceparent, {
    "lobu.pvc_name": pvcName,
    "lobu.agent_id": agentId,
    "lobu.pvc_size": pvcSize,
  });

  logger.info({ traceparent, pvcName, agentId, size: pvcSize }, "Creating PVC");

  try {
    await coreV1Api.createNamespacedPersistentVolumeClaim(namespace, pvc);
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

/**
 * List pods belonging to a given deployment by matching owner references.
 */
async function listDeploymentPods(
  coreV1Api: k8s.CoreV1Api,
  namespace: string,
  deploymentName: string
): Promise<k8s.V1Pod[]> {
  const pods = await coreV1Api.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    "app.kubernetes.io/component=worker"
  );

  const podItems = (
    (pods as { body?: { items?: k8s.V1Pod[] } }).body?.items || []
  ).filter((pod) =>
    (pod.metadata?.ownerReferences || []).some(
      (owner) =>
        owner.kind === "ReplicaSet" &&
        owner.name?.startsWith(`${deploymentName}-`)
    )
  );

  return podItems;
}

/**
 * Get a failure message for a pod by inspecting its events.
 */
async function getPodFailureMessage(
  coreV1Api: k8s.CoreV1Api,
  namespace: string,
  podName: string
): Promise<string> {
  try {
    const events = await coreV1Api.listNamespacedEvent(
      namespace,
      undefined,
      undefined,
      undefined,
      `involvedObject.name=${podName}`
    );
    const items = (events as { body?: { items?: k8s.CoreV1Event[] } }).body
      ?.items;
    const latest = items
      ?.filter((event) =>
        ["Failed", "BackOff", "ErrImagePull", "ImagePullBackOff"].includes(
          event.reason || ""
        )
      )
      .sort(
        (a, b) =>
          new Date(
            b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0
          ).getTime() -
          new Date(
            a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0
          ).getTime()
      )[0];

    if (latest?.message) {
      return latest.message;
    }
  } catch {
    // Ignore event lookup failures (RBAC/compat).
  }

  return "";
}

/**
 * Wait for a worker deployment to have at least one available replica.
 * Detects image pull failures early and throws.
 */
export async function waitForWorkerReady(
  appsV1Api: k8s.AppsV1Api,
  coreV1Api: k8s.CoreV1Api,
  namespace: string,
  deploymentName: string,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const deployment = await appsV1Api.readNamespacedDeployment(
      deploymentName,
      namespace
    );
    const deploymentBody = (deployment as { body?: k8s.V1Deployment }).body;
    const availableReplicas = deploymentBody?.status?.availableReplicas || 0;

    if (availableReplicas > 0) {
      return;
    }

    const pods = await listDeploymentPods(coreV1Api, namespace, deploymentName);
    for (const pod of pods) {
      const podName = pod.metadata?.name || "unknown";
      const workerStatus = pod.status?.containerStatuses?.find(
        (status) => status.name === "worker"
      );
      const waiting = workerStatus?.state?.waiting;

      if (waiting?.reason && IMAGE_PULL_FAILURE_REASONS.has(waiting.reason)) {
        const eventMessage = await getPodFailureMessage(
          coreV1Api,
          namespace,
          podName
        );
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Worker startup failed (${waiting.reason}) for ${deploymentName}: ${eventMessage || waiting.message || "image pull failed"}`,
          {
            deploymentName,
            podName,
            waitingReason: waiting.reason,
            waitingMessage: waiting.message,
          },
          true
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new OrchestratorError(
    ErrorCode.DEPLOYMENT_CREATE_FAILED,
    `Timed out waiting for worker deployment ${deploymentName} to become ready`,
    { deploymentName, timeoutMs },
    true
  );
}

/**
 * Remove the lobu.io/cleanup finalizer from a deployment or PVC.
 * No-ops if the finalizer is already absent.
 */
export async function removeFinalizerFromResource(
  appsV1Api: k8s.AppsV1Api,
  coreV1Api: k8s.CoreV1Api,
  namespace: string,
  kind: "deployment" | "pvc",
  name: string
): Promise<void> {
  try {
    // Read current finalizers
    let currentFinalizers: string[] | undefined;
    if (kind === "deployment") {
      const resource = await appsV1Api.readNamespacedDeployment(
        name,
        namespace
      );
      currentFinalizers = (resource as any).body?.metadata?.finalizers;
    } else {
      const resource = await coreV1Api.readNamespacedPersistentVolumeClaim(
        name,
        namespace
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
      await appsV1Api.patchNamespacedDeployment(
        name,
        namespace,
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
      await coreV1Api.patchNamespacedPersistentVolumeClaim(
        name,
        namespace,
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
 */
export async function cleanupOrphanedPvcFinalizers(
  appsV1Api: k8s.AppsV1Api,
  coreV1Api: k8s.CoreV1Api,
  namespace: string
): Promise<void> {
  try {
    const pvcs = await coreV1Api.listNamespacedPersistentVolumeClaim(
      namespace,
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
        logger.info(`Removing orphaned finalizer from Terminating PVC ${name}`);
        await removeFinalizerFromResource(
          appsV1Api,
          coreV1Api,
          namespace,
          "pvc",
          name
        );
      }
    }
  } catch (error) {
    logger.warn(
      "Failed to clean up orphaned PVC finalizers:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
