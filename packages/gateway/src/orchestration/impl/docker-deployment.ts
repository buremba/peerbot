import fs from "node:fs";
import path from "node:path";
import type { ModelProviderModule } from "@lobu/core";
import { createLogger, ErrorCode, OrchestratorError } from "@lobu/core";
import Docker from "dockerode";
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
  ResourceParser,
  resolvePlatformDeploymentMetadata,
} from "../deployment-utils";

const logger = createLogger("orchestrator");

export class DockerDeploymentManager extends BaseDeploymentManager {
  private docker: Docker;
  private gvisorAvailable = false;
  private activityTimestamps: Map<string, Date> = new Map();

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    super(config, moduleEnvVarsBuilder, providerModules);

    // Explicitly use the Unix socket for Docker connection
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });

    // Check for gvisor availability on initialization
    this.checkGvisorAvailability();
  }

  private async checkGvisorAvailability(): Promise<void> {
    try {
      const info = await this.docker.info();
      const runtimes = info.Runtimes || {};

      if (runtimes.runsc || runtimes.gvisor) {
        this.gvisorAvailable = true;
        logger.info(
          "✅ gVisor runtime detected and will be used for worker isolation"
        );
      } else {
        logger.info(
          "ℹ️  gVisor runtime not available, using default runc runtime"
        );
      }
    } catch (error) {
      logger.warn(
        `⚠️  Failed to check Docker runtime availability: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if gateway is running inside a Docker container
   */
  private isRunningInContainer(): boolean {
    return fs.existsSync("/.dockerenv") || process.env.CONTAINER === "true";
  }

  /**
   * Get the host address that workers should use to reach the gateway
   * When gateway runs on host, workers use host.docker.internal
   * When gateway runs in container (docker-compose mode), workers use service name
   */
  private getHostAddress(): string {
    if (this.isRunningInContainer()) {
      return "gateway";
    }
    // For host-mode development, workers reach gateway via host.docker.internal
    return "host.docker.internal";
  }

  /**
   * Validate that the worker image exists locally
   * Called on gateway startup to ensure workers can be created
   */
  async validateWorkerImage(): Promise<void> {
    const imageName = `${this.config.worker.image.repository}:${this.config.worker.image.tag}`;

    try {
      await this.docker.getImage(imageName).inspect();
      logger.info(`✅ Worker image verified: ${imageName}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if it's a "not found" error
      if (
        errorMessage.includes("No such image") ||
        errorMessage.includes("404")
      ) {
        logger.error(
          `❌ Worker image not found: ${imageName}\n` +
            `   Please build it with: docker compose build worker\n` +
            `   Or ensure 'docker compose up' builds the worker service automatically`
        );
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Worker image ${imageName} does not exist. Build it first with 'docker compose build worker'`
        );
      }

      // Other error - re-throw
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to validate worker image ${imageName}: ${errorMessage}`
      );
    }
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: ["app.kubernetes.io/component=worker"],
        },
      });

      const now = Date.now();
      const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
      const veryOldDays = getVeryOldThresholdDays(this.config);

      return containers.map((containerInfo: Docker.ContainerInfo) => {
        const deploymentName = containerInfo.Names[0]?.substring(1) || ""; // Remove leading '/'

        // Get last activity from in-memory tracking, labels, or creation time
        const trackedActivity = this.activityTimestamps.get(deploymentName);
        const lastActivityStr =
          containerInfo.Labels?.["lobu.io/last-activity"] ||
          containerInfo.Labels?.["lobu.io/created"];

        const labelActivity = lastActivityStr
          ? new Date(lastActivityStr)
          : new Date(containerInfo.Created * 1000);

        // Use the most recent timestamp from any source
        const lastActivity =
          trackedActivity && trackedActivity > labelActivity
            ? trackedActivity
            : labelActivity;
        const replicas = containerInfo.State === "running" ? 1 : 0;
        return buildDeploymentInfoSummary({
          deploymentName,
          lastActivity,
          now,
          idleThresholdMinutes,
          veryOldDays,
          replicas,
        });
      });
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to list Docker containers: ${error instanceof Error ? error.message : String(error)}`,
        { error },
        true
      );
    }
  }

  /**
   * Ensures a Docker volume exists for the given space ID.
   * Uses named volumes for better isolation and security.
   * Multiple threads in the same space share the same volume.
   */
  private async ensureVolume(agentId: string): Promise<string> {
    const volumeName = `lobu-workspace-${agentId}`;
    let volumeCreated = false;

    try {
      // Check if volume already exists (idempotent for concurrent creation)
      await this.docker.getVolume(volumeName).inspect();
      logger.info(`✅ Volume ${volumeName} already exists`);
    } catch (error) {
      // Volume doesn't exist, create it
      try {
        await this.docker.createVolume({
          Name: volumeName,
          Labels: {
            "lobu.io/agent-id": agentId,
            "lobu.io/created": new Date().toISOString(),
          },
        });
        logger.info(`✅ Created volume: ${volumeName}`);
        volumeCreated = true;
      } catch (createError: any) {
        // Handle race condition: volume created by another thread
        if (
          createError.statusCode === 409 ||
          createError.message?.includes("already exists")
        ) {
          logger.info(`Volume ${volumeName} was created by another thread`);
        } else {
          throw createError;
        }
      }
    }

    // Fix volume permissions for new volumes
    // The claude user in the worker container has UID 1001
    if (volumeCreated) {
      try {
        const initContainer = await this.docker.createContainer({
          Image: "alpine:latest",
          Cmd: ["chown", "-R", "1001:1001", "/workspace"],
          HostConfig: {
            AutoRemove: true,
            Mounts: [
              {
                Type: "volume",
                Source: volumeName,
                Target: "/workspace",
              },
            ],
          },
        });
        await initContainer.start();
        await initContainer.wait();
        logger.info(`✅ Fixed volume permissions for ${volumeName}`);
      } catch (permError) {
        logger.warn(
          `⚠️ Could not fix volume permissions: ${permError instanceof Error ? permError.message : String(permError)}`
        );
      }
    }

    return volumeName;
  }

  async createDeployment(
    ...args: Parameters<BaseDeploymentManager["createDeployment"]>
  ): Promise<void> {
    const [deploymentName, username, userId, messageDataRaw, userEnvVarsRaw] =
      args;
    const messageData = messageDataRaw as MessagePayload | undefined;
    const userEnvVars =
      (userEnvVarsRaw as Record<string, string> | undefined) ?? {};

    try {
      // Use agentId for volume naming (shared across threads in same space)
      const agentId = messageData?.agentId!;

      // Determine if running in Docker and resolve project paths
      const isRunningInDocker = process.env.DEPLOYMENT_MODE === "docker";
      const projectRoot = isRunningInDocker
        ? process.env.LOBU_DEV_PROJECT_PATH || "/app"
        : path.join(process.cwd(), "..", "..");

      const workspaceDir = `${projectRoot}/workspaces/${agentId}`;

      // Ensure volume exists for production mode (space-scoped)
      const volumeName = await this.ensureVolume(agentId);

      // Get common environment variables from base class
      const commonEnvVars = await this.generateEnvironmentVariables(
        username,
        userId,
        deploymentName,
        messageData,
        true,
        userEnvVars
      );

      // On macOS/Windows, Docker containers need to use host.docker.internal instead of localhost
      if (process.platform === "darwin" || process.platform === "win32") {
        if (
          commonEnvVars.LOBU_DATABASE_HOST === "localhost" ||
          commonEnvVars.LOBU_DATABASE_HOST === "127.0.0.1"
        ) {
          commonEnvVars.LOBU_DATABASE_HOST = "host.docker.internal";
        }
      }

      // Environment variables from base class already include:
      // HTTP_PROXY, HTTPS_PROXY, NO_PROXY, NODE_ENV, DEBUG
      // Provider credentials are injected via provider modules in generateEnvironmentVariables()
      const envVars = Object.entries(commonEnvVars).map(
        ([key, value]) => `${key}=${value}`
      );

      // Check if Nix packages are configured (need writable rootfs for symlinks)
      const hasNixConfig =
        (messageData?.nixConfig?.packages?.length ?? 0) > 0 ||
        !!messageData?.nixConfig?.flakeUrl;

      // Get the Docker Compose project name from environment or use default
      const composeProjectName = process.env.COMPOSE_PROJECT_NAME || "lobu";

      const createOptions: Docker.ContainerCreateOptions = {
        name: deploymentName,
        Image: `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
        Env: envVars,
        Labels: {
          ...BASE_WORKER_LABELS,
          "lobu.io/created": new Date().toISOString(),
          "lobu.io/agent-id": agentId,
          // Docker Compose labels to associate with the project
          "com.docker.compose.project": composeProjectName,
          "com.docker.compose.service": deploymentName, // Use unique service name
          "com.docker.compose.oneoff": "False",
          // Add platform-specific metadata
          ...resolvePlatformDeploymentMetadata(messageData),
        },
        HostConfig: {
          // Use named volumes in production for better isolation
          // Use bind mounts in development for hot reload
          ...(process.env.NODE_ENV === "development" && isRunningInDocker
            ? {
                Binds: [
                  `${workspaceDir}:/workspace`,
                  // Mount packages and scripts for hot reload
                  `${projectRoot}/packages:/app/packages`,
                  `${projectRoot}/scripts:/app/scripts`,
                  // Additional custom mounts (optional)
                  ...(process.env.WORKER_VOLUME_MOUNTS
                    ? process.env.WORKER_VOLUME_MOUNTS.split(";")
                        .filter((mount) => mount.trim())
                        .map((mount) =>
                          mount
                            .replace("${PWD}", projectRoot)
                            .replace("${WORKSPACE_DIR}", workspaceDir)
                        )
                    : []),
                ],
              }
            : {
                // Production: use named volumes for better isolation
                Mounts: [
                  {
                    Type: "volume",
                    Source: volumeName,
                    Target: "/workspace",
                    ReadOnly: false,
                  },
                ],
              }),
          RestartPolicy: {
            Name: "unless-stopped",
          },
          // Resource limits similar to K8s
          Memory: ResourceParser.parseMemory(
            this.config.worker.resources.limits.memory
          ),
          NanoCpus: ResourceParser.parseCpu(
            this.config.worker.resources.limits.cpu
          ),
          // Always connect to internal network (network isolation always enabled)
          // In docker-compose mode: uses compose project prefix
          // In host mode: uses plain network name (WORKER_NETWORK env var)
          NetworkMode:
            process.env.WORKER_NETWORK || `${composeProjectName}_lobu-internal`,
          // Linux support: add host.docker.internal mapping
          // On macOS/Windows this is automatic, on Linux we need ExtraHosts
          ...(process.platform === "linux" &&
            !this.isRunningInContainer() && {
              ExtraHosts: ["host.docker.internal:host-gateway"],
            }),
          // Security: Drop all capabilities and only add what's needed
          CapDrop: ["ALL"],
          CapAdd: process.env.WORKER_CAPABILITIES
            ? process.env.WORKER_CAPABILITIES.split(",")
            : [],
          // Security: Prevent privilege escalation
          SecurityOpt: [
            "no-new-privileges:true",
            // Custom seccomp profile (default Docker seccomp is applied automatically)
            ...(process.env.WORKER_SECCOMP_PROFILE
              ? [`seccomp=${process.env.WORKER_SECCOMP_PROFILE}`]
              : []),
            // AppArmor profile if specified
            ...(process.env.WORKER_APPARMOR_PROFILE
              ? [`apparmor=${process.env.WORKER_APPARMOR_PROFILE}`]
              : []),
          ],
          // User namespace remapping (if Docker daemon is configured for it)
          // This makes the root user inside container map to non-root on host
          UsernsMode: process.env.WORKER_USERNS_MODE || "",
          // Read-only root filesystem (worker can write to /workspace and /tmp)
          // Disabled when Nix packages configured (entrypoint needs to symlink /nix/store)
          // Enabled by default for security, set WORKER_READONLY_ROOTFS=false to disable
          ReadonlyRootfs:
            !hasNixConfig && process.env.WORKER_READONLY_ROOTFS !== "false",
          // Temporary filesystem for /tmp (writable, in-memory)
          ...(!hasNixConfig &&
            process.env.WORKER_READONLY_ROOTFS !== "false" && {
              Tmpfs: {
                "/tmp": "rw,noexec,nosuid,size=100m",
                "/home/bun/.cache": "rw,noexec,nosuid,size=200m",
              },
            }),
          // Shared memory for Chromium and other apps requiring /dev/shm
          ShmSize: 268435456, // 256MB
          // Use gVisor runtime if available for enhanced isolation
          ...(this.gvisorAvailable && {
            Runtime: "runsc",
          }),
        },
        WorkingDir: "/workspace",
      };

      const container = await this.docker.createContainer(createOptions);
      try {
        await container.start();
      } catch (startError) {
        // Clean up orphaned container if start fails
        logger.error(
          `Failed to start container ${deploymentName}, removing orphaned container`,
          startError
        );
        try {
          await container.remove({ force: true });
        } catch (removeError) {
          logger.error(
            `Failed to remove orphaned container ${deploymentName}:`,
            removeError
          );
        }
        throw startError;
      }

      logger.info(`✅ Created and started Docker container: ${deploymentName}`);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to create Docker container: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, error },
        true
      );
    }
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    try {
      const container = this.docker.getContainer(deploymentName);
      const containerInfo = await container.inspect();

      if (replicas === 0 && containerInfo.State.Running) {
        await container.stop();
        logger.info(`Stopped container ${deploymentName}`);
      } else if (replicas === 1 && !containerInfo.State.Running) {
        await container.start();
        logger.info(`Started container ${deploymentName}`);
      }
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_SCALE_FAILED,
        `Failed to scale Docker container ${deploymentName}: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, replicas, error },
        true
      );
    }
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(deploymentName);

      // Stop container if running
      try {
        await container.stop();
        logger.info(`✅ Stopped container: ${deploymentName}`);
      } catch (_error) {
        // Container might already be stopped
        logger.warn(`⚠️  Container ${deploymentName} was not running`);
      }

      // Remove container
      await container.remove();
      this.activityTimestamps.delete(deploymentName);
      logger.info(`✅ Removed container: ${deploymentName}`);
    } catch (error) {
      const dockerError = error as { statusCode?: number };
      if (dockerError.statusCode === 404) {
        logger.warn(
          `⚠️  Container ${deploymentName} not found (already deleted)`
        );
      } else {
        throw error;
      }
    }

    // NOTE: Space volumes are NOT deleted on deployment deletion
    // They are shared across threads in the same space and persist
    // for future conversations. Cleanup is done manually or via separate process.
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    // Docker doesn't support runtime label updates like K8s annotations
    // Track activity in-memory for idle cleanup calculations
    this.activityTimestamps.set(deploymentName, new Date());
  }

  protected getDispatcherHost(): string {
    return this.getHostAddress();
  }
}
