import fs from "node:fs";
import path from "node:path";
import { createLogger, ErrorCode, OrchestratorError } from "@lobu/core";
import Docker from "dockerode";
import type { ModelProviderModule } from "../../modules/module-system";
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
} from "../deployment-utils";

class ResourceParser {
  static parseMemory(memoryStr: string): number {
    const units: Record<string, number> = {
      Ki: 1024,
      Mi: 1024 * 1024,
      Gi: 1024 * 1024 * 1024,
      k: 1000,
      M: 1000 * 1000,
      G: 1000 * 1000 * 1000,
    };
    for (const [unit, multiplier] of Object.entries(units)) {
      if (memoryStr.endsWith(unit)) {
        const value = parseFloat(memoryStr.replace(unit, ""));
        return value * multiplier;
      }
    }
    return parseInt(memoryStr, 10);
  }

  static parseCpu(cpuStr: string): number {
    if (cpuStr.endsWith("m")) {
      const millicores = parseInt(cpuStr.replace("m", ""), 10);
      return (millicores / 1000) * 1e9;
    }
    const cores = parseFloat(cpuStr);
    return cores * 1e9;
  }
}

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

    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });

    this.checkGvisorAvailability();
    this.ensureInternalNetwork();
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

  // Creates the internal Docker network with `internal: true` when missing.
  // Skipped when WORKER_NETWORK is explicitly set (e.g. local dev using bridge).
  private async ensureInternalNetwork(): Promise<void> {
    if (process.env.WORKER_NETWORK) {
      return;
    }

    const composeProjectName = process.env.COMPOSE_PROJECT_NAME || "lobu";
    const networkName = `${composeProjectName}_lobu-internal`;

    try {
      const network = this.docker.getNetwork(networkName);
      const info = await network.inspect();
      if (!info.Internal) {
        logger.warn(
          `⚠️  Network ${networkName} exists but is NOT internal — workers may have direct internet access`
        );
      }
    } catch {
      // Network doesn't exist — create it with internal: true
      try {
        await this.docker.createNetwork({
          Name: networkName,
          Internal: true,
          Driver: "bridge",
          Labels: {
            "lobu.io/managed": "true",
            "lobu.io/purpose": "worker-isolation",
          },
        });
        logger.info(
          `✅ Created internal network ${networkName} for worker isolation`
        );
      } catch (createError) {
        logger.error(
          `Failed to create internal network ${networkName}: ${createError instanceof Error ? createError.message : String(createError)}`
        );
      }
    }
  }

  private isRunningInContainer(): boolean {
    return fs.existsSync("/.dockerenv") || process.env.CONTAINER === "true";
  }

  private getHostAddress(): string {
    if (this.isRunningInContainer()) {
      return "gateway";
    }
    return "host.docker.internal";
  }

  async validateWorkerImage(): Promise<void> {
    const imageName = this.getWorkerImageReference();

    try {
      await this.docker.getImage(imageName).inspect();
      logger.info(`✅ Worker image verified: ${imageName}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("No such image") ||
        errorMessage.includes("404")
      ) {
        logger.info(
          `📥 Worker image ${imageName} not found locally, pulling...`
        );
        try {
          await new Promise<void>((resolve, reject) => {
            this.docker.pull(imageName, (err: any, stream: any) => {
              if (err) return reject(err);
              this.docker.modem.followProgress(stream, (err: any) => {
                if (err) reject(err);
                else resolve();
              });
            });
          });
          logger.info(`✅ Worker image ${imageName} pulled successfully`);
        } catch (pullError) {
          logger.error(
            `❌ Failed to pull worker image ${imageName}:`,
            pullError
          );
          throw new OrchestratorError(
            ErrorCode.DEPLOYMENT_CREATE_FAILED,
            `Worker image ${imageName} does not exist locally and pull failed. Please check your internet connection or registry permissions.`
          );
        }
      } else {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          `Failed to validate worker image ${imageName}: ${errorMessage}`
        );
      }
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
        const deploymentName = containerInfo.Names[0]?.substring(1) || "";

        const trackedActivity = this.activityTimestamps.get(deploymentName);
        const lastActivityStr =
          containerInfo.Labels?.["lobu.io/last-activity"] ||
          containerInfo.Labels?.["lobu.io/created"];

        const labelActivity = lastActivityStr
          ? new Date(lastActivityStr)
          : new Date(containerInfo.Created * 1000);

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

  private async ensureVolume(agentId: string): Promise<string> {
    const volumeName = `lobu-workspace-${agentId}`;
    let volumeCreated = false;

    try {
      await this.docker.getVolume(volumeName).inspect();
      logger.info(`✅ Volume ${volumeName} already exists`);
    } catch (_error) {
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
        // Race: another thread created the volume concurrently.
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

    // Worker container's claude user is UID 1001.
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

  protected async spawnDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
  ): Promise<void> {
    try {
      const agentId = messageData?.agentId;
      if (!agentId) {
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          "Missing agentId in message payload"
        );
      }

      const isRunningInDocker = process.env.DEPLOYMENT_MODE === "docker";
      const projectRoot = isRunningInDocker
        ? process.env.LOBU_DEV_PROJECT_PATH || "/app"
        : path.join(process.cwd(), "..", "..");

      const workspaceDir = `${projectRoot}/workspaces/${agentId}`;

      const volumeName = await this.ensureVolume(agentId);

      const commonEnvVars = await this.generateEnvironmentVariables(
        username,
        userId,
        deploymentName,
        messageData,
        true
      );

      // macOS/Windows: Docker containers cannot reach localhost on the host
      if (process.platform === "darwin" || process.platform === "win32") {
        if (
          commonEnvVars.LOBU_DATABASE_HOST === "localhost" ||
          commonEnvVars.LOBU_DATABASE_HOST === "127.0.0.1"
        ) {
          commonEnvVars.LOBU_DATABASE_HOST = "host.docker.internal";
        }
      }

      const envVars = Object.entries(commonEnvVars).map(
        ([key, value]) => `${key}=${value}`
      );

      // Nix packages require writable rootfs for symlinks
      const hasNixConfig =
        (messageData?.nixConfig?.packages?.length ?? 0) > 0 ||
        !!messageData?.nixConfig?.flakeUrl;

      const composeProjectName = process.env.COMPOSE_PROJECT_NAME || "lobu";

      const createOptions: Docker.ContainerCreateOptions = {
        name: deploymentName,
        Image: this.getWorkerImageReference(),
        Env: envVars,
        Labels: {
          ...BASE_WORKER_LABELS,
          "lobu.io/created": new Date().toISOString(),
          "lobu.io/agent-id": agentId,
          "com.docker.compose.project": composeProjectName,
          "com.docker.compose.service": deploymentName,
          "com.docker.compose.oneoff": "False",
          ...resolvePlatformDeploymentMetadata(messageData),
        },
        HostConfig: {
          // Dev uses bind mounts for hot reload; production uses named volumes for isolation
          ...(process.env.NODE_ENV === "development" && isRunningInDocker
            ? {
                Binds: [
                  `${workspaceDir}:/workspace`,
                  `${projectRoot}/packages:/app/packages`,
                  `${projectRoot}/scripts:/app/scripts`,
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
          Memory: ResourceParser.parseMemory(
            this.config.worker.resources.limits.memory
          ),
          NanoCpus: ResourceParser.parseCpu(
            this.config.worker.resources.limits.cpu
          ),
          NetworkMode:
            process.env.WORKER_NETWORK || `${composeProjectName}_lobu-internal`,
          // Required on Linux + macOS/Windows when using internal networks
          ...(!this.isRunningInContainer() && {
            ExtraHosts: ["host.docker.internal:host-gateway"],
          }),
          CapDrop: ["ALL"],
          CapAdd: process.env.WORKER_CAPABILITIES
            ? process.env.WORKER_CAPABILITIES.split(",")
            : [],
          SecurityOpt: [
            "no-new-privileges:true",
            ...(process.env.WORKER_SECCOMP_PROFILE
              ? [`seccomp=${process.env.WORKER_SECCOMP_PROFILE}`]
              : []),
            ...(process.env.WORKER_APPARMOR_PROFILE
              ? [`apparmor=${process.env.WORKER_APPARMOR_PROFILE}`]
              : []),
          ],
          UsernsMode: process.env.WORKER_USERNS_MODE || "",
          // Nix entrypoint needs writable / to symlink /nix/store
          ReadonlyRootfs:
            !hasNixConfig && process.env.WORKER_READONLY_ROOTFS !== "false",
          ...(!hasNixConfig &&
            process.env.WORKER_READONLY_ROOTFS !== "false" && {
              Tmpfs: {
                "/tmp": "rw,noexec,nosuid,size=100m",
              },
            }),
          ShmSize: 268435456,
          ...(this.gvisorAvailable && {
            Runtime: "runsc",
          }),
        },
        WorkingDir: "/workspace",
      };

      let container: Docker.Container;
      try {
        container = await this.docker.createContainer(createOptions);
      } catch (createError: any) {
        // Another gateway replica created this container concurrently — Docker
        // enforces unique container names cluster-wide on a host. Treat 409 as
        // benign: the existing container is the canonical worker for this
        // deployment slot, and we just need to ensure it's running.
        if (
          createError?.statusCode === 409 ||
          createError?.message?.includes("already in use")
        ) {
          logger.info(
            `Container ${deploymentName} already exists (created by another replica); ensuring it's started`
          );
          const existing = this.docker.getContainer(deploymentName);
          const info = await existing.inspect();
          if (!info.State.Running) {
            await existing.start();
          }
          return;
        }
        throw createError;
      }
      try {
        await container.start();
      } catch (startError) {
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

      // Host-mode workers need the public network to reach host.docker.internal
      // (the internal network blocks host access by design)
      if (!this.isRunningInContainer()) {
        try {
          const publicNetwork = this.docker.getNetwork(
            `${composeProjectName}_lobu-public`
          );
          await publicNetwork.connect({ Container: container.id });
        } catch (netErr) {
          logger.warn(
            `Could not connect ${deploymentName} to public network: ${netErr instanceof Error ? netErr.message : String(netErr)}`
          );
        }
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

      try {
        await container.stop();
        logger.info(`✅ Stopped container: ${deploymentName}`);
      } catch (_error) {
        logger.warn(`⚠️  Container ${deploymentName} was not running`);
      }

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

    // Space volumes are shared across threads and intentionally persist; cleanup is manual.
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    // Docker has no runtime label updates; track in-memory instead
    this.activityTimestamps.set(deploymentName, new Date());
  }

  protected getDispatcherHost(): string {
    return this.getHostAddress();
  }
}
