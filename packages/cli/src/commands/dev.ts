import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import ora from "ora";
import { isLoadError, loadConfig } from "../config/loader.js";
import { parseEnvContent } from "../internal/index.js";

/**
 * `lobu run` — start the embedded Lobu stack.
 *
 * Spawns the bundled @lobu/owletto-backend Node server, which hosts the
 * gateway, embedded workers, embeddings, and the Owletto memory backend
 * in-process. Workers are spawned as child subprocesses by the gateway's
 * EmbeddedDeploymentManager. Postgres and Redis must be reachable via
 * DATABASE_URL and REDIS_URL in .env.
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
  const spinner = ora("Validating environment...").start();

  const envPath = join(cwd, ".env");
  let envContent = "";
  try {
    envContent = await readFile(envPath, "utf-8");
  } catch {
    spinner.fail(".env not found");
    console.error(
      chalk.red(`\n  No .env file at ${envPath}. Run \`lobu init\` first.\n`)
    );
    process.exit(1);
  }

  const envVars = parseEnvContent(envContent);
  const missing: string[] = [];
  if (!envVars.DATABASE_URL) missing.push("DATABASE_URL");
  if (!envVars.REDIS_URL) missing.push("REDIS_URL");

  if (missing.length > 0) {
    spinner.fail("Required environment variables missing");
    console.error(chalk.red(`\n  Set the following in .env:\n`));
    for (const key of missing) {
      console.error(chalk.dim(`    ${key}=`));
    }
    console.error(
      chalk.dim(
        "\n  Lobu connects to a user-provided Postgres + Redis. Run them yourself"
      )
    );
    console.error(
      chalk.dim(
        "  (managed instances or local: e.g. `brew services start postgresql redis`).\n"
      )
    );
    process.exit(1);
  }

  const bundlePath = resolveBackendBundle();
  if (!bundlePath) {
    spinner.fail("server bundle not found");
    console.error(
      chalk.red(
        "\n  Could not locate the embedded server bundle (server.bundle.mjs).\n"
      )
    );
    console.error(
      chalk.dim(
        "  Installed CLIs ship the bundle inside their own dist/. If you're"
      )
    );
    console.error(
      chalk.dim(
        "  seeing this from a published @lobu/cli, please file an issue."
      )
    );
    console.error(chalk.dim("  In the monorepo, build it via:"));
    console.error(
      chalk.dim("    bun run --filter '@lobu/owletto-backend' build:server\n")
    );
    process.exit(1);
  }

  const agentCount = Object.keys(config.agents).length;
  spinner.succeed(`Loaded ${agentCount} agent(s) from lobu.toml`);

  const port = envVars.GATEWAY_PORT || envVars.PORT || "8787";
  const gatewayUrl = `http://localhost:${port}`;

  console.log(chalk.cyan(`\n  Starting Lobu...\n`));
  console.log(chalk.dim(`  bundle:        ${bundlePath}`));
  console.log(
    chalk.dim(`  database:      ${redactUrl(envVars.DATABASE_URL!)}`)
  );
  console.log(chalk.dim(`  redis:         ${redactUrl(envVars.REDIS_URL!)}`));
  console.log(chalk.dim(`  api docs:      ${gatewayUrl}/api/docs`));
  console.log();

  // Pass-through env: process.env wins so users can override per-invocation,
  // .env values fill in the rest. LOBU_DEV_PROJECT_PATH points the gateway at
  // this project so it loads lobu.toml and agent files.
  const childEnv: Record<string, string> = {
    ...envVars,
    ...(process.env as Record<string, string>),
    LOBU_DEV_PROJECT_PATH:
      process.env.LOBU_DEV_PROJECT_PATH || envVars.LOBU_DEV_PROJECT_PATH || cwd,
    PORT: port,
  };

  const child = spawn("node", [bundlePath, ...passthroughArgs], {
    cwd,
    env: childEnv,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(chalk.red(`\n  Failed to start Lobu: ${err.message}\n`));
    process.exit(1);
  });

  // Forward Ctrl+C to the child so it can clean up its own subprocess workers
  // before the parent exits. SIGKILL after a timeout in case it wedges.
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 10_000).unref();
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(chalk.dim(`\n  Lobu exited (${signal}).\n`));
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

export function resolveBackendBundle(
  startDir = dirname(fileURLToPath(import.meta.url))
): string | null {
  const here = startDir;
  const require_ = createRequire(import.meta.url);

  // 1. Bundled inside the CLI tarball at `dist/server.bundle.mjs`. The
  //    compiled command module lives under `dist/commands/`, so check both
  //    the module directory (legacy/local builds) and the dist root where
  //    `packages/cli/scripts/build.cjs` copies the bundle.
  for (const bundled of [
    join(here, "server.bundle.mjs"),
    join(here, "..", "server.bundle.mjs"),
  ]) {
    if (existsSync(bundled)) return bundled;
  }

  // 2. Resolved via node_modules — covers a workspace consumer that has
  //    `@lobu/owletto-backend` linked locally (e.g. internal monorepo).
  try {
    return require_.resolve("@lobu/owletto-backend/dist/server.bundle.mjs");
  } catch {
    // not installed as a dep
  }

  // 3. Monorepo-relative lookup — covers `bun run packages/cli/...` from a
  //    fresh clone before the CLI itself has been published.
  let cur = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(
      cur,
      "packages/owletto-backend/dist/server.bundle.mjs"
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return null;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return url;
  }
}
