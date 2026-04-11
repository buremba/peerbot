import chalk from "chalk";
import { isProviderSkill, loadSkillsRegistry } from "../skills/registry.js";

export async function providersListCommand(): Promise<void> {
  const skills = loadSkillsRegistry();
  const providerSkills = skills.filter(isProviderSkill);

  if (providerSkills.length === 0) {
    console.log(chalk.yellow("\n  No providers found in registry.\n"));
    return;
  }

  console.log(chalk.bold("\n  Available LLM Providers:\n"));

  const maxIdLen = Math.max(...providerSkills.map((s) => s.id.length));

  for (const skill of providerSkills) {
    const p = skill.providers?.[0];
    if (!p) continue;
    const model = p.defaultModel
      ? chalk.dim(` default: ${p.defaultModel}`)
      : "";
    console.log(
      `  ${chalk.cyan(skill.id.padEnd(maxIdLen))}  ${p.displayName}${model}`
    );
  }

  console.log(
    chalk.dim(
      "\n  Use `npx @lobu/cli@latest providers add <id>` to add a provider to lobu.toml.\n"
    )
  );
}
