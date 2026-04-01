import {
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";

const logger = createLogger("instruction-generator");

/**
 * Build custom instructions by collecting from multiple providers
 * @param providers - Array of instruction providers
 * @param context - Context information for instruction generation
 * @returns Complete instruction text
 */
async function buildInstructions(
  providers: InstructionProvider[],
  context: InstructionContext
): Promise<string> {
  // Sort by priority (lower priority = earlier in output)
  const sortedProviders = [...providers].sort(
    (a, b) => a.priority - b.priority
  );

  logger.debug(
    `Building instructions with ${sortedProviders.length} providers`
  );

  const sections: string[] = [];

  // Collect instructions from all providers
  for (const provider of sortedProviders) {
    try {
      const instructions = await provider.getInstructions(context);
      if (instructions?.trim()) {
        sections.push(instructions.trim());
        logger.debug(
          `Provider ${provider.name} contributed ${instructions.length} characters`
        );
      }
    } catch (error) {
      logger.error(
        `Failed to get instructions from provider ${provider.name}:`,
        error
      );
    }
  }

  const finalInstructions = sections.join("\n\n");
  logger.info(
    `Built custom instructions: ${finalInstructions.length} characters from ${sections.length} providers`
  );

  return finalInstructions;
}

/**
 * Generate custom instructions using modular providers
 * Only generates worker-local instructions (core, projects)
 * Platform and MCP instructions are provided by the gateway
 */
export async function generateCustomInstructions(
  providers: InstructionProvider[],
  context: InstructionContext
): Promise<string> {
  try {
    const instructions = await buildInstructions(providers, context);

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
