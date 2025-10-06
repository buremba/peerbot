import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DatabasePool,
  DatabaseError,
  getDbPool,
  createDatabaseClient,
  type DatabaseClient,
  type DatabasePoolConfig,
} from "../../database/connection-pool";

describe("DatabasePool", () => {
  let dbPool: DatabasePool;
  const testConfig: DatabasePoolConfig = {
    connectionString: "postgresql://test:test@localhost:5432/test",
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  };

  beforeEach(() => {
    dbPool = new DatabasePool(testConfig);
  });

  afterEach(async () => {
    await dbPool.close();
  });

  it("should create database pool with config", () => {
    expect(dbPool).toBeDefined();
    expect(dbPool.getPool()).toBeDefined();
  });

  it("should create database pool with connection string", () => {
    const pool = new DatabasePool("postgresql://test:test@localhost:5432/test");
    expect(pool).toBeDefined();
    expect(pool.getPool()).toBeDefined();
  });

  it("should handle DatabaseError correctly", () => {
    const originalError = new Error("Connection failed");
    const dbError = DatabaseError.fromError(originalError);

    expect(dbError).toBeInstanceOf(DatabaseError);
    expect(dbError.name).toBe("DatabaseError");
    expect(dbError.shouldRetry).toBe(true);
    expect(dbError.originalError).toBe(originalError);
    expect(dbError.message).toContain("Connection failed");
  });

  it("should create DatabaseError with custom settings", () => {
    const dbError = new DatabaseError("Custom error", null, false);

    expect(dbError.name).toBe("DatabaseError");
    expect(dbError.message).toBe("Custom error");
    expect(dbError.shouldRetry).toBe(false);
    expect(dbError.originalError).toBe(null);
  });
});

describe("getDbPool factory function", () => {
  it("should create a pool with connection string", () => {
    const pool = getDbPool("postgresql://test:test@localhost:5432/test");
    expect(pool).toBeDefined();
  });

  it("should use environment variable when no connection string provided", () => {
    const originalEnv = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://env:env@localhost:5432/env_test";

    const pool = getDbPool();
    expect(pool).toBeDefined();

    // Restore original env
    process.env.DATABASE_URL = originalEnv;
  });
});

describe("createDatabaseClient", () => {
  it("should create a database client instance", async () => {
    const client: DatabaseClient = createDatabaseClient(
      "postgresql://test:test@localhost:5432/test"
    );

    expect(client).toBeDefined();
    expect(typeof client.query).toBe("function");

    await client.close();
  });
});
