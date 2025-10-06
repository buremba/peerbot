import type { SecretManager } from "../abstractions/SecretManager";
import { PostgreSQLSecretManager } from "../implementations/PostgreSQLSecretManager";
import type { DatabaseAdapter } from "../database/operations";

export interface SecretManagerConfig {
  provider: "postgresql" | "aws" | "vault" | "k8s";
  database?: DatabaseAdapter;
  // Future configs for other providers
  awsRegion?: string;
  vaultUrl?: string;
  vaultToken?: string;
}

export function createSecretManager(config: SecretManagerConfig): SecretManager {
  switch (config.provider) {
    case "postgresql":
      if (!config.database) {
        throw new Error("Database adapter is required for PostgreSQL secret manager");
      }
      return new PostgreSQLSecretManager(config.database);
    
    case "aws":
      throw new Error("AWS Secrets Manager not yet implemented");
    
    case "vault":
      throw new Error("HashiCorp Vault secret manager not yet implemented");
    
    case "k8s":
      throw new Error("Kubernetes secrets not yet implemented");
    
    default:
      throw new Error(`Unsupported secret manager provider: ${config.provider}`);
  }
}