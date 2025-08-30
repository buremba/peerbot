import { DatabasePool } from '../db-connection-pool';
import { DatabaseManager } from '../db-operations';
import { BaseSecretManager } from './BaseSecretManager';
import { OrchestratorConfig, OrchestratorError, ErrorCode } from '../types';
import { DevcontainerBuilder } from '../devcontainer-builder';

export interface DeploymentInfo {
  deploymentName: string;
  deploymentId: string;
  lastActivity: Date;
  minutesIdle: number;
  daysSinceActivity: number;
  replicas: number;
  isIdle: boolean;
  isVeryOld: boolean;
}

export abstract class BaseDeploymentManager {
  protected config: OrchestratorConfig;
  protected dbPool: DatabasePool;
  public databaseManager: DatabaseManager;
  protected secretManager: BaseSecretManager;
  public devcontainerBuilder: DevcontainerBuilder;

  constructor(config: OrchestratorConfig, dbPool: DatabasePool, secretManager: BaseSecretManager) {
    this.config = config;
    this.dbPool = dbPool;
    this.databaseManager = new DatabaseManager(dbPool);
    this.secretManager = secretManager;
    this.devcontainerBuilder = new DevcontainerBuilder();
  }

  // Abstract methods that must be implemented by concrete classes
  abstract listDeployments(): Promise<DeploymentInfo[]>;
  abstract createDeployment(deploymentName: string, username: string, userId: string, messageData?: any, imageName?: string): Promise<void>;
  abstract scaleDeployment(deploymentName: string, replicas: number): Promise<void>;
  abstract deleteDeployment(deploymentId: string): Promise<void>;
  abstract updateDeploymentActivity(deploymentName: string): Promise<void>;

  /**
   * Create worker deployment for handling messages
   */
  async createWorkerDeployment(
    userId: string, 
    threadId: string, 
    teamId?: string, 
    messageData?: any, 
    onProgress?: (message: string) => void
  ): Promise<void> {
    const deploymentName = `peerbot-worker-${threadId}`;
    
    try {
      // Always ensure user credentials exist first
      const username = this.databaseManager.generatePostgresUsername(userId);
      
      // Check if secret already exists and get existing password, or generate new one
      await this.secretManager.getOrCreateUserCredentials(username, 
        (username: string, password: string) => this.databaseManager.createPostgresUser(username, password));

      // Check if deployment already exists by getting the list and filtering
      const deployments = await this.listDeployments();
      const existingDeployment = deployments.find(d => d.deploymentName === deploymentName);
      
      if (existingDeployment) {
        await this.scaleDeployment(deploymentName, 1);
        return;
      }

      let imageName: string | undefined;

      // Build custom image if repository URL is provided
      const repositoryUrl = messageData?.platformMetadata?.repositoryUrl;
      if (repositoryUrl) {
        try {
          const buildResult = await this.devcontainerBuilder.build(repositoryUrl, onProgress);
          imageName = buildResult.imageName;
          
          onProgress?.(`✅ Built custom image: ${buildResult.imageName} (${buildResult.hasDevcontainer ? 'devcontainer' : 'default'})`);
        } catch (error) {
          console.warn(`Failed to build custom image for ${repositoryUrl}, using default:`, error);
          onProgress?.(`⚠️ Using default image (custom build failed)`);
          // Continue with default image
        }
      }

      await this.createDeployment(deploymentName, username, userId, messageData, imageName);
      
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to create worker deployment: ${error instanceof Error ? error.message : String(error)}`,
        { userId, threadId, error },
        true
      );
    }
  }

  /**
   * Generate environment variables common to all deployment types
   */
  protected generateEnvironmentVariables(username: string, userId: string, deploymentName: string, messageData?: any, includeSecrets: boolean = true): { [key: string]: string } {
    const envVars: { [key: string]: string } = {
      'WORKER_MODE': 'queue',
      'USER_ID': userId,
      'DEPLOYMENT_NAME': deploymentName,
      'SESSION_KEY': messageData?.agentSessionId || `session-${userId}-${Date.now()}`,
      'CHANNEL_ID': messageData?.channelId || '',
      'REPOSITORY_URL': messageData?.platformMetadata?.repositoryUrl || process.env.GITHUB_REPOSITORY || 'https://github.com/anthropics/claude-code-examples',
      'ORIGINAL_MESSAGE_TS': messageData?.platformMetadata?.originalMessageTs || messageData?.messageId || '',
      'LOG_LEVEL': 'info',
      'WORKSPACE_PATH': '/workspace',
      'SLACK_TEAM_ID': messageData?.platformMetadata?.teamId || '',
      'SLACK_CHANNEL_ID': messageData?.channelId || '',
      'SLACK_THREAD_TS': messageData?.threadId || ''
    };

    // Add optional environment variables only if they exist
    if (messageData?.platformMetadata?.botResponseTs) {
      envVars['BOT_RESPONSE_TS'] = messageData.platformMetadata.botResponseTs;
    }

    // Include secrets from process.env for Docker deployments
    if (includeSecrets) {
      if (process.env.GITHUB_TOKEN) {
        envVars['GITHUB_TOKEN'] = process.env.GITHUB_TOKEN;
      }

      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        envVars['CLAUDE_CODE_OAUTH_TOKEN'] = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }

    if (process.env.CLAUDE_ALLOWED_TOOLS) {
      envVars['CLAUDE_ALLOWED_TOOLS'] = process.env.CLAUDE_ALLOWED_TOOLS;
    }

    if (process.env.CLAUDE_DISALLOWED_TOOLS) {
      envVars['CLAUDE_DISALLOWED_TOOLS'] = process.env.CLAUDE_DISALLOWED_TOOLS;
    }

    if (process.env.CLAUDE_TIMEOUT_MINUTES) {
      envVars['CLAUDE_TIMEOUT_MINUTES'] = process.env.CLAUDE_TIMEOUT_MINUTES;
    }

    // Add worker environment variables from configuration
    if (this.config.worker.env) {
      Object.entries(this.config.worker.env).forEach(([key, value]) => {
        envVars[key] = String(value);
      });
    }

    return envVars;
  }

  /**
   * Delete a worker deployment and associated resources
   */
  async deleteWorkerDeployment(deploymentId: string): Promise<void> {
    try {
      const deploymentName = `peerbot-worker-${deploymentId}`;
      
      await this.deleteDeployment(deploymentId);
      
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_DELETE_FAILED,
        `Failed to delete deployment for ${deploymentId}: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentId, error },
        true
      );
    }
  }

  /**
   * Reconcile deployments: unified method for cleanup and resource management
   * This method uses the abstract methods to work with any deployment backend
   */
  async reconcileDeployments(): Promise<void> {
    try {
      const maxDeployments = this.config.worker.maxDeployments;

      console.log('🔄 Running deployment cleanup...');
      
      // Get all worker deployments from the backend
      const activeDeployments = await this.listDeployments();

      if (activeDeployments.length === 0) {
        return;
      }

      // Sort deployments by last activity (oldest first)
      const sortedDeployments = [...activeDeployments].sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());
      
      let processedCount = 0;
      
      // Process each deployment based on its state
      for (const analysis of sortedDeployments) {
        const { deploymentName, deploymentId, minutesIdle, daysSinceActivity, replicas, isIdle, isVeryOld } = analysis;
        
        if (isVeryOld) {
          // Delete very old deployments (>= 7 days)
          try {
            await this.deleteWorkerDeployment(deploymentId);
            processedCount++;
          } catch (error) {
            console.error(`❌ Failed to delete deployment ${deploymentName}:`, error);
          }
        } else if (isIdle && replicas > 0) {
          // Scale down idle deployments
          try {
            await this.scaleDeployment(deploymentName, 0);
            processedCount++;
          } catch (error) {
            console.error(`❌ Failed to scale down deployment ${deploymentName}:`, error);
          }
        }
      }
      
      // Check if we exceed max deployments (after cleanup)
      const remainingDeployments = sortedDeployments.filter(d => !d.isVeryOld);
      if (remainingDeployments.length > maxDeployments) {
        const excessCount = remainingDeployments.length - maxDeployments;
        
        const deploymentsToDelete = remainingDeployments.slice(0, excessCount);
        for (const { deploymentName, deploymentId } of deploymentsToDelete) {
          try {
            await this.deleteWorkerDeployment(deploymentId);
            processedCount++;
          } catch (error) {
            console.error(`❌ Failed to remove deployment ${deploymentName}:`, error);
          }
        }
      }
      
      if (processedCount > 0) {
        console.log(`✅ Cleanup completed: processed ${processedCount} deployment(s)`);
      }
      
    } catch (error) {
      console.error('Error during deployment reconciliation:', error instanceof Error ? error.message : String(error));
    }
  }
}