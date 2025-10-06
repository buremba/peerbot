import { createLogger } from "../logger";
import { encrypt, decrypt } from "../utils/encryption";
import {
  createDatabaseClient,
  type DatabaseClient,
  type DatabasePoolConfig,
} from "./connection-pool";

const logger = createLogger("database");

type EnvironmentType = "user" | "channel" | "system";

export interface SaveEnvironmentVariableInput {
  name: string;
  value: string;
  channelId?: string | null;
  repository?: string | null;
  type?: EnvironmentType;
  encrypt?: boolean;
}

export interface SaveEnvironmentVariablesOptions {
  platformUserId: string;
  platform?: string;
  variables: SaveEnvironmentVariableInput[];
  defaultType?: EnvironmentType;
  channelId?: string | null;
  repository?: string | null;
}

export interface SaveEnvironmentVariablesResult {
  stored: string[];
  failed: string[];
}

export interface GetEnvironmentVariablesOptions {
  platformUserId: string;
  platform?: string;
  channelId?: string | null;
  repository?: string | null;
}

export interface GetEnvironmentVariableOptions
  extends GetEnvironmentVariablesOptions {
  name: string;
  decryptValue?: boolean;
}

export interface DatabaseAdapter {
  close(): Promise<void>;
  ping(): Promise<void>;
  ensureUser(platformUserId: string, platform?: string): Promise<string>;
  getUserId(
    platformUserId: string,
    platform?: string
  ): Promise<string | null>;
  getEnvironmentVariables(
    options: GetEnvironmentVariablesOptions
  ): Promise<Record<string, string>>;
  getEnvironmentVariable(
    options: GetEnvironmentVariableOptions
  ): Promise<string | null>;
  saveEnvironmentVariables(
    options: SaveEnvironmentVariablesOptions
  ): Promise<SaveEnvironmentVariablesResult>;
  deleteEnvironmentVariable(
    options: GetEnvironmentVariableOptions
  ): Promise<void>;
  updateJobStatus(
    jobId: string,
    status: string,
    output?: any,
    errorMessage?: string
  ): Promise<void>;
  createIsolatedQueueUser(username: string, password: string): Promise<void>;
}

function normalizePlatform(platform?: string): string {
  return platform ?? "slack";
}

function normalizePlatformUserId(platform: string, userId: string): string {
  if (platform === "slack") {
    return userId.toUpperCase();
  }
  return userId;
}

class PostgresDatabaseAdapter implements DatabaseAdapter {
  constructor(private readonly client: DatabaseClient) {}

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<void> {
    await this.client.query("SELECT 1");
  }

  async ensureUser(platformUserId: string, platform?: string): Promise<string> {
    const normalizedPlatform = normalizePlatform(platform);
    const normalizedUserId = normalizePlatformUserId(
      normalizedPlatform,
      platformUserId
    );

    const result = await this.client.query<{ id: string }>(
      `INSERT INTO users (platform, platform_user_id, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (platform, platform_user_id)
       DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [normalizedPlatform, normalizedUserId]
    );

    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error(
        `Failed to ensure user ${normalizedUserId} on platform ${normalizedPlatform}`
      );
    }
    return String(id);
  }

  async getUserId(
    platformUserId: string,
    platform?: string
  ): Promise<string | null> {
    const normalizedPlatform = normalizePlatform(platform);
    const normalizedUserId = normalizePlatformUserId(
      normalizedPlatform,
      platformUserId
    );

    const result = await this.client.query<{ id: string }>(
      `SELECT id FROM users WHERE platform = $1 AND platform_user_id = $2`,
      [normalizedPlatform, normalizedUserId]
    );

    return result.rows[0]?.id ? String(result.rows[0].id) : null;
  }

  async getEnvironmentVariables(
    options: GetEnvironmentVariablesOptions
  ): Promise<Record<string, string>> {
    const platform = normalizePlatform(options.platform);
    const userId = await this.getUserId(options.platformUserId, platform);
    if (!userId) {
      logger.warn(
        `User ${normalizePlatformUserId(platform, options.platformUserId)} not found when fetching environment`
      );
      return {};
    }

    const isChannelContext =
      options.channelId && !options.channelId.startsWith("D");
    const channelId = isChannelContext ? options.channelId : null;
    const repository = options.repository ?? null;

    const query = `
      WITH prioritized AS (
        SELECT
          name,
          value,
          channel_id,
          repository,
          CASE
            WHEN channel_id = $2 AND repository = $3 THEN 1
            WHEN channel_id = $2 AND repository IS NULL THEN 2
            WHEN channel_id IS NULL AND repository = $3 THEN 3
            WHEN channel_id IS NULL AND repository IS NULL THEN 4
          END as priority
        FROM user_environ
        WHERE user_id = $1
          AND (
            (channel_id = $2 AND repository = $3) OR
            (channel_id = $2 AND repository IS NULL) OR
            (channel_id IS NULL AND repository = $3) OR
            (channel_id IS NULL AND repository IS NULL)
          )
      )
      SELECT DISTINCT ON (name) name, value
      FROM prioritized
      ORDER BY name, priority`;

    const result = await this.client.query<{ name: string; value: string | null }>(
      query,
      [userId, channelId, repository]
    );

    const envVars: Record<string, string> = {};
    for (const row of result.rows) {
      if (row.value == null) {
        continue;
      }
      try {
        envVars[row.name] = decrypt(row.value);
      } catch (error) {
        logger.warn(
          `Failed to decrypt environment variable ${row.name}, returning raw value`,
          error
        );
        envVars[row.name] = row.value;
      }
    }

    return envVars;
  }

  async getEnvironmentVariable(
    options: GetEnvironmentVariableOptions
  ): Promise<string | null> {
    const env = await this.getEnvironmentVariables(options);
    const value = env[options.name];

    if (value && options.decryptValue === false) {
      return value;
    }
    return value ?? null;
  }

  async saveEnvironmentVariables(
    options: SaveEnvironmentVariablesOptions
  ): Promise<SaveEnvironmentVariablesResult> {
    if (!options.variables.length) {
      return { stored: [], failed: [] };
    }

    const platform = normalizePlatform(options.platform);
    const userId = await this.ensureUser(options.platformUserId, platform);
    const stored: string[] = [];
    const failed: string[] = [];

    for (const variable of options.variables) {
      try {
        const type = variable.type ?? options.defaultType ?? "user";
        const channelId =
          variable.channelId ?? options.channelId ?? null;
        const repository =
          variable.repository ?? options.repository ?? null;
        const shouldEncrypt = variable.encrypt ?? true;
        const value = shouldEncrypt ? encrypt(variable.value) : variable.value;

        await this.client.query(
          `INSERT INTO user_environ (user_id, channel_id, repository, name, value, type, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           ON CONFLICT (user_id, channel_id, repository, name)
           DO UPDATE SET value = EXCLUDED.value, type = EXCLUDED.type, updated_at = NOW()`,
          [userId, channelId, repository, variable.name, value, type]
        );

        stored.push(variable.name);
      } catch (error) {
        logger.error(
          `Failed to store environment variable ${variable.name}:`,
          error
        );
        failed.push(variable.name);
      }
    }

    return { stored, failed };
  }

  async deleteEnvironmentVariable(
    options: GetEnvironmentVariableOptions
  ): Promise<void> {
    try {
      await this.client.query(
        `DELETE FROM user_environ 
         WHERE user_id = (SELECT id FROM users WHERE platform_user_id = $1 AND platform = $2)
           AND name = $3
           AND ($4::varchar IS NULL OR channel_id = $4)
           AND ($5::varchar IS NULL OR repository = $5)`,
        [
          options.platformUserId,
          normalizePlatform(options.platform),
          options.name,
          options.channelId || null,
          options.repository || null,
        ]
      );
      logger.debug(
        `Deleted environment variable ${options.name} for user ${options.platformUserId}`
      );
    } catch (error) {
      logger.error(
        `Failed to delete environment variable ${options.name}:`,
        error
      );
      throw error;
    }
  }

  async updateJobStatus(
    jobId: string,
    status: string,
    output?: any,
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.client.query("SELECT update_job_status($1, $2, $3, $4)", [
        jobId,
        status,
        output ? JSON.stringify(output) : null,
        errorMessage ?? null,
      ]);
    } catch (error) {
      logger.error(`Failed to update job status for ${jobId}:`, error);
    }
  }

  async createIsolatedQueueUser(
    username: string,
    password: string
  ): Promise<void> {
    await this.client.query(
      "SELECT create_isolated_pgboss_user($1, $2)",
      [username, password]
    );
  }
}

export class DatabaseManager {
  constructor(private readonly adapter: DatabaseAdapter) {}

  generatePostgresUsername(userId: string): string {
    return userId.toLowerCase().substring(0, 63);
  }

  async createPostgresUser(username: string, password: string): Promise<void> {
    try {
      await this.adapter.createIsolatedQueueUser(username, password);
      logger.info(`Ensured isolated pgboss user exists: ${username}`);
    } catch (error) {
      logger.error(
        `Failed to create or update PostgreSQL user ${username}:`,
        error
      );
      throw error;
    }
  }
}

export function createDatabaseAdapter(
  config: DatabasePoolConfig | string
): DatabaseAdapter {
  const client = createDatabaseClient(config);
  return new PostgresDatabaseAdapter(client);
}
