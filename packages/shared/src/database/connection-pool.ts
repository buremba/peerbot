import { Pool, type PoolClient } from "pg";
import { createLogger } from "../logger";

const logger = createLogger("shared");

export interface DatabasePoolConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export interface DatabaseQueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseSession {
  query<T = any>(text: string, params?: any[]): Promise<DatabaseQueryResult<T>>;
  release(): Promise<void> | void;
}

export interface DatabaseClient {
  acquireSession(): Promise<DatabaseSession>;
  query<T = any>(text: string, params?: any[]): Promise<DatabaseQueryResult<T>>;
  queryWithUserContext<T = any>(
    userId: string,
    text: string,
    params?: any[]
  ): Promise<DatabaseQueryResult<T>>;
  transactionWithUserContext<T>(
    userId: string,
    callback: (session: DatabaseSession) => Promise<T>
  ): Promise<T>;
  close(): Promise<void>;
  getPool(): Pool;
}

/**
 * Generic database error for shared utilities
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public originalError?: any,
    public shouldRetry: boolean = false
  ) {
    super(message);
    this.name = "DatabaseError";
  }

  static fromError(error: any): DatabaseError {
    return new DatabaseError(
      `Database error: ${error instanceof Error ? error.message : String(error)}`,
      error,
      true
    );
  }
}

class PostgresDatabaseSession implements DatabaseSession {
  constructor(private client: PoolClient) {}

  async query<T = any>(
    text: string,
    params?: any[]
  ): Promise<DatabaseQueryResult<T>> {
    try {
      const result = await this.client.query(text, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? result.rows.length ?? 0,
      };
    } catch (error) {
      throw DatabaseError.fromError(error);
    }
  }

  async release(): Promise<void> {
    this.client.release();
  }
}

export class DatabasePool implements DatabaseClient {
  private pool: Pool;

  constructor(config: DatabasePoolConfig | string) {
    const dbConfig =
      typeof config === "string" ? { connectionString: config } : config;

    this.pool = new Pool({
      connectionString: dbConfig.connectionString,
      max: dbConfig.max ?? 20,
      idleTimeoutMillis: dbConfig.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: dbConfig.connectionTimeoutMillis ?? 10000,
    });

    this.pool.on("error", (err) => {
      logger.error("Database pool error:", err);
    });
  }

  async acquireSession(): Promise<DatabaseSession> {
    try {
      const client = await this.pool.connect();
      return new PostgresDatabaseSession(client);
    } catch (error) {
      throw DatabaseError.fromError(error);
    }
  }

  async query<T = any>(
    text: string,
    params?: any[]
  ): Promise<DatabaseQueryResult<T>> {
    try {
      const result = await this.pool.query(text, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? result.rows.length ?? 0,
      };
    } catch (error) {
      throw DatabaseError.fromError(error);
    }
  }

  async queryWithUserContext<T = any>(
    userId: string,
    text: string,
    params?: any[]
  ): Promise<DatabaseQueryResult<T>> {
    const session = await this.acquireSession();
    try {
      await session.query("SELECT set_config($1, $2, true)", [
        "app.current_user_id",
        userId,
      ]);
      return await session.query<T>(text, params);
    } catch (error) {
      throw DatabaseError.fromError(error);
    } finally {
      await session.release();
    }
  }

  async transactionWithUserContext<T>(
    userId: string,
    callback: (client: DatabaseSession) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    const session = new PostgresDatabaseSession(client);

    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config($1, $2, true)", [
        "app.current_user_id",
        userId,
      ]);
      const result = await callback(session);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw DatabaseError.fromError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Get the underlying pg.Pool instance for compatibility
   */
  getPool(): Pool {
    return this.pool;
  }
}

// Simple factory function for backward compatibility with dispatcher
let globalPool: Pool | null = null;

export function getDbPool(connectionString?: string): Pool {
  if (!globalPool) {
    globalPool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
    });
    
    globalPool.on("error", (err) => {
      logger.error("Global database pool error:", err);
    });
  }
  return globalPool;
}

export async function closeGlobalPool(): Promise<void> {
  if (globalPool) {
    await globalPool.end();
    globalPool = null;
  }
}

export function createDatabaseClient(
  config: DatabasePoolConfig | string
): DatabaseClient {
  return new DatabasePool(config);
}
