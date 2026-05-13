import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import ora from "ora";
import { isLoadError, loadConfig } from "../config/loader.js";
import { resolveApiClient } from "../internal/api-client.js";
import { parseEnvContent } from "../internal/index.js";
import { loadProjectLink } from "../internal/project-link.js";

export interface DevOptions {
  port?: string;
  quiet?: boolean;
  verbose?: boolean;
  logLevel?: string;
}

type BackendBundleKind = "postgres" | "pglite";

/**
 * `lobu run` — start the embedded Lobu stack.
 *
 * By default this uses the bundled local PGlite runtime, so a freshly
 * scaffolded project can boot without Docker or a separate Postgres. When
 * DATABASE_URL is set in .env or the shell, it instead starts the external
 * Postgres runtime against that database.
 */
export async function devCommand(
  cwd: string,
  options: DevOptions = {}
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
  const hasDatabaseUrl = Boolean(mergedEnv.DATABASE_URL?.trim());
  const bundleKind: BackendBundleKind = hasDatabaseUrl ? "postgres" : "pglite";
  const bundlePath = resolveBackendBundle(undefined, bundleKind);
  if (!bundlePath) {
    spinner.fail("server bundle not found");
    const bundleName =
      bundleKind === "pglite" ? "start-local.bundle.mjs" : "server.bundle.mjs";
    console.error(
      chalk.red(
        `\n  Could not locate the embedded server bundle (${bundleName}).\n`
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
    console.error(chalk.dim("    make build-packages\n"));
    process.exit(1);
  }

  spinner.succeed(
    hasDatabaseUrl
      ? "Environment ready"
      : "Environment ready (using local PGlite)"
  );

  const portRaw =
    options.port ?? mergedEnv.GATEWAY_PORT ?? mergedEnv.PORT ?? "8787";
  const portNum = Number(portRaw);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error(
      chalk.red(`\n  Invalid port — must be an integer in 1-65535.\n`)
    );
    process.exit(1);
  }
  const gatewayUrl = `http://localhost:${portNum}`;

  const portFree = await isPortFree(portNum);
  if (!portFree) {
    console.error(chalk.red(`\n  Port ${portNum} is already in use.`));
    console.error(
      chalk.dim(
        "  Stop the other process, or pass `--port <n>` / set `GATEWAY_PORT` to a free port.\n"
      )
    );
    console.error(
      chalk.dim(
        process.platform === "darwin" || process.platform === "linux"
          ? `  Find what's holding it: lsof -iTCP:${portNum} -sTCP:LISTEN\n`
          : `  Find what's holding it: netstat -ano | findstr :${portNum}\n`
      )
    );
    process.exit(1);
  }

  if (!options.quiet) {
    await printPreviewInstructions(cwd);
    console.log(chalk.cyan(`\n  Starting Lobu...\n`));
    console.log(chalk.dim(`  bundle:        ${bundlePath}`));
    if (hasDatabaseUrl) {
      console.log(
        chalk.dim(`  database:      ${redactUrl(mergedEnv.DATABASE_URL!)}`)
      );
    } else {
      console.log(chalk.dim("  database:      local PGlite"));
      console.log(
        chalk.dim(
          `  data:          ${mergedEnv.LOBU_DATA_DIR || "~/.lobu/data"}`
        )
      );
    }
    console.log(chalk.dim(`  api docs:      ${gatewayUrl}/api/docs`));
    console.log();
  }

  const logLevel =
    options.logLevel ??
    (options.quiet ? "warn" : options.verbose ? "debug" : undefined);

  // Pass-through env: process.env wins so users can override per-invocation,
  // .env values fill in the rest.
  //
  // LOBU_DEV_PROJECT_PATH points the embedded server at the monorepo root so
  // it can find the `packages/agent-worker/src/index.ts` worker entry (and
  // packages/web). When `lobu run` is invoked from a project subdir inside the
  // monorepo, cwd is *not* the root — walk up to the enclosing workspace root.
  const enclosingRoot = findEnclosingMonorepoRoot(cwd);
  const projectPath =
    process.env.LOBU_DEV_PROJECT_PATH ||
    envVars.LOBU_DEV_PROJECT_PATH ||
    enclosingRoot ||
    cwd;

  // Bundled CLIs (and `lobu run` from anywhere) ship providers.json next to
  // the server bundle; point the gateway at it unless the user already set the
  // path in their env or .env.
  const bundledProvidersPath = join(dirname(bundlePath), "providers.json");
  const providerRegistryPath =
    process.env.LOBU_PROVIDER_REGISTRY_PATH ||
    envVars.LOBU_PROVIDER_REGISTRY_PATH ||
    (existsSync(bundledProvidersPath) ? bundledProvidersPath : undefined);

  const childEnv: Record<string, string> = {
    ...mergedEnv,
    LOBU_DEV_PROJECT_PATH: projectPath,
    ...(providerRegistryPath
      ? { LOBU_PROVIDER_REGISTRY_PATH: providerRegistryPath }
      : {}),
    PORT: String(portNum),
    GATEWAY_PORT: String(portNum),
    ...(logLevel ? { LOG_LEVEL: logLevel } : {}),
  };

  const child = spawn("node", [bundlePath], {
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

/**
 * Walk up from `startDir` looking for the Lobu monorepo workspace root: a
 * `package.json` with a non-empty `workspaces` field AND a
 * `packages/agent-worker/src/index.ts` underneath it. Returns the absolute
 * path, or `null`. (Mirrors `@lobu/server`'s `findEnclosingMonorepoRoot` — kept
 * local so the CLI doesn't take a dep on the server package.)
 */
export function findEnclosingMonorepoRoot(startDir: string): string | null {
  let cur = resolve(startDir);
  for (let i = 0; i < 64; i++) {
    const pkgPath = join(cur, "package.json");
    if (existsSync(pkgPath)) {
      let hasWorkspaces = false;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          workspaces?: unknown;
        };
        hasWorkspaces =
          pkg.workspaces != null &&
          (Array.isArray(pkg.workspaces)
            ? pkg.workspaces.length > 0
            : typeof pkg.workspaces === "object");
      } catch {
        hasWorkspaces = false;
      }
      if (
        hasWorkspaces &&
        existsSync(join(cur, "packages/agent-worker/src/index.ts"))
      ) {
        return cur;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function resolveBackendBundle(
  startDir = dirname(fileURLToPath(import.meta.url)),
  kind: BackendBundleKind = "postgres"
): string | null {
  const here = startDir;
  const require_ = createRequire(import.meta.url);
  const bundleName =
    kind === "pglite" ? "start-local.bundle.mjs" : "server.bundle.mjs";

  for (const bundled of [
    join(here, bundleName),
    join(here, "..", bundleName),
  ]) {
    if (existsSync(bundled)) return bundled;
  }

  if (kind === "postgres") {
    try {
      return require_.resolve("@lobu/server/dist/server.bundle.mjs");
    } catch {
      // not installed as a dep
    }
  }

  let cur = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, "packages/server/dist", bundleName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return null;
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const settle = (free: boolean) => {
      server.removeAllListeners();
      server.close(() => resolve(free));
    };
    server.once("error", () => settle(false));
    server.once("listening", () => settle(true));
    try {
      server.listen({ port, host: "127.0.0.1", exclusive: true });
    } catch {
      settle(false);
    }
  });
}

async function printPreviewInstructions(cwd: string): Promise<void> {
  const loaded = await loadConfig(cwd);
  if (isLoadError(loaded)) return;

  // `agent.preview` is a record keyed by chat platform (`slack`, `telegram`, …).
  const enabled: Array<{
    agentId: string;
    platform: string;
    cfg: { surfaces?: string[]; code_ttl_minutes?: number };
  }> = [];
  for (const [agentId, agent] of Object.entries(loaded.config.agents)) {
    for (const [platform, cfg] of Object.entries(agent.preview ?? {})) {
      if (cfg?.enabled === true) enabled.push({ agentId, platform, cfg });
    }
  }
  if (enabled.length === 0) return;

  let clientInfo: Awaited<ReturnType<typeof resolveApiClient>>;
  try {
    const projectLink = await loadProjectLink(cwd);
    clientInfo = await resolveApiClient({
      context: projectLink?.context,
      org: projectLink?.org,
    });
  } catch {
    console.log(
      chalk.yellow(
        "\n  Preview is enabled, but no Lobu Cloud session is available."
      )
    );
    console.log(
      chalk.dim(
        "  Run `lobu login`, `lobu org set <slug>`, and `lobu apply`; then restart `lobu run` to get a link code.\n"
      )
    );
    return;
  }

  console.log(chalk.cyan("\n  Preview"));
  for (const { agentId, platform, cfg } of enabled) {
    try {
      const claim = await clientInfo.client.post<{
        code: string;
        command: string;
        join_url: string;
        expires_at: string;
        allowed_surfaces: string[];
      }>(`/api/${clientInfo.orgSlug}/preview/claims`, {
        agent_id: agentId,
        platform,
        surfaces: cfg.surfaces ?? ["dm"],
        ttl_minutes: cfg.code_ttl_minutes ?? 15,
      });
      console.log(chalk.dim(`  agent:        ${agentId}`));
      console.log(chalk.dim(`  platform:     ${platform}`));
      if (claim.join_url)
        console.log(chalk.dim(`  join:         ${claim.join_url}`));
      console.log(chalk.dim(`  command:      ${claim.command}`));
      console.log(chalk.dim(`  expires:      ${claim.expires_at}`));
      console.log(
        chalk.dim(
          `  Join the hosted Lobu ${platform} workspace and send the command above to @Lobu.`
        )
      );
    } catch (error) {
      console.log(
        chalk.yellow(
          `  Could not create a ${platform} preview code for ${agentId}.`
        )
      );
      console.log(
        chalk.dim(
          "  Make sure the agent has been synced with `lobu apply` and try again."
        )
      );
      if (process.env.DEBUG) {
        console.log(
          chalk.dim(
            `  ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    }
  }
  console.log();
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
