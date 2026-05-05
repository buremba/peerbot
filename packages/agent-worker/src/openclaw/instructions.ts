import {
  BaseInstructionProvider,
  type InstructionContext,
  renderAlwaysOnToolPolicyRules,
  renderBaselineAgentPolicy,
  renderDetectedToolIntentRules,
} from "@lobu/core";

/**
 * OpenClaw core instructions
 */
export class OpenClawCoreInstructionProvider extends BaseInstructionProvider {
  readonly name = "core";
  readonly priority = 10;

  protected buildInstructions(context: InstructionContext): string {
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

export class OpenClawPromptIntentInstructionProvider extends BaseInstructionProvider {
  readonly name = "prompt-intent";
  readonly priority = 15;

  protected buildInstructions(context: InstructionContext): string {
    return renderDetectedToolIntentRules(context.userPrompt || "");
  }
}
