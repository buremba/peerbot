import { writeFile } from "node:fs/promises";
import chalk from "chalk";
import {
  appendTomlBlock,
  loadAgentContext,
} from "../../config/agent-helpers.js";
import { CONFIG_FILENAME } from "../../config/loader.js";
import { getSkillById } from "./registry.js";

export async function skillsAddCommand(
  cwd: string,
  skillId: string
): Promise<void> {
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

  const ctx = await loadAgentContext(cwd);
  if (!ctx) return;

  const skillsSection = (ctx.agent.skills ?? { enabled: [] }) as Record<
    string,
    unknown
  >;
  const enabled = (skillsSection.enabled ?? []) as string[];

  if (enabled.includes(skillId)) {
    console.log(chalk.yellow(`\n  Skill "${skillId}" is already enabled.\n`));
    return;
  }

  // Update the enabled array in-place via regex to preserve file formatting
  const skillsKey = `agents.${ctx.agentId}.skills`;
  const enabledPattern = new RegExp(
    `(\\[${skillsKey.replace(/\./g, "\\.")}\\][^\\[]*enabled\\s*=\\s*\\[)([^\\]]*)\\]`
  );
  const match = ctx.raw.match(enabledPattern);

  if (match) {
    const existing = match[2]!.trim();
    const newList = existing ? `${existing}, "${skillId}"` : `"${skillId}"`;
    const updated = ctx.raw.replace(enabledPattern, `$1${newList}]`);
    await writeFile(ctx.configPath, updated);
  } else {
    await appendTomlBlock(ctx, [
      "",
      `[${skillsKey}]`,
      `enabled = ["${skillId}"]`,
    ]);
  }

  console.log(chalk.green(`\n  Added "${skillId}" to ${CONFIG_FILENAME}`));

  if (skill.providers) {
    const envVars = skill.providers.map((p) => p.envVarName);
    if (envVars.length > 0) {
      console.log(chalk.dim("\n  Required secrets:"));
      for (const v of envVars) {
        console.log(
          chalk.cyan(`    npx @lobu/cli@latest secrets set ${v} <your-key>`)
        );
      }
    }
  }
  console.log();
}
