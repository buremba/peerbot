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
 *
 * Per-provider error handling lives on `BaseInstructionProvider` (a thrown
 * provider returns `""`). The fallback below covers the unlikely case of a
 * provider that bypasses the base class throwing during the loop itself.
 */
export async function generateCustomInstructions(
  providers: InstructionProvider[],
  context: InstructionContext
): Promise<string> {
  try {
    const sections: string[] = [];
    for (const provider of [...providers].sort(
      (a, b) => a.priority - b.priority
    )) {
      const instructions = await provider.getInstructions(context);
      if (instructions?.trim()) {
        sections.push(instructions.trim());
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
