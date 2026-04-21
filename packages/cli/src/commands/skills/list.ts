import chalk from "chalk";
import { listBundledSkills } from "./registry.js";

export async function skillsListCommand(): Promise<void> {
  const skills = listBundledSkills();

  if (skills.length === 0) {
    console.log(chalk.yellow("\n  No bundled starter skills are available.\n"));
    return;
  }

  console.log(chalk.cyan("\n  Bundled starter skills\n"));
  for (const skill of skills) {
    console.log(chalk.green(`  ${skill.id}`));
    if (skill.description) {
      console.log(chalk.dim(`    ${skill.description}`));
    }
    console.log(chalk.dim(`    Files: ${skill.files.join(", ")}`));
    console.log();
  }
}
