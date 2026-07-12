import chalk from "chalk";
import { loadDesiredStateFromConfig } from "./_lib/apply/desired-state.js";

export async function validateCommand(cwd: string): Promise<boolean> {
  let state: Awaited<ReturnType<typeof loadDesiredStateFromConfig>>["state"];
  try {
    // Loading runs the full structural validation: slug/cron checks, watcher
    // agent refs, reaction-script paths, connector/auth shapes, etc. Secrets
    // are not required here (the gate runs at `lobu apply`).
    ({ state } = await loadDesiredStateFromConfig({ cwd }));
  } catch (err) {
    console.error(
      chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`)
    );
    console.log();
    return false;
  }

  const warnings: string[] = [];
  for (const agent of state.agents) {
    if (!agent.settings.models?.length) {
      warnings.push(
        `agent "${agent.metadata.agentId}" has no models configured. It will need provider keys + a model at runtime.`
      );
    }
  }

  console.log();
  console.log(chalk.green(`  lobu.config.ts is valid`));
  console.log(chalk.dim(`  ${state.agents.length} agent(s) configured`));
  for (const warn of warnings) {
    console.log(chalk.yellow(`  ${warn}`));
  }
  console.log();

  return true;
}
