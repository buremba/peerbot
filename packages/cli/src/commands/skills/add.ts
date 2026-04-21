import chalk from "chalk";
import { installBundledSkill, listBundledSkills } from "./registry.js";

export async function skillsAddCommand(
  cwd: string,
  skillId: string,
  options?: { dir?: string; force?: boolean }
): Promise<void> {
  const available = listBundledSkills();
  const destinationRoot = options?.dir || cwd;

  try {
    const { skill, destinationDir } = installBundledSkill(skillId, destinationRoot, {
      force: options?.force,
    });

    console.log(chalk.green(`\n  Installed \"${skill.name}\"`));
    console.log(chalk.dim(`  → ${destinationDir}`));
    console.log();
    console.log(chalk.dim("  Next steps:"));
    console.log(chalk.cyan("    1. Commit the new skills/ directory to your repo"));
    console.log(chalk.cyan("    2. Point your agent or workspace at that local skill"));
    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n  ${message}`));

    if (message.includes("not found")) {
      console.log(
        chalk.dim(
          `  Available starter skills: ${available.map((skill) => skill.id).join(", ")}`
        )
      );
    }

    console.log();
  }
}
