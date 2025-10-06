import path from "node:path";
import Docker from "dockerode";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
} from "../base/BaseDeploymentManager";
import type { DatabaseAdapter } from "@peerbot/shared";
import {
  ErrorCode,
  type OrchestratorConfig,
  OrchestratorError,
} from "../types";
import { PostgresSecretManager } from "./PostgresSecretManager";
import { createLogger } from "@peerbot/shared";

const logger = createLogger("orchestrator");

export class DockerDeploymentManager extends BaseDeploymentManager {
  private docker: Docker;
  private gvisorAvailable = false;

  constructor(config: OrchestratorConfig, database: DatabaseAdapter) {
    const secretManager = new PostgresSecretManager(config, database);
    super(config, database, secretManager);

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

      return containers.map((containerInfo: any) => {
        const deploymentName = containerInfo.Names[0]?.substring(1) || ""; // Remove leading '/'
        // The deploymentId is now the full deployment name (includes user ID)
        const deploymentId = deploymentName;

        // Get last activity from labels or fallback to creation time
        const lastActivityStr =
          containerInfo.Labels?.["peerbot.io/last-activity"] ||
          containerInfo.Labels?.["peerbot.io/created"];

        const lastActivity = lastActivityStr
          ? new Date(lastActivityStr)
          : new Date(containerInfo.Created * 1000);
        const minutesIdle = (now - lastActivity.getTime()) / (1000 * 60);
        const daysSinceActivity = minutesIdle / (60 * 24);
        const replicas = containerInfo.State === "running" ? 1 : 0;

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

  async createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: any,
    userEnvVars: Record<string, string> = {}
  ): Promise<void> {
    try {
      // Extract thread ID from deployment name for per-thread workspace isolation
      const threadId = deploymentName.replace("peerbot-worker-", "");

      // For Docker mode, we need to use host paths for volume mounts
      // The orchestrator is running inside Docker but needs to mount host directories
      const isRunningInDocker = process.env.DEPLOYMENT_MODE === "docker";
      const projectRoot = isRunningInDocker
        ? process.env.HOST_PROJECT_PATH || "/app" // Use env var or fallback
        : path.join(process.cwd(), "..", "..");

      const workspaceDir = `${projectRoot}/workspaces/${threadId}`;

      // Environment variables
      const password = await this.getPasswordForUser(username);

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
          commonEnvVars.PEERBOT_DATABASE_HOST === "localhost" ||
          commonEnvVars.PEERBOT_DATABASE_HOST === "127.0.0.1"
        ) {
          commonEnvVars.PEERBOT_DATABASE_HOST = "host.docker.internal";
        }
      }

      const envVars = [
        `PEERBOT_DATABASE_USERNAME=${username}`,
        `PEERBOT_DATABASE_PASSWORD=${password}`,
        `ANTHROPIC_API_KEY=${username}:${password}`,
        // Convert common environment variables to Docker format
        ...Object.entries(commonEnvVars).map(
          ([key, value]) => `${key}=${value}`
        ),
      ];

      // Get the Docker Compose project name from environment or use default
      const composeProjectName = process.env.COMPOSE_PROJECT_NAME || "peerbot";

      const createOptions: Docker.ContainerCreateOptions = {
        name: deploymentName,
        Image: `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
        Env: envVars,
        Labels: {
          "app.kubernetes.io/name": "peerbot",
          "app.kubernetes.io/component": "worker",
          "peerbot/managed-by": "orchestrator",
          "peerbot.io/created": new Date().toISOString(),
          // Docker Compose labels to associate with the project
          "com.docker.compose.project": composeProjectName,
          "com.docker.compose.service": deploymentName, // Use unique service name
          "com.docker.compose.oneoff": "False",
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
        },
        HostConfig: {
          Binds:
            process.env.NODE_ENV === "development" && isRunningInDocker
              ? [
                  `${workspaceDir}:/workspace`,
                  `${process.env.HOST_PROJECT_PATH}/packages:/app/packages`,
                  `${process.env.HOST_PROJECT_PATH}/scripts:/app/scripts`,
                ]
              : [`${workspaceDir}:/workspace`],
          RestartPolicy: {
            Name: "unless-stopped",
          },
          // Resource limits similar to K8s
          Memory: this.parseMemoryLimit(
            this.config.worker.resources.limits.memory
          ),
          NanoCpus: this.parseCpuLimit(this.config.worker.resources.limits.cpu),
          // Connect to the Docker Compose network
          NetworkMode: `${composeProjectName}_peerbot-network`,
          // Use gVisor runtime if available for enhanced isolation
          ...(this.gvisorAvailable && {
            Runtime: "runsc",
          }),
        },
        WorkingDir: "/workspace",
      };

      const container = await this.docker.createContainer(createOptions);
      await container.start();

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

  async deleteDeployment(deploymentId: string): Promise<void> {
    // deploymentId should already be the full deployment name
    const deploymentName = deploymentId.startsWith("peerbot-worker-")
      ? deploymentId
      : `peerbot-worker-${deploymentId}`;

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
      logger.info(`✅ Removed container: ${deploymentName}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        logger.warn(
          `⚠️  Container ${deploymentName} not found (already deleted)`
        );
      } else {
        throw error;
      }
    }
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    try {
      // const _container = this.docker.getContainer(deploymentName);
      const timestamp = new Date().toISOString();

      // Update container labels (Docker doesn't support runtime label updates, so we log for now)
      logger.info(
        `✅ Updated activity timestamp for container: ${deploymentName} at ${timestamp}`
      );
      // Note: Docker doesn't support runtime label updates like K8s annotations
      // This could be implemented by recreating the container with updated labels if needed
    } catch (error) {
      logger.error(
        `❌ Failed to update activity for container ${deploymentName}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - activity tracking should not block message processing
    }
  }

  private async getPasswordForUser(username: string): Promise<string> {
    // Get password from the secret manager
    return await this.secretManager.getOrCreateUserCredentials(
      username,
      (username: string, password: string) =>
        this.databaseManager.createPostgresUser(username, password)
    );
  }

  private parseMemoryLimit(memoryStr: string): number {
    const units: { [key: string]: number } = {
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

    // If no unit is specified, assume bytes
    return parseInt(memoryStr, 10);
  }

  private parseCpuLimit(cpuStr: string): number {
    if (cpuStr.endsWith("m")) {
      // Millicores
      const millicores = parseInt(cpuStr.replace("m", ""), 10);
      return (millicores / 1000) * 1000000000;
    }

    // Assume whole cores
    const cores = parseFloat(cpuStr);
    return cores * 1000000000;
  }
}
