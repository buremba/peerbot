import chalk from "chalk";
import { agentCountsText, fetchAgents } from "./_lib/agents-view.js";

export async function statusCommand(
  options: { context?: string; org?: string } = {}
): Promise<void> {
  const { agents, orgSlug, apiBaseUrl } = await fetchAgents(options);

  console.log(chalk.bold("\n  Lobu"));
  console.log(chalk.dim(`  API: ${apiBaseUrl}`));
  console.log(chalk.dim(`  Org: ${orgSlug}`));

  if (agents.length === 0) {
    console.log(chalk.yellow("\n  No agents configured.\n"));
    return;
  }

  console.log(chalk.bold.cyan("\n  Agents"));
  for (const agent of agents) {
    const active =
      agent.status === "active" || (agent.activeConnectionCount ?? 0) > 0;
    const icon = active ? chalk.green("●") : chalk.dim("○");
    console.log(
      `  ${icon} ${chalk.bold(agent.name)} ${chalk.dim(`(${agent.agentId})`)}  ${chalk.dim(
        agentCountsText(agent)
      )}`
    );
  }
  console.log();
}
