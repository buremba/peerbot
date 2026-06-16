class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ValidationError";
  }
}

export class ApiError extends CliError {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message, 3);
    this.name = "ApiError";
  }
}

/**
 * Parse `raw` as a JSON object, throwing {@link ValidationError} when it is not
 * valid JSON or not a top-level object (arrays and primitives are rejected).
 * `label` names the source for the error messages, e.g. `"on stdin"` or
 * `` `in ${path}` ``.
 */
export function parseJsonObject(
  raw: string,
  label: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`Invalid JSON ${label}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(
      `JSON ${label} must be a top-level object (got array or primitive).`
    );
  }
  return parsed as Record<string, unknown>;
}
