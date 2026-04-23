import { createLogger, type WorkerTransport } from "@lobu/core";

const logger = createLogger("worker");

/**
 * Format error message for display
 * Generic error formatter that works for any AI agent
 */
function formatErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return `💥 Worker crashed: Unknown error`;
  }
  const name = error.constructor.name;
  const isGeneric = name === "Error" || name === "WorkspaceError";
  return isGeneric
    ? `💥 Worker crashed: ${error.message}`
    : `💥 Worker crashed (${name}): ${error.message}`;
}

function classifyError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    error.message.includes("No model configured") ||
    error.message.includes("No provider specified")
  )
    return "NO_MODEL_CONFIGURED";
  return undefined;
}

/**
 * Handle execution error - decides between authentication and generic errors
 * Generic error handler that works for any AI agent
 */
export async function handleExecutionError(
  error: unknown,
  transport: WorkerTransport
): Promise<void> {
  logger.error("Worker execution failed:", error);

  const code = classifyError(error);

  try {
    if (code) {
      // Known error — clean message, no "Worker crashed" text
      await transport.signalError(
        error instanceof Error ? error : new Error(String(error)),
        code
      );
    } else {
      // Unknown error — existing behavior
      const errorMsg = formatErrorMessage(error);
      await transport.sendStreamDelta(errorMsg, true, true);
      await transport.signalError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  } catch (gatewayError) {
    logger.error("Failed to send error via gateway:", gatewayError);
    // Re-throw the original error
    throw error;
  }
}
