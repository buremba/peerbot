import chalk from "chalk";
import {
  loadCredentials,
  refreshCredentials,
  resolveContext,
} from "@lobu/cli-core";

export async function whoamiCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const creds = await refreshCredentials(
    await loadCredentials(target.name),
    target.name
  );

  if (!creds) {
    const envToken = process.env.LOBU_API_TOKEN;
    if (envToken) {
      console.log(
        chalk.dim("\n  Authenticated via LOBU_API_TOKEN environment variable.")
      );
      console.log(chalk.dim(`  Context: ${target.name}`));
      console.log(chalk.dim(`  API URL: ${target.apiUrl}`));
      console.log(chalk.dim("  Lobu Cloud is in early access.\n"));
      return;
    }
    console.log(chalk.dim("\n  Not logged in."));
    console.log(chalk.dim(`  Context: ${target.name}`));
    console.log(chalk.dim(`  API URL: ${target.apiUrl}`));
    console.log(
      chalk.dim("  Run `npx @lobu/cli@latest login` to authenticate.\n")
    );
    return;
  }

  console.log(chalk.bold("\n  Lobu CLI"));
  console.log(chalk.dim(`  Context: ${target.name}`));
  console.log(chalk.dim(`  API URL: ${target.apiUrl}`));
  if (creds.name) {
    console.log(chalk.dim(`  Name: ${creds.name}`));
  }
  if (creds.email) {
    console.log(chalk.dim(`  User: ${creds.email}`));
  }
  if (creds.userId) {
    console.log(chalk.dim(`  User ID: ${creds.userId}`));
  }
  if (creds.agentId) {
    console.log(chalk.dim(`  Linked agent: ${creds.agentId}`));
  }
  console.log();
}
