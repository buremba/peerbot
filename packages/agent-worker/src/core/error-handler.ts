import { createLogger, type WorkerTransport } from "@lobu/core";

const logger = createLogger("worker");

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

export async function handleExecutionError(
  error: unknown,
  transport: WorkerTransport
): Promise<void> {
  logger.error("Worker execution failed:", error);

  const code = classifyError(error);
  const errorInstance =
    error instanceof Error ? error : new Error(String(error));

  try {
    if (code) {
      await transport.signalError(errorInstance, code);
    } else {
      await transport.sendStreamDelta(formatErrorMessage(error), true, true);
      await transport.signalError(errorInstance);
    }
  } catch (gatewayError) {
    logger.error("Failed to send error via gateway:", gatewayError);
    throw error;
  }
}
