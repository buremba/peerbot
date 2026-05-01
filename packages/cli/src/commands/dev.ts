import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import ora from "ora";
import { parseEnvContent } from "../internal/index.js";

/**
 * `lobu run` — start the embedded Lobu stack.
 *
 * Spawns the bundled @lobu/server Node server, which hosts the
 * gateway, embedded workers, embeddings, and the Owletto memory backend
 * in-process. Workers are spawned as child subprocesses by the gateway's
 * EmbeddedDeploymentManager. Postgres must be reachable via DATABASE_URL
 * in .env.
 */
export async function devCommand(
  cwd: string,
  passthroughArgs: string[]
): Promise<void> {
  const spinner = ora("Validating environment...").start();

  const envPath = join(cwd, ".env");
  let envVars: Record<string, string> = {};
  try {
    envVars = parseEnvContent(await readFile(envPath, "utf-8"));
  } catch {
    envVars = {};
  }

  const mergedEnv = { ...envVars, ...(process.env as Record<string, string>) };
  if (!mergedEnv.DATABASE_URL) {
    spinner.fail("DATABASE_URL is missing");
    console.error(
      chalk.red(`\n  Set the following in your environment or .env:\n`)
    );
    console.error(chalk.dim(`    DATABASE_URL=`));
    console.error(
      chalk.dim(
        "\n  Lobu connects to a user-provided Postgres. Run one yourself"
      )
    );
    console.error(
      chalk.dim(
        "  (managed instance or local: e.g. `brew services start postgresql`).\n"
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
      chalk.dim("    bun run --filter '@lobu/server' build:server\n")
    );
    process.exit(1);
  }

  spinner.succeed("Environment ready");

  const port = mergedEnv.GATEWAY_PORT || mergedEnv.PORT || "8787";
  const gatewayUrl = `http://localhost:${port}`;

  console.log(chalk.cyan(`\n  Starting Lobu...\n`));
  console.log(chalk.dim(`  bundle:        ${bundlePath}`));
  console.log(
    chalk.dim(`  database:      ${redactUrl(mergedEnv.DATABASE_URL!)}`)
  );
  console.log(chalk.dim(`  api docs:      ${gatewayUrl}/api/docs`));
  console.log();

  // Pass-through env: process.env wins so users can override per-invocation,
  // .env values fill in the rest. LOBU_DEV_PROJECT_PATH is optional and only
  // used by file-first local workflows that still have a lobu.toml.
  const childEnv: Record<string, string> = {
    ...mergedEnv,
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
  //    `@lobu/server` linked locally (e.g. internal monorepo).
  try {
    return require_.resolve("@lobu/server/dist/server.bundle.mjs");
  } catch {
    // not installed as a dep
  }

  // 3. Monorepo-relative lookup — covers `bun run packages/cli/...` from a
  //    fresh clone before the CLI itself has been published.
  let cur = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, "packages/server/dist/server.bundle.mjs");
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
