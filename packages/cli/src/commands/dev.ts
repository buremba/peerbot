import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { isLoadError, loadConfig } from "../config/loader.js";

/**
 * `lobu run` — smart wrapper around `docker compose up`.
 * Validates lobu.toml, seeds .env, then starts docker compose.
 * The gateway reads lobu.toml directly from the mounted workspace.
 */
export async function devCommand(
  cwd: string,
  passthroughArgs: string[]
): Promise<void> {
  const result = await loadConfig(cwd);

  if (isLoadError(result)) {
    console.error(chalk.red(`\n  ${result.error}`));
    if (result.details) {
      for (const detail of result.details) {
        console.error(chalk.dim(`  ${detail}`));
      }
    }
    console.log();
    process.exit(1);
  }

  const { config } = result;
  const spinner = ora("Preparing local dev environment...").start();

  try {
    // Parse .env to merge derived vars
    const envPath = join(cwd, ".env");
    let existingEnv = "";
    try {
      existingEnv = await readFile(envPath, "utf-8");
    } catch {
      // No existing .env, start fresh
    }
    const dotenvVars = parseEnvFile(existingEnv);

    const agentCount = Object.keys(config.agents).length;

    // Derive env vars (compose project name from first agent or directory name)
    const firstAgent = Object.values(config.agents)[0];
    const envVars: Record<string, string> = {
      COMPOSE_PROJECT_NAME: firstAgent?.name
        ? firstAgent.name.toLowerCase().replace(/\s+/g, "-")
        : basename(cwd),
    };

    // Merge derived vars into existing .env (preserves comments and formatting)
    await mergeEnvFile(envPath, existingEnv, envVars);

    spinner.succeed("Environment prepared from lobu.toml");

    // Check for docker-compose.yml
    try {
      await readFile(join(cwd, "docker-compose.yml"), "utf-8");
    } catch {
      console.log(
        chalk.yellow(
          "\n  No docker-compose.yml found. Run `lobu init` to generate one.\n"
        )
      );
      process.exit(1);
    }

    const fallbackPort = dotenvVars.GATEWAY_PORT || "8080";

    console.log(chalk.cyan(`\n  Starting ${agentCount} agent(s)...\n`));

    const explicitDetach =
      passthroughArgs.includes("-d") || passthroughArgs.includes("--detach");

    // Always start detached so we can print the banner before logs
    const upArgs = explicitDetach
      ? ["compose", "up", ...passthroughArgs]
      : ["compose", "up", "-d", ...passthroughArgs];

    const up = spawn("docker", upArgs, { cwd, stdio: "inherit" });

    up.on("error", (err) => {
      console.error(
        chalk.red(`\n  Failed to start docker compose: ${err.message}`)
      );
      console.log(chalk.dim("  Make sure Docker Desktop is running.\n"));
      process.exit(1);
    });

    up.on("exit", (code) => {
      if (code !== 0) {
        process.exit(code ?? 1);
      }

      // Detect actual host port from the running container
      const portProbe = spawn(
        "docker",
        ["compose", "port", "gateway", "8080"],
        { cwd, stdio: ["ignore", "pipe", "ignore"] }
      );

      let portOutput = "";
      portProbe.stdout.on("data", (data: Buffer) => {
        portOutput += data.toString();
      });

      portProbe.on("exit", () => {
        const match = portOutput.trim().match(/:(\d+)$/);
        const port = match ? match[1] : fallbackPort;
        const gatewayUrl = `http://localhost:${port}`;

        console.log(chalk.green("\n  Lobu is running!\n"));
        console.log(chalk.cyan(`  API docs:      ${gatewayUrl}/api/docs`));
        console.log(chalk.dim(`\n  Stop:          docker compose down`));

        if (explicitDetach) {
          console.log(
            chalk.dim(`  View logs:     docker compose logs -f gateway\n`)
          );
          process.exit(0);
        }

        console.log(
          chalk.dim(`  Ctrl+C stops log tail, containers keep running.\n`)
        );

        // Tail only gateway logs (skip redis noise)
        const logs = spawn("docker", ["compose", "logs", "-f", "gateway"], {
          cwd,
          stdio: "inherit",
        });

        logs.on("exit", (logCode) => {
          process.exit(logCode ?? 0);
        });
      });
    });
  } catch (err) {
    spinner.fail("Failed to prepare environment");
    console.error(
      chalk.red(`  ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    // Strip surrounding quotes (double or single)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Merge derived env vars into an existing .env file.
 * Updates existing keys in-place and appends new ones at the end.
 * Preserves comments, blank lines, and formatting.
 */
async function mergeEnvFile(
  envPath: string,
  existingContent: string,
  newVars: Record<string, string>
): Promise<void> {
  const remaining = { ...newVars };
  const lines = existingContent.split("\n");

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx);
    if (key in remaining) {
      const val = remaining[key]!;
      delete remaining[key];
      return `${key}=${val}`;
    }
    return line;
  });

  // Append any new vars that weren't already in the file
  for (const [key, value] of Object.entries(remaining)) {
    updated.push(`${key}=${value}`);
  }

  // Ensure trailing newline
  const content = `${updated.join("\n").trimEnd()}\n`;
  await writeFile(envPath, content);
}
