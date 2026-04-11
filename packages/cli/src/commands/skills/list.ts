import chalk from "chalk";
import { isProviderSkill, loadSkillsRegistry } from "./registry.js";

export async function skillsListCommand(): Promise<void> {
  const skills = loadSkillsRegistry();

  if (skills.length === 0) {
    console.log(chalk.yellow("\n  No skills found in registry.\n"));
    return;
  }

  const systemSkills = skills.filter((s) => !isProviderSkill(s) && !s.hidden);
  const providers = skills.filter(isProviderSkill);

  if (systemSkills.length > 0) {
    console.log(chalk.bold("\n  Skills:\n"));
    const maxIdLen = Math.max(...systemSkills.map((s) => s.id.length));
    for (const skill of systemSkills) {
      console.log(
        `  ${chalk.cyan(skill.id.padEnd(maxIdLen))}  ${chalk.dim(skill.description)}`
      );
    }
  }

  if (providers.length > 0) {
    console.log(chalk.bold("\n  LLM Providers:\n"));
    const maxIdLen = Math.max(...providers.map((s) => s.id.length));
    for (const skill of providers) {
      const defaultModel = skill.providers?.[0]?.defaultModel;
      const modelHint = defaultModel ? chalk.dim(` (${defaultModel})`) : "";
      console.log(
        `  ${chalk.cyan(skill.id.padEnd(maxIdLen))}  ${chalk.dim(skill.description)}${modelHint}`
      );
    }
  }

  console.log(
    chalk.dim(
      "\n  Use `npx @lobu/cli@latest skills info <id>` for details on a specific skill.\n"
    )
  );
}
