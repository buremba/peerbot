import { password } from "@inquirer/prompts";
import chalk from "chalk";
import {
  appendTomlBlock,
  loadAgentContext,
  setSecrets,
} from "../../config/agent-helpers.js";
import { CONFIG_FILENAME } from "../../config/loader.js";
import { getProviderById } from "./registry.js";

export async function providersAddCommand(
  cwd: string,
  providerId: string
): Promise<void> {
  const providerEntry = getProviderById(providerId);
  if (!providerEntry) {
    console.log(chalk.red(`\n  Provider "${providerId}" not found.`));
    console.log(
      chalk.dim(
        "  Run `npx @lobu/cli@latest providers list` to see available providers.\n"
      )
    );
    return;
  }

  const ctx = await loadAgentContext(cwd);
  if (!ctx) return;

  const providers = (ctx.agent.providers ?? []) as Array<
    Record<string, unknown>
  >;
  if (providers.some((p) => p.id === providerId)) {
    console.log(
      chalk.yellow(`\n  Provider "${providerId}" is already configured.\n`)
    );
    return;
  }

  const provider = providerEntry.providers?.[0];
  if (!provider) return;

  const defaultModel = provider.defaultModel;
  const envVar = provider.envVarName;

  const apiKey = await password({
    message: `${provider.displayName} API key:`,
    mask: true,
  });

  await appendTomlBlock(ctx, [
    "",
    `[[agents.${ctx.agentId}.providers]]`,
    `id = "${providerId}"`,
    ...(defaultModel ? [`model = "${defaultModel}"`] : []),
    `key = "$${envVar}"`,
  ]);

  if (apiKey) {
    await setSecrets(cwd, [{ envVar, value: apiKey }]);
  }

  console.log(
    chalk.green(`\n  Added provider "${providerId}" to ${CONFIG_FILENAME}`)
  );
  if (defaultModel) {
    console.log(chalk.dim(`  Default model: ${defaultModel}`));
  }
  if (!apiKey) {
    console.log(chalk.dim("\n  Set the API key:"));
    console.log(
      chalk.cyan(`    npx @lobu/cli@latest secrets set ${envVar} <your-key>`)
    );
  }
  console.log();
}
