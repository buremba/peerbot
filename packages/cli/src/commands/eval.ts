import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { getToken, resolveGatewayUrl } from "@lobu/cli-core";
import { isLoadError, loadConfig } from "../config/loader.js";
import { CURRENT_EVAL_VERSION, evalDefinitionSchema } from "../eval/types.js";
import type { EvalDefinition, EvalReport, EvalResult } from "../eval/types.js";
import { runEval } from "../eval/runner.js";
import {
  printReport,
  saveResult,
  writeJsonReport,
  writeMarkdownReport,
} from "../eval/reporter.js";

export async function evalCommand(
  cwd: string,
  name: string | undefined,
  options: {
    agent?: string;
    gateway?: string;
    model?: string;
    trials?: number;
    list?: boolean;
    ci?: boolean;
    output?: string;
  }
): Promise<void> {
  // Load config first (needed for --list and running)
  const configResult = await loadConfig(cwd);
  if (isLoadError(configResult)) {
    console.error(chalk.red(`\n  ${configResult.error}\n`));
    process.exit(1);
  }

  const agentIds = Object.keys(configResult.config.agents);
  const agentId = options.agent ?? agentIds[0];
  if (!agentId) {
    console.error(chalk.red("\n  No agents found in lobu.toml\n"));
    process.exit(1);
  }

  const agent = configResult.config.agents[agentId];
  if (!agent) {
    console.error(chalk.red(`\n  Agent "${agentId}" not found in lobu.toml\n`));
    process.exit(1);
  }

  // Parse --model flag: "provider/model" or just "model"
  // Only override provider/model when --model is explicitly set;
  // otherwise let the gateway use the agent's lobu.toml config.
  let provider: string | undefined;
  let model: string | undefined;
  if (options.model) {
    const slashIdx = options.model.indexOf("/");
    if (slashIdx !== -1) {
      provider = options.model.slice(0, slashIdx);
      model = options.model.slice(slashIdx + 1);
    } else {
      model = options.model;
    }
  }
  const reportProvider = provider ?? agent.providers[0]?.id ?? "default";
  const reportModel = model ?? agent.providers[0]?.model ?? "auto";

  // Discover eval files
  const evalsDir = join(cwd, agent.dir, "evals");
  const evalFiles = await discoverEvals(evalsDir, name);

  if (evalFiles.length === 0) {
    console.error(
      chalk.yellow(
        `\n  No eval files found in ${evalsDir}${name ? ` matching "${name}"` : ""}\n`
      )
    );
    console.error(
      chalk.dim(
        "  Create YAML eval files in your agent's evals/ directory. See https://lobu.ai/guides/evals/\n"
      )
    );
    process.exit(1);
  }

  // --list: show available evals and exit
  if (options.list) {
    console.log(chalk.bold(`\nAgent: ${agentId}`));
    console.log(chalk.dim(`Evals: ${evalsDir}\n`));
    for (const filePath of evalFiles) {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseYaml(raw);
      const def = evalDefinitionSchema.safeParse(parsed);
      const evalName = def.success
        ? def.data.name
        : basename(filePath, ".yaml");
      const desc =
        def.success && def.data.description ? ` — ${def.data.description}` : "";
      const trials = def.success ? def.data.trials : "?";
      const tags =
        def.success && def.data.tags?.length
          ? ` [${def.data.tags.join(", ")}]`
          : "";
      console.log(`  ${evalName} (${trials} trials)${desc}${tags}`);
    }
    console.log();
    return;
  }

  // Auth and gateway required from here (not needed for --list)
  const gatewayUrl = (
    options.gateway ?? (await resolveGatewayUrl({ cwd }))
  ).replace(/\/$/, "");

  const authToken = (await getToken()) ?? process.env.ADMIN_PASSWORD;
  if (!authToken) {
    console.error(
      chalk.red(
        "\n  Authentication required. Run `lobu login` or set ADMIN_PASSWORD.\n"
      )
    );
    process.exit(1);
  }

  // Parse eval definitions
  const definitions: Array<{ def: EvalDefinition; path: string }> = [];
  for (const filePath of evalFiles) {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseYaml(raw);
    const result = evalDefinitionSchema.safeParse(parsed);

    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      console.error(chalk.red(`\n  Invalid eval: ${filePath}\n${issues}\n`));
      process.exit(1);
    }

    if (result.data.version > CURRENT_EVAL_VERSION) {
      console.error(
        chalk.red(
          `\n  ${filePath} uses eval version ${result.data.version}, but this CLI only supports version ${CURRENT_EVAL_VERSION}.\n  Upgrade @lobu/cli to run this eval.\n`
        )
      );
      process.exit(1);
    }

    definitions.push({ def: result.data, path: filePath });
  }

  // Run evals
  const results: EvalResult[] = [];

  for (const { def, path } of definitions) {
    if (!options.ci) {
      console.log(chalk.dim(`Running: ${def.name}...`));
    }

    try {
      const result = await runEval(def, path, {
        gatewayUrl,
        authToken,
        agentId,
        provider,
        model,
        trialsOverride: options.trials,
      });

      results.push(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        console.error(
          chalk.red(
            `\n  Cannot connect to gateway at ${gatewayUrl}\n  Start the stack first: lobu run -d\n`
          )
        );
        process.exit(1);
      }
      console.error(chalk.red(`\n  Eval "${def.name}" failed: ${msg}\n`));
    }
  }

  // Build report
  const passedEvals = results.filter((r) => r.passRate >= 0.8).length;

  const report: EvalReport = {
    agent: agentId,
    model: reportModel,
    provider: reportProvider,
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: passedEvals,
      failed: results.length - passedEvals,
    },
    evals: results,
  };

  // Auto-save results
  await saveResult(evalsDir, report);

  // Generate comparison report
  await writeMarkdownReport(evalsDir, report);

  // Console or CI output
  if (options.ci) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (options.output) {
    await writeJsonReport(report, options.output);
  }

  if (options.ci && report.summary.failed > 0) {
    process.exit(1);
  }
}

async function discoverEvals(
  evalsDir: string,
  filterName?: string
): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(evalsDir);
    const yamlFiles = entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => join(evalsDir, f));

    if (filterName) {
      return yamlFiles.filter((f) => {
        const base = basename(f, f.endsWith(".yaml") ? ".yaml" : ".yml");
        return base === filterName || base.includes(filterName);
      });
    }

    return yamlFiles;
  } catch {
    return [];
  }
}
