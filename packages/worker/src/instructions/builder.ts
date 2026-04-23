import {
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";

const logger = createLogger("instruction-generator");

/**
 * Generate custom instructions using modular providers.
 * Only generates worker-local instructions (core, projects) — platform and
 * MCP instructions are provided by the gateway.
 */
export async function generateCustomInstructions(
  providers: InstructionProvider[],
  context: InstructionContext
): Promise<string> {
  try {
    // Sort by priority (lower priority = earlier in output)
    const sortedProviders = [...providers].sort(
      (a, b) => a.priority - b.priority
    );

    const sections: string[] = [];
    for (const provider of sortedProviders) {
      try {
        const instructions = await provider.getInstructions(context);
        if (instructions?.trim()) {
          sections.push(instructions.trim());
        }
      } catch (error) {
        logger.error(
          `Failed to get instructions from provider ${provider.name}:`,
          error
        );
      }
    }

    const instructions = sections.join("\n\n");
    logger.info(
      `[WORKER-INSTRUCTIONS] Generated ${instructions.length} characters from ${providers.length} local providers`
    );
    logger.debug(`[WORKER-INSTRUCTIONS] \n${instructions}`);
    return instructions;
  } catch (error) {
    logger.error("Failed to generate worker instructions:", error);
    const fallback = `You are a helpful AI agent for user ${context.userId}.`;
    logger.warn(`[WORKER-INSTRUCTIONS] Using fallback: ${fallback}`);
    return fallback;
  }
}
