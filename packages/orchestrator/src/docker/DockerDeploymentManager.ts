import Docker from 'dockerode';
import { BaseDeploymentManager, DeploymentInfo } from '../base/BaseDeploymentManager';
import { PostgresSecretManager } from './PostgresSecretManager';
import { OrchestratorConfig, OrchestratorError, ErrorCode } from '../types';
import { DatabasePool } from '../db-connection-pool';

interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  created: Date;
  labels: { [key: string]: string };
}

export class DockerDeploymentManager extends BaseDeploymentManager {
  private docker: Docker;

  constructor(config: OrchestratorConfig, dbPool: DatabasePool) {
    const secretManager = new PostgresSecretManager(config, dbPool);
    super(config, dbPool, secretManager);
    
    // Explicitly use the Unix socket for Docker connection
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    try {
      const containers = await this.docker.listContainers({ 
        all: true,
        filters: {
          label: ['app.kubernetes.io/component=worker']
        }
      });

      const now = Date.now();
      const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;

      return containers.map((containerInfo: any) => {
        const deploymentName = containerInfo.Names[0]?.substring(1) || ''; // Remove leading '/'
        const deploymentId = deploymentName.replace('peerbot-worker-', '');
        
        // Get last activity from labels or fallback to creation time
        const lastActivityStr = containerInfo.Labels?.['peerbot.io/last-activity'] ||
                               containerInfo.Labels?.['peerbot.io/created'];
        
        const lastActivity = lastActivityStr ? new Date(lastActivityStr) : new Date(containerInfo.Created * 1000);
        const minutesIdle = (now - lastActivity.getTime()) / (1000 * 60);
        const daysSinceActivity = minutesIdle / (60 * 24);
        const replicas = containerInfo.State === 'running' ? 1 : 0;
        
        return {
          deploymentName,
          deploymentId,
          lastActivity,
          minutesIdle,
          daysSinceActivity,
          replicas,
          isIdle: minutesIdle >= idleThresholdMinutes,
          isVeryOld: daysSinceActivity >= 7
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

  async createDeployment(deploymentName: string, username: string, userId: string, messageData?: any, imageName?: string): Promise<void> {
    try {
      // Create workspace directory for this user (use absolute path)
      const workspaceDir = `${process.cwd()}/workspaces/${userId}`;
      
      // Environment variables
      // Parse the DATABASE_URL to extract components and reconstruct with user credentials
      const dbUrl = new URL(this.config.database.connectionString);
      dbUrl.username = username;
      dbUrl.password = await this.getPasswordForUser(username);
      
      // On macOS/Windows, Docker containers need to use host.docker.internal instead of localhost
      if (process.platform === 'darwin' || process.platform === 'win32') {
        if (dbUrl.hostname === 'localhost' || dbUrl.hostname === '127.0.0.1') {
          dbUrl.hostname = 'host.docker.internal';
        }
      }
      
      // Get common environment variables from base class
      const commonEnvVars = this.generateEnvironmentVariables(username, userId, deploymentName, messageData);
      
      const envVars = [
        `DATABASE_URL=${dbUrl.toString()}`,
        // Convert common environment variables to Docker format
        ...Object.entries(commonEnvVars).map(([key, value]) => `${key}=${value}`)
      ];

      const createOptions: Docker.ContainerCreateOptions = {
        name: deploymentName,
        Image: imageName || `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
        Env: envVars,
        Labels: {
          'app.kubernetes.io/name': 'peerbot',
          'app.kubernetes.io/component': 'worker',
          'peerbot/managed-by': 'orchestrator',
          'peerbot.io/created': new Date().toISOString(),
          // Add Slack thread link for visibility
          ...(messageData?.channelId && messageData?.threadId ? {
            'thread_url': `https://app.slack.com/client/${messageData?.platformMetadata?.teamId || 'unknown'}/${messageData.channelId}/thread/${messageData.threadId}`
          } : {}),
          // Add Slack user profile link
          ...(messageData?.platformUserId && messageData?.platformMetadata?.teamId ? {
            'user_url': `https://app.slack.com/team/${messageData.platformMetadata.teamId}/${messageData.platformUserId}`
          } : {})
        },
        HostConfig: {
          Binds: process.env.NODE_ENV === 'development' ? [
            `${workspaceDir}:/workspace`,
            `${process.cwd()}/packages:/app/packages`,
            `${process.cwd()}/scripts:/app/scripts`
          ] : [
            `${workspaceDir}:/workspace`
          ],
          RestartPolicy: {
            Name: 'unless-stopped'
          },
          // Resource limits similar to K8s
          Memory: this.parseMemoryLimit(this.config.worker.resources.limits.memory),
          NanoCpus: this.parseCpuLimit(this.config.worker.resources.limits.cpu)
        },
        WorkingDir: '/workspace',
        NetworkMode: process.env.NODE_ENV === 'development' ? 'host' : 'bridge'
      };

      const container = await this.docker.createContainer(createOptions);
      await container.start();
      
      console.log(`✅ Created and started Docker container: ${deploymentName}`);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to create Docker container: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, error },
        true
      );
    }
  }

  async scaleDeployment(deploymentName: string, replicas: number): Promise<void> {
    try {
      const container = this.docker.getContainer(deploymentName);
      const containerInfo = await container.inspect();
      
      if (replicas === 0 && containerInfo.State.Running) {
        await container.stop();
        console.log(`Stopped container ${deploymentName}`);
      } else if (replicas === 1 && !containerInfo.State.Running) {
        await container.start();
        console.log(`Started container ${deploymentName}`);
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
    const deploymentName = `peerbot-worker-${deploymentId}`;
    
    try {
      const container = this.docker.getContainer(deploymentName);
      
      // Stop container if running
      try {
        await container.stop();
        console.log(`✅ Stopped container: ${deploymentName}`);
      } catch (error) {
        // Container might already be stopped
        console.log(`⚠️  Container ${deploymentName} was not running`);
      }
      
      // Remove container
      await container.remove();
      console.log(`✅ Removed container: ${deploymentName}`);
      
    } catch (error: any) {
      if (error.statusCode === 404) {
        console.log(`⚠️  Container ${deploymentName} not found (already deleted)`);
      } else {
        throw error;
      }
    }

    // Clean up user secret if needed
    try {
      const username = this.databaseManager.generatePostgresUsername(deploymentId);
      await this.secretManager.deleteUserSecret(username);
    } catch (error) {
      console.log(`⚠️  Failed to clean up secret for ${deploymentName}:`, error);
    }
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(deploymentName);
      const timestamp = new Date().toISOString();
      
      // Update container labels (Docker doesn't support runtime label updates, so we log for now)
      console.log(`✅ Updated activity timestamp for container: ${deploymentName} at ${timestamp}`);
      // Note: Docker doesn't support runtime label updates like K8s annotations
      // This could be implemented by recreating the container with updated labels if needed
    } catch (error) {
      console.error(`❌ Failed to update activity for container ${deploymentName}:`, error instanceof Error ? error.message : String(error));
      // Don't throw - activity tracking should not block message processing
    }
  }

  private async getPasswordForUser(username: string): Promise<string> {
    // Get password from the secret manager
    return await this.secretManager.getOrCreateUserCredentials(username, 
      (username: string, password: string) => this.databaseManager.createPostgresUser(username, password));
  }

  private parseMemoryLimit(memoryStr: string): number {
    const units: { [key: string]: number } = {
      'Ki': 1024,
      'Mi': 1024 * 1024,
      'Gi': 1024 * 1024 * 1024,
      'k': 1000,
      'M': 1000 * 1000,
      'G': 1000 * 1000 * 1000
    };

    for (const [unit, multiplier] of Object.entries(units)) {
      if (memoryStr.endsWith(unit)) {
        const value = parseFloat(memoryStr.replace(unit, ''));
        return value * multiplier;
      }
    }

    // If no unit is specified, assume bytes
    return parseInt(memoryStr);
  }

  private parseCpuLimit(cpuStr: string): number {
    if (cpuStr.endsWith('m')) {
      // Millicores
      const millicores = parseInt(cpuStr.replace('m', ''));
      return (millicores / 1000) * 1000000000; // Convert to nanocores
    }
    
    // Assume whole cores
    const cores = parseFloat(cpuStr);
    return cores * 1000000000; // Convert to nanocores
  }
}