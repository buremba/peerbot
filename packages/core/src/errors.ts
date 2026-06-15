/** Base error class for all lobu errors. */
export abstract class BaseError extends Error {
  abstract readonly name: string;
  public operation?: string;

  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message);
    // Maintain proper prototype chain for instanceof checks.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Render the error chain as a single string. */
  getFullMessage(): string {
    if (!this.cause) return `${this.name}: ${this.message}`;
    const causeMsg =
      this.cause instanceof BaseError
        ? this.cause.getFullMessage()
        : this.cause.message;
    return `${this.name}: ${this.message}\nCaused by: ${causeMsg}`;
  }

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

export class WorkerError extends BaseError {
  override readonly name = "WorkerError";

  constructor(operation: string, message: string, cause?: Error) {
    super(message, cause);
    this.operation = operation;
  }
}

export class WorkspaceError extends BaseError {
  override readonly name = "WorkspaceError";

  constructor(operation: string, message: string, cause?: Error) {
    super(message, cause);
    this.operation = operation;
  }
}

export enum ErrorCode {
  DATABASE_CONNECTION_FAILED = "DATABASE_CONNECTION_FAILED",
  DEPLOYMENT_CREATE_FAILED = "DEPLOYMENT_CREATE_FAILED",
  DEPLOYMENT_DELETE_FAILED = "DEPLOYMENT_DELETE_FAILED",
  QUEUE_JOB_PROCESSING_FAILED = "QUEUE_JOB_PROCESSING_FAILED",
}

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
    // `error` can be null/undefined/primitive (e.g. `throw null`, or a pg pool
    // that rejects with no value mid-query). Reading `.code`/`.detail` off a
    // non-object would TypeError and replace the real DB failure with a
    // confusing "Cannot read properties of null" stack.
    const isObjectLike = typeof error === "object" && error !== null;
    const message = error instanceof Error ? error.message : String(error);
    return new OrchestratorError(
      ErrorCode.DATABASE_CONNECTION_FAILED,
      `Database error: ${message}`,
      isObjectLike ? { code: error.code, detail: error.detail } : undefined,
      true,
      error instanceof Error ? error : undefined
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
 * Thrown when a worker spawn is declined because another replica already holds
 * the per-conversation lock for this turn — i.e. another pod legitimately OWNS
 * this conversation turn and is running it to completion.
 *
 * This is NOT a failure. It is the cross-pod "handled elsewhere" signal. Under
 * N>1 app replicas both pods drain the shared `thread_message` queue and race to
 * spawn the same per-conversation worker; exactly one wins the advisory lock.
 * The loser MUST drop silently — no user-facing error, no Critical log, no
 * retry (the winner holds the lock for the entire worker subprocess lifetime, so
 * retrying can never win). The winning pod discharges the shared turn-liveness
 * marker on its successful reply, so the user still receives the answer.
 *
 * Distinguished by type (not a magic message string) so the orchestrator can
 * tell "owned by another pod" apart from a genuine worker-startup failure (OOM,
 * spawn failure, bad config) which MUST still surface an error to the user.
 */
export class ConversationOwnedElsewhereError extends BaseError {
  readonly name = "ConversationOwnedElsewhereError";
}

export class ConfigError extends BaseError {
  readonly name = "ConfigError";
}
