export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'ValidationError';
  }
}

export class DependencyError extends CliError {
  constructor(binary: string) {
    super(`Required binary "${binary}" not found. Install it and ensure it's on your PATH.`, 127);
    this.name = 'DependencyError';
  }
}

export class ApiError extends CliError {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message, 3);
    this.name = 'ApiError';
  }
}
