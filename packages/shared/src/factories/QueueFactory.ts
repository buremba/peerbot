import type { MessageQueue } from "../abstractions/MessageQueue";
import { PostgreSQLMessageQueue } from "../implementations/PostgreSQLMessageQueue";

export interface QueueConfig {
  provider: "postgresql" | "redis" | "sqs";
  connectionString?: string;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
  retentionDays?: number;
  deleteAfterDays?: number;
}

export function createMessageQueue(config: QueueConfig): MessageQueue {
  switch (config.provider) {
    case "postgresql":
      if (!config.connectionString) {
        throw new Error("PostgreSQL connection string is required");
      }
      return new PostgreSQLMessageQueue({
        connectionString: config.connectionString,
        retryLimit: config.retryLimit,
        retryDelay: config.retryDelay,
        expireInSeconds: config.expireInSeconds,
        retentionDays: config.retentionDays,
        deleteAfterDays: config.deleteAfterDays,
      });
    
    case "redis":
      throw new Error("Redis message queue not yet implemented");
    
    case "sqs":
      throw new Error("SQS message queue not yet implemented");
    
    default:
      throw new Error(`Unsupported message queue provider: ${config.provider}`);
  }
}