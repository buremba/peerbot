import chalk from "chalk";
import { getSkillById, isProviderSkill } from "./registry.js";

export async function skillsInfoCommand(skillId: string): Promise<void> {
  const skill = getSkillById(skillId);

  if (!skill) {
    console.log(chalk.red(`\n  Skill "${skillId}" not found.`));
    console.log(
      chalk.dim(
        "  Run `npx @lobu/cli@latest skills list` to see available skills.\n"
      )
    );
    return;
  }

  console.log(chalk.bold(`\n  ${skill.name}`));
  console.log(chalk.dim(`  ${skill.description}`));
  console.log(chalk.dim(`  ID: ${skill.id}`));

  if (isProviderSkill(skill) && skill.providers) {
    console.log(chalk.bold("\n  Provider Details:"));
    for (const p of skill.providers) {
      console.log(chalk.dim(`    Name:          ${p.displayName}`));
      console.log(chalk.dim(`    Env var:       ${p.envVarName}`));
      console.log(chalk.dim(`    Base URL:      ${p.upstreamBaseUrl}`));
      if (p.defaultModel) {
        console.log(chalk.dim(`    Default model: ${p.defaultModel}`));
      }
    }

    console.log(chalk.bold("\n  Required secrets:"));
    for (const p of skill.providers) {
      console.log(chalk.cyan(`    ${p.envVarName}`));
    }
  }

  if (skill.mcpServers) {
    console.log(chalk.bold("\n  MCP Servers:"));
    for (const mcp of skill.mcpServers) {
      console.log(
        chalk.dim(
          `    ${mcp.name ?? mcp.id}: ${mcp.url ?? mcp.type ?? "stdio"}`
        )
      );
    }
  }

  console.log();
}
