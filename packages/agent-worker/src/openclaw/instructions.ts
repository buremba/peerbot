import {
  type InstructionContext,
  type InstructionProvider,
  renderAlwaysOnToolPolicyRules,
  renderBaselineAgentPolicy,
  renderDetectedToolIntentRules,
} from "@lobu/core";

/**
 * OpenClaw core instructions
 */
export class OpenClawCoreInstructionProvider implements InstructionProvider {
  name = "core";
  priority = 10;

  getInstructions(context: InstructionContext): string {
    return [
      `You are a Lobu agent for user ${context.userId}.`,
      `Working directory: ${context.workingDirectory}`,
      renderBaselineAgentPolicy(),
      renderAlwaysOnToolPolicyRules(),
      `## Image Analysis

If the user asks to analyze an uploaded image, use the image content already attached to the prompt and provide direct analysis.`,
    ].join("\n\n");
  }
}

export class OpenClawPromptIntentInstructionProvider
  implements InstructionProvider
{
  name = "prompt-intent";
  priority = 15;

  getInstructions(context: InstructionContext): string {
    return renderDetectedToolIntentRules(context.userPrompt || "");
  }
}
