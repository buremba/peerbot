/**
 * Abstract secret manager interface for cross-platform secret storage
 * Supports PostgreSQL, AWS Secrets Manager, HashiCorp Vault, and other providers
 */

export interface SecretOptions {
  userId: string;
  context?: {
    channelId?: string;
    repository?: string;
  };
}

export interface SecretValue {
  name: string;
  value: string;
  type?: "user" | "system" | "channel";
}

export interface SecretResult {
  name: string;
  value: string;
  type: string;
  source: string;
}

export interface SaveSecretResult {
  successful: string[];
  failed: string[];
}

export abstract class SecretManager {
  /**
   * Get a single secret value
   */
  abstract getSecret(
    name: string,
    options: SecretOptions
  ): Promise<string | null>;

  /**
   * Get multiple secrets with hierarchical precedence
   */
  abstract getSecrets(options: SecretOptions): Promise<Record<string, string>>;

  /**
   * Save one or more secrets
   */
  abstract saveSecrets(
    secrets: SecretValue[],
    options: SecretOptions
  ): Promise<SaveSecretResult>;

  /**
   * Delete a secret
   */
  abstract deleteSecret(
    name: string,
    options: SecretOptions
  ): Promise<void>;

  /**
   * Generate a secure password (utility method)
   */
  protected generatePassword(length: number = 32): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * Check if the secret manager is healthy and ready
   */
  abstract isHealthy(): boolean;
}