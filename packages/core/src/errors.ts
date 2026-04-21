/**
 * Base error class for all lobu errors
 */
export abstract class BaseError extends Error {
  abstract readonly name: string;
  public operation?: string;

  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message);

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Get the full error chain as a string
   */
  getFullMessage(): string {
    let message = `${this.name}: ${this.message}`;
    if (this.cause) {
      if (this.cause instanceof BaseError) {
        message += `\nCaused by: ${this.cause.getFullMessage()}`;
      } else {
        message += `\nCaused by: ${this.cause.message}`;
      }
    }
    return message;
  }

  /**
   * Convert error to JSON for logging/serialization
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      ...(this.operation && { operation: this.operation }),
      cause:
        this.cause instanceof BaseError
          ? this.cause.toJSON()
          : this.cause?.message,
      stack: this.stack,
    };
  }
}

/**
 * Error class for worker-related operations
 */
export class WorkerError extends BaseError {
  override readonly name = "WorkerError";

  constructor(operation: string, message: string, cause?: Error) {
    super(message, cause);
    this.operation = operation;
  }
}

/**
 * Error class for workspace-related operations
 */
export class WorkspaceError extends BaseError {
  override readonly name = "WorkspaceError";

  constructor(operation: string, message: string, cause?: Error) {
    super(message, cause);
    this.operation = operation;
  }
}

/**
 * Error class for platform-related operations (Slack, WhatsApp, etc.)
 */
export class PlatformError extends BaseError {
  override readonly name = "PlatformError";

  constructor(
    public platform: string,
    operation: string,
    message: string,
    cause?: Error
  ) {
    super(message, cause);
    this.operation = operation;
  }

  override toJSON(): Record<string, any> {
    return {
      ...super.toJSON(),
      platform: this.platform,
    };
  }
}

/**
 * Error class for session-related operations
 */
export class SessionError extends BaseError {
  readonly name = "SessionError";

  constructor(
    public sessionKey: string,
    public code: string,
    message: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  toJSON(): Record<string, any> {
    return {
      ...super.toJSON(),
      sessionKey: this.sessionKey,
      code: this.code,
    };
  }
}

// ErrorCode enum for orchestration operations
export enum ErrorCode {
  DATABASE_CONNECTION_FAILED = "DATABASE_CONNECTION_FAILED",
  KUBERNETES_API_ERROR = "KUBERNETES_API_ERROR",
  DEPLOYMENT_SCALE_FAILED = "DEPLOYMENT_SCALE_FAILED",
  DEPLOYMENT_CREATE_FAILED = "DEPLOYMENT_CREATE_FAILED",
  DEPLOYMENT_DELETE_FAILED = "DEPLOYMENT_DELETE_FAILED",
  QUEUE_JOB_PROCESSING_FAILED = "QUEUE_JOB_PROCESSING_FAILED",
  USER_CREDENTIALS_CREATE_FAILED = "USER_CREDENTIALS_CREATE_FAILED",
  INVALID_CONFIGURATION = "INVALID_CONFIGURATION",
  THREAD_DEPLOYMENT_NOT_FOUND = "THREAD_DEPLOYMENT_NOT_FOUND",
  USER_QUEUE_NOT_FOUND = "USER_QUEUE_NOT_FOUND",
}

/**
 * Error class for orchestrator-related operations
 */
export class OrchestratorError extends BaseError {
  readonly name = "OrchestratorError";

  constructor(
    public code: ErrorCode,
    message: string,
    public details?: any,
    public shouldRetry: boolean = false,
    cause?: Error
  ) {
    super(message, cause);
  }

  static fromDatabaseError(error: any): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.DATABASE_CONNECTION_FAILED,
      `Database error: ${error instanceof Error ? error.message : String(error)}`,
      { code: error.code, detail: error.detail },
      true,
      error
    );
  }

  static fromKubernetesError(error: any): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.KUBERNETES_API_ERROR,
      `Kubernetes operation failed: ${error.message}`,
      error,
      true,
      error
    );
  }

  toJSON(): Record<string, any> {
    return {
      ...super.toJSON(),
      code: this.code,
      details: this.details,
      shouldRetry: this.shouldRetry,
    };
  }
}

/**
 * Error class for configuration-related operations
 */
export class ConfigError extends BaseError {
  readonly name = "ConfigError";
}
