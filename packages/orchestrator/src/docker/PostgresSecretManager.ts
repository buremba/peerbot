import { BaseSecretManager } from "../base/BaseSecretManager";
import type { DatabaseAdapter } from "@peerbot/shared";
import {
  ErrorCode,
  type OrchestratorConfig,
  OrchestratorError,
} from "../types";
import { createLogger } from "@peerbot/shared";

const logger = createLogger("orchestrator");

export class PostgresSecretManager extends BaseSecretManager {
  private database: DatabaseAdapter;

  constructor(config: OrchestratorConfig, database: DatabaseAdapter) {
    super(config);
    this.database = database;
  }

  /**
   * Get existing password from database or create new user credentials
   */
  async getOrCreateUserCredentials(
    username: string,
    createPostgresUser: (username: string, password: string) => Promise<void>
  ): Promise<string> {
    try {
      // First ensure the user exists in the users table
      const platformUserId = username.toUpperCase();
      await this.database.ensureUser(platformUserId);

      const existingPassword = await this.database.getEnvironmentVariable({
        platformUserId,
        name: "PEERBOT_DATABASE_PASSWORD",
      });

      if (existingPassword) {
        logger.info(`Found existing credentials for user ${username}`);
        return existingPassword;
      }
    } catch (error) {
      logger.error(
        `Error reading existing credentials for ${username}, creating new ones:`,
        error
      );
    }

    // Generate new credentials
    const password = this.generatePassword();

    logger.info(`Creating new credentials for user ${username}`);
    await createPostgresUser(username, password);
    await this.storeUserCredentials(username, password);
    return password;
  }

  /**
   * Store user credentials in database as individual environment variables
   * This is a private method that should only be called from getOrCreateUserCredentials
   */
  async storeUserCredentials(
    username: string,
    password: string
  ): Promise<void> {
    try {
      // First get the user_id from the users table
      const platformUserId = username.toUpperCase();

      const result = await this.database.saveEnvironmentVariables({
        platformUserId,
        variables: [
          {
            name: "PEERBOT_DATABASE_USERNAME",
            value: username,
            type: "system",
          },
          {
            name: "PEERBOT_DATABASE_PASSWORD",
            value: password,
            type: "system",
          },
        ],
      });

      if (result.failed.length > 0) {
        throw new Error(
          `Failed to store credentials: ${result.failed.join(", ")}`
        );
      }

      logger.info(
        `✅ Stored permanent credentials in database for user: ${username}`
      );
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to store user credentials in database: ${error instanceof Error ? error.message : String(error)}`,
        { username, error },
        true
      );
    }
  }
}
