import {
  SecretManager,
  type SecretOptions,
  type SecretValue,
  type SecretResult,
  type SaveSecretResult,
} from "../abstractions/SecretManager";
import type { DatabaseAdapter } from "../database/types";
import { createLogger } from "../logging";

const logger = createLogger("postgresql-secrets");

export class PostgreSQLSecretManager extends SecretManager {
  private database: DatabaseAdapter;

  constructor(database: DatabaseAdapter) {
    super();
    this.database = database;
  }

  async getSecret(name: string, options: SecretOptions): Promise<string | null> {
    try {
      const platformUserId = options.userId.toUpperCase();
      
      return await this.database.getEnvironmentVariable({
        platformUserId,
        name,
        channelId: options.context?.channelId,
        repository: options.context?.repository,
      });
    } catch (error) {
      logger.error(`Failed to get secret ${name} for user ${options.userId}:`, error);
      return null;
    }
  }

  async getSecrets(options: SecretOptions): Promise<Record<string, string>> {
    try {
      const platformUserId = options.userId.toUpperCase();
      
      const variables = await this.database.getEnvironmentVariables({
        platformUserId,
        channelId: options.context?.channelId,
        repository: options.context?.repository,
      });

      // Convert array to object
      const result: Record<string, string> = {};
      for (const variable of variables) {
        result[variable.name] = variable.value;
      }
      
      return result;
    } catch (error) {
      logger.error(`Failed to get secrets for user ${options.userId}:`, error);
      return {};
    }
  }

  async saveSecrets(
    secrets: SecretValue[],
    options: SecretOptions
  ): Promise<SaveSecretResult> {
    try {
      const platformUserId = options.userId.toUpperCase();

      // Ensure user exists first
      await this.database.ensureUser(platformUserId);

      const result = await this.database.saveEnvironmentVariables({
        platformUserId,
        channelId: options.context?.channelId,
        repository: options.context?.repository,
        variables: secrets.map(secret => ({
          name: secret.name,
          value: secret.value,
          type: secret.type || "user",
        })),
      });

      logger.info(`Saved ${result.successful.length} secrets for user ${options.userId}`);
      if (result.failed.length > 0) {
        logger.warn(`Failed to save ${result.failed.length} secrets: ${result.failed.join(", ")}`);
      }

      return result;
    } catch (error) {
      logger.error(`Failed to save secrets for user ${options.userId}:`, error);
      const failedNames = secrets.map(s => s.name);
      return {
        successful: [],
        failed: failedNames,
      };
    }
  }

  async deleteSecret(name: string, options: SecretOptions): Promise<void> {
    try {
      const platformUserId = options.userId.toUpperCase();
      
      await this.database.deleteEnvironmentVariable({
        platformUserId,
        name,
        channelId: options.context?.channelId,
        repository: options.context?.repository,
      });

      logger.info(`Deleted secret ${name} for user ${options.userId}`);
    } catch (error) {
      logger.error(`Failed to delete secret ${name} for user ${options.userId}:`, error);
      throw error;
    }
  }

  isHealthy(): boolean {
    // Check if database connection is available
    try {
      return this.database !== null && this.database !== undefined;
    } catch {
      return false;
    }
  }
}