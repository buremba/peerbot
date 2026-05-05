/**
 * Instruction providers for worker
 */

import { BaseInstructionProvider, type InstructionContext } from "@lobu/core";

/**
 * Provides information about available projects in the workspace
 */
export class ProjectsInstructionProvider extends BaseInstructionProvider {
  readonly name = "projects";
  readonly priority = 30;

  protected buildInstructions(context: InstructionContext): string {
    if (!context.availableProjects || context.availableProjects.length === 0) {
      return `**Available projects:**
  - none`;
    }

    const projectList = context.availableProjects
      .map((project: string) => `  - ${project}`)
      .join("\n");

    return `**Available projects:**
${projectList}`;
  }
}
