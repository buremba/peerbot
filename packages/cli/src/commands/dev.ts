import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHostedChatEntry } from "@lobu/core";
import chalk from "chalk";
import ora from "ora";
import { loadProjectConfig } from "./_lib/apply/desired-state.js";
import { resolveApiClient } from "../internal/api-client.js";
import {
  addContext,
  getCurrentContextName,
  getServerConfig,
  setActiveOrg,
  setCurrentContext,
} from "../internal/context.js";
import { type Credentials, saveCredentials } from "../internal/credentials.js";
import { parseEnvContent } from "../internal/index.js";
import { loadProjectLink } from "../internal/project-link.js";

interface DevOptions {
  port?: string;
  quiet?: boolean;
  verbose?: boolean;
  logLevel?: string;
  /**
   * Acknowledge that `lobu run` is about to point at a shared/non-local
   * Postgres inherited from the shell. Required when the project's own .env
   * doesn't pin DATABASE_URL — protects against the silent footgun of running
   * "local dev" against a teammate's tailnet DB or, worse, prod.
   */
  unsafeSharedDb?: boolean;
}

/**
 * Treat any DATABASE_URL whose host isn't loopback as "shared". The check
 * is intentionally crude — anything resolvable from the network counts,
 * including tailnet (`*.ts.net`), private IPs, and prod hostnames.
 *
 * Exported for unit tests; the safety gate in `devCommand` is the consumer.
 */
export function isSharedDatabaseUrl(databaseUrl: string): boolean {
  // Only network (postgres://) URLs can point at a shared/remote DB. Embedded
  // backends are local filesystem paths — frequently a `file://<abs path>` URL
  // (e.g. the menubar app passes `file:///Users/me/lobu/data`), whose URL
  // hostname parses as empty. Treating that empty host as "non-loopback" would
  // wrongly flag every local embedded run as shared and refuse to boot.
  if (!isExternalDatabaseUrl(databaseUrl)) return false;
  try {
    const url = new URL(databaseUrl);
    // `new URL("postgres://[::1]:5432/x").hostname` returns `[::1]` with the
    // brackets, so strip them before comparing.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

/**
 * `DATABASE_URL` is the single backend selector:
 *   - a `postgres://` / `postgresql://` URL → connect to an external Postgres
 *   - anything else (a filesystem path, optionally `file:`-prefixed) → boot a
 *     local embedded Postgres with its data under `<path>/.lobu/pgdata`
 *
 * `lobu run` defaults the path to the user's home dir when nothing is set, so a
 * bare `lobu run` still works (data at `~/.lobu/pgdata`). The runtime itself
 * always receives an explicit path — the default is injected here, at the CLI
 * frontend, exactly like the menubar app supplies its own path.
 */
export function isExternalDatabaseUrl(databaseUrl: string): boolean {
  return /^postgres(ql)?:\/\//i.test(databaseUrl.trim());
}

/**
 * Resolve the embedded data ROOT from a path-form DATABASE_URL: strips a
 * leading `file:` and expands a leading `~`. The Postgres cluster lives at
 * `<root>/.lobu/pgdata` (see embedded-runtime.ts).
 */
export function resolveEmbeddedDataRoot(databaseUrl: string): string {
  let p = databaseUrl.trim().replace(/^file:(\/\/)?/i, "");
  if (p === "~" || p.startsWith("~/")) {
    p = join(homedir(), p.slice(1));
  }
  return resolve(p);
}

/**
 * Decide whether `lobu run` must refuse to boot because the EFFECTIVE
 * DATABASE_URL points at a shared/non-local DB the project never opted into.
 *
 * `mergedEnv` gives the shell higher precedence than the project's `.env`, so
 * the project only "owns" the URL when its `.env` value is the exact one that
 * survived the merge. Gating on project-`.env` *presence* alone (the old bug)
 * let a shared/prod shell URL win silently whenever `.env` also happened to
 * define its own DATABASE_URL — re-pointing "local dev" at shared/prod data.
 *
 * Exported for unit tests; the safety gate in `devCommand` is the consumer.
 */
export function shouldRefuseSharedDatabaseUrl(input: {
  effectiveDatabaseUrl: string | undefined;
  projectEnvDatabaseUrl: string | undefined;
  unsafeSharedDb: boolean | undefined;
}): boolean {
  const effective = input.effectiveDatabaseUrl?.trim();
  if (!effective) return false;
  if (input.unsafeSharedDb) return false;

  const projectEnv = input.projectEnvDatabaseUrl?.trim();
  const projectEnvOwnsIt = !!projectEnv && projectEnv === effective;
  if (projectEnvOwnsIt) return false;

  return isSharedDatabaseUrl(effective);
}

/**
 * `lobu run` — start the embedded Lobu stack.
 *
 * `DATABASE_URL` selects the backend (see `isExternalDatabaseUrl`): a
 * `postgres://` URL connects to an external Postgres; a filesystem path boots a
 * local embedded Postgres rooted there. Unset defaults to an embedded DB at
 * `~/.lobu/pgdata`.
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

  // User-level server config from ~/.config/lobu/config.json (Mac-app
  // settings pane writes here; CLI users can also `lobu context server ...`).
  // Precedence: shell > project .env > user config > defaults.
  const userServerConfig = await getServerConfig().catch(() => undefined);
  const userServerEnv: Record<string, string> = {};
  if (userServerConfig?.port)
    userServerEnv.PORT = String(userServerConfig.port);
  if (userServerConfig?.host) userServerEnv.HOST = userServerConfig.host;

  const mergedEnv = {
    ...userServerEnv,
    ...envVars,
    ...(process.env as Record<string, string>),
  };
  // DATABASE_URL is the backend selector: a postgres:// URL → external; any
  // other value (a path) → embedded PG rooted there; unset → embedded at the
  // user's home dir. The CLI injects the path default so the runtime always
  // receives an explicit DATABASE_URL.
  const databaseUrlRaw = mergedEnv.DATABASE_URL?.trim() ?? "";
  const mode: "external" | "embedded" =
    databaseUrlRaw && isExternalDatabaseUrl(databaseUrlRaw)
      ? "external"
      : "embedded";

  // Refuse to boot against a shared/non-local external DATABASE_URL inherited
  // from the parent shell rather than the project's own .env. A common footgun:
  // "local lobu run" silently writes into prod / a teammate's tailnet DB.
  // Embedded paths are always local (not URLs), so this only fires for external
  // postgres:// URLs; project pinning in .env is explicit consent.
  if (
    shouldRefuseSharedDatabaseUrl({
      effectiveDatabaseUrl: databaseUrlRaw,
      projectEnvDatabaseUrl: envVars.DATABASE_URL,
      unsafeSharedDb: options.unsafeSharedDb,
    })
  ) {
    spinner.fail("DATABASE_URL inherited from shell points at a shared DB");
    console.error(
      chalk.red(
        `\n  Refusing to start: DATABASE_URL=${redactUrl(databaseUrlRaw)}\n`
      )
    );
    console.error(
      chalk.dim(
        `  This URL is set in your shell environment, not in ${envPath}.`
      )
    );
    console.error(
      chalk.dim(
        "  Its host isn't loopback — likely a teammate's tailnet DB or prod."
      )
    );
    console.error(
      chalk.dim(
        "  Local dev runs against this DB silently mutate shared data and"
      )
    );
    console.error(
      chalk.dim("  let prod workers race local-dev runs (see AGENTS.md).\n")
    );
    console.error(chalk.dim("  Fix one of:"));
    console.error(
      chalk.dim(
        `    • pin a project-local DB in ${envPath} (e.g. postgres://localhost/<project>_dev)`
      )
    );
    console.error(
      chalk.dim(
        "    • set DATABASE_URL to a directory path for a local embedded Postgres"
      )
    );
    console.error(
      chalk.dim(
        "    • pass --unsafe-shared-db if you really mean to share this DB\n"
      )
    );
    process.exit(1);
  }

  // Embedded: resolve the data root and pass it through as the explicit
  // DATABASE_URL path the single server bundle reads. Precedence: an explicit
  // path-form DATABASE_URL wins; else LOBU_DATA_DIR (the documented override in
  // docs/reference/cli.md); else the user's home dir. The bundle puts the
  // cluster at <root>/.lobu/pgdata.
  let embeddedDataRoot: string | null = null;
  if (mode === "embedded") {
    const dataDirOverride = mergedEnv.LOBU_DATA_DIR?.trim();
    embeddedDataRoot = resolveEmbeddedDataRoot(
      databaseUrlRaw || dataDirOverride || "~"
    );
    mergedEnv.DATABASE_URL = embeddedDataRoot;
  }

  // One bundle for both backends — it self-selects on DATABASE_URL.
  const bundlePath = resolveBackendBundle();
  if (!bundlePath) {
    spinner.fail("server bundle not found");
    console.error(
      chalk.red("\n  Could not locate the server bundle (server.bundle.mjs).\n")
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
    mode === "external"
      ? "Environment ready"
      : "Environment ready (local embedded Postgres)"
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
    if (mode === "external") {
      console.log(
        chalk.dim(`  database:      ${redactUrl(mergedEnv.DATABASE_URL!)}`)
      );
    } else {
      console.log(chalk.dim("  database:      local embedded Postgres"));
      console.log(
        chalk.dim(
          `  data:          ${join(embeddedDataRoot!, ".lobu", "pgdata")}`
        )
      );
    }
    console.log(chalk.dim(`  api docs:      ${gatewayUrl}/api/docs`));
    console.log();
  }

  const logLevel = resolveLogLevel(options);

  // Pass-through env: process.env wins so users can override per-invocation,
  // .env values fill in the rest.
  //
  // LOBU_DEV_PROJECT_PATH points the embedded server at the monorepo root so
  // it can find the `packages/agent-worker/src/index.ts` worker entry (and
  // packages/owletto). When `lobu run` is invoked from a project subdir inside the
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

  // Bundled CLIs ship the built owletto web UI next to the server bundle (see
  // packages/cli/scripts/build.cjs). Point the server at it unless the user or
  // .env already set WEB_DIST_DIR. In a monorepo checkout the bundle's sibling
  // dir has no owletto/dist, so this stays undefined and the server's own
  // monorepo-relative lookup / Vite dev path takes over.
  const bundledWebDistPath = join(dirname(bundlePath), "owletto", "dist");
  const webDistDir =
    process.env.WEB_DIST_DIR ||
    envVars.WEB_DIST_DIR ||
    (existsSync(bundledWebDistPath) ? bundledWebDistPath : undefined);

  const childEnv: Record<string, string> = {
    ...mergedEnv,
    LOBU_DEV_PROJECT_PATH: projectPath,
    // `lobu run` owns the local DB lifecycle for both backends. The embedded
    // path already migrates on boot; this flag tells the server bundle to also
    // apply migrations when pointed at an external (postgres://) DATABASE_URL,
    // so a fresh/empty local Postgres is set up before serving. Prod never sets
    // it — there a separate dbmate migration Job owns migrations.
    LOBU_RUN_OWNS_DB: "1",
    ...(providerRegistryPath
      ? { LOBU_PROVIDER_REGISTRY_PATH: providerRegistryPath }
      : {}),
    ...(webDistDir ? { WEB_DIST_DIR: webDistDir } : {}),
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

  // Once the embedded server is reachable, fetch a session token via
  // /api/local-init and print a deep-link URL. The SPA hook accepts
  // ?lobu_token=<session> and exchanges it for a cookie, so the user can
  // click the URL straight from their terminal and land logged in. Also
  // persists the session as the `local` CLI context so `lobu chat -c local`
  // works without a separate `lobu login`.
  void announceLocalSignIn(gatewayUrl, mode === "embedded").then(
    ({ ready: localContextReady, localOrgSlug }) => {
      // Once the `local` context is confirmed registered + active, push the
      // project's lobu.config.ts into the embedded DB so the scaffolded agent is
      // usable via `lobu chat -c local …` with no separate `lobu apply`.
      // Gated (see shouldAutoApplyLocalProject) AND pinned to the local URL so
      // a failed sign-in can never apply this local project to whatever
      // cloud/prod context happened to be active.
      if (
        shouldAutoApplyLocalProject({
          mode,
          localContextReady,
          hasLobuConfig: existsSync(join(cwd, "lobu.config.ts")),
        })
      ) {
        return autoApplyLocalProject(cwd, gatewayUrl, localOrgSlug);
      }
    }
  );

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
 * Whether `lobu run` should auto-apply the project. True only when:
 *  - the backend is embedded (never auto-mutate an external/prod DB), AND
 *  - the `local` context was registered + made active (so the apply targets the
 *    embedded server, not whatever cloud context was active before), AND
 *  - the project actually has a `lobu.config.ts` to apply.
 */
export function shouldAutoApplyLocalProject(opts: {
  mode: "external" | "embedded";
  localContextReady: boolean;
  hasLobuConfig: boolean;
}): boolean {
  return (
    opts.mode === "embedded" && opts.localContextReady && opts.hasLobuConfig
  );
}

/**
 * After `lobu run` boots an embedded backend, push the project's `lobu.config.ts`
 * into the local DB so the agent the user just scaffolded is immediately usable
 * (`lobu chat -c local …`) without a separate `lobu apply`. Uses the `local`
 * context that `announceLocalSignIn` just registered.
 *
 * Best-effort: a project with nothing to apply, or a transient failure, must
 * never crash the running server. The apply graph (esbuild + connector-worker
 * + SDK, pulled in by apply-cmd) is imported lazily so it stays out of
 * `lobu run`'s module-load path — see the dynamic-import allow-list in
 * AGENTS.md.
 */
export async function autoApplyLocalProject(
  cwd: string,
  gatewayUrl: string,
  localOrgSlug?: string,
  // Test seam — defaults to the lazily-imported applyCommand.
  applyImpl?: (opts: {
    cwd: string;
    yes: boolean;
    url: string;
    org?: string;
  }) => Promise<unknown>
): Promise<void> {
  try {
    const applyCommand =
      applyImpl ?? (await import("./_lib/apply/apply-cmd.js")).applyCommand;
    // Pin the apply to the embedded server's URL. `resolveApiTarget` matches
    // the `local` context by URL — and refuses to send any other context's
    // credentials to a different URL — so this can only ever target the local
    // server, never a cloud/prod org. Also pin the ORG to the embedded server's
    // bootstrap org (from /api/local-init) so a `defineConfig({ org })` naming a
    // cloud org can't redirect this local apply to a slug that doesn't exist
    // here — that previously 404'd and silently applied nothing.
    await applyCommand({
      cwd,
      yes: true,
      url: gatewayUrl,
      ...(localOrgSlug ? { org: localOrgSlug } : {}),
    });
  } catch (err) {
    console.warn(
      chalk.dim(
        `  (auto-apply skipped: ${err instanceof Error ? err.message : String(err)})`
      )
    );
  }
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
  startDir = dirname(fileURLToPath(import.meta.url))
): string | null {
  const here = startDir;
  const require_ = createRequire(import.meta.url);
  const bundleName = "server.bundle.mjs";

  for (const bundled of [
    join(here, bundleName),
    join(here, "..", bundleName),
  ]) {
    if (existsSync(bundled)) return bundled;
  }

  try {
    return require_.resolve("@lobu/server/dist/server.bundle.mjs");
  } catch {
    // not installed as a dep
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

/**
 * After the embedded server is reachable, hit POST /api/local-init for
 * a fresh session token, register a `local` CLI context pointing at the
 * gateway, persist the session as that context's bearer credential, and
 * print a deep-link URL the user can click to land logged into the SPA.
 *
 * Best-effort: a failure here (server not ready, /local-init refused
 * because real users exist, etc.) just skips the banner. The endpoint is
 * loopback-only and idempotent so it's safe to fire unconditionally.
 */
async function announceLocalSignIn(
  gatewayUrl: string,
  embedded: boolean
): Promise<{ ready: boolean; localOrgSlug?: string }> {
  // Poll briefly so the announce lands AFTER the server's own startup
  // banner without racing it.
  const reachable = await waitForServerReachable(gatewayUrl);
  if (!reachable) return { ready: false };

  // Only the embedded path seeds the bootstrap user → /local-init will refuse
  // on an external-Postgres deployment with real signups. Skip the network
  // call entirely in that case to keep the banner quiet.
  if (!embedded) return { ready: false };

  try {
    const res = await fetch(`${gatewayUrl}/api/local-init`, {
      method: "POST",
      headers: { "X-Lobu-Client": "lobu-run" },
    });
    if (!res.ok) return { ready: false };
    const body = (await res.json()) as {
      device_token?: string;
      session_token?: string;
      user?: { id?: string; email?: string; name?: string };
      organization?: { id?: string; slug?: string; name?: string };
    };
    // CLI's default token is the Better Auth session token; session auth
    // carries the user's org membership and works for admin REST + MCP calls.
    // Persist the companion worker PAT too for the gateway agent API, which
    // still authenticates that surface via worker/OAuth bearer tokens. The
    // same session token is passed to the browser deep-link URL so the SPA
    // hook reaches /api/exchange-token → Better Auth session cookie.
    const cliToken = body.session_token ?? body.device_token;
    if (!cliToken) return { ready: false };

    const contextName = "local";
    await addContext(contextName, gatewayUrl);
    const creds: Credentials = {
      accessToken: cliToken,
      ...(body.device_token ? { localWorkerToken: body.device_token } : {}),
      ...(body.user?.email ? { email: body.user.email } : {}),
      ...(body.user?.name ? { name: body.user.name } : {}),
      ...(body.user?.id ? { userId: body.user.id } : {}),
    };
    await saveCredentials(creds, contextName);
    // Bind the bootstrap org slug returned by /api/local-init to the
    // context. Without this, `lobu apply -c local` errors with
    // "No organization selected" until the user manually runs
    // `lobu org set <slug>`. The server is the source of truth — it
    // auto-provisioned this org for the install operator.
    const orgSlug = body.organization?.slug?.trim();
    if (orgSlug) {
      await setActiveOrg(orgSlug, contextName).catch(() => undefined);
    }
    // Auto-switch the active context so plain `lobu apply` / `lobu chat`
    // from any shell hit this loopback server instead of whatever cloud
    // context was active. Announce on stderr when we actually flip so the
    // user isn't surprised — `lobu run` on a fresh box silently lands on
    // `local`; `lobu run` from a shell previously on `lobu` cloud prints
    // the switch.
    try {
      const current = await getCurrentContextName();
      if (current !== contextName) {
        await setCurrentContext(contextName);
        process.stderr.write(
          `Switched active context to "${contextName}" (lobu run)\n`
        );
      }
    } catch {
      // Best-effort — failing to switch shouldn't kill the run banner.
    }

    const url = new URL(gatewayUrl);
    url.searchParams.set("lobu_token", body.session_token ?? cliToken);
    console.log();
    console.log(
      chalk.green(`  Signed in as ${body.user?.email ?? "Local Developer"}.`)
    );
    console.log(chalk.dim(`    Web UI:   `) + chalk.cyan(url.toString()));
    console.log(
      chalk.dim(`    CLI:      `) +
        chalk.cyan(`lobu chat -c ${contextName} "hello"`)
    );
    console.log();
    // The `local` context is registered, credentialed, and active — safe to
    // auto-apply the project against it. Return the bootstrap org slug so the
    // auto-apply can target the local org explicitly (a config `org:` for a
    // cloud org must not redirect the local apply — that 404s silently).
    return { ready: true, localOrgSlug: orgSlug };
  } catch {
    // Swallow — the banner is best-effort.
    return { ready: false };
  }
}

async function waitForServerReachable(
  url: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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
  let agents: Awaited<
    ReturnType<typeof loadProjectConfig>
  >["project"]["agents"];
  try {
    agents = (await loadProjectConfig(cwd)).project.agents;
  } catch {
    return;
  }

  // Hosted-bot platform entries (slack/telegram with no `config`) are reached
  // via the hosted Lobu bot; `lobu run` mints a `/lobu link <code>` for each.
  const enabled: Array<{
    agentId: string;
    platform: string;
    cfg: { surfaces?: Array<"dm" | "channel">; codeTtlMinutes?: number };
  }> = [];
  for (const agent of agents) {
    for (const p of agent.platforms ?? []) {
      if (isHostedChatEntry(p)) {
        enabled.push({
          agentId: agent.id,
          platform: p.type,
          cfg: { surfaces: p.surfaces, codeTtlMinutes: p.codeTtlMinutes },
        });
      }
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
        "\n  A hosted chat platform is configured, but no Lobu Cloud session is available."
      )
    );
    console.log(
      chalk.dim(
        "  Run `lobu login`, `lobu org set <slug>`, and `lobu apply`; then restart `lobu run` to get a link code.\n"
      )
    );
    return;
  }

  console.log(chalk.cyan("\n  Hosted chat"));
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
        ttl_minutes: cfg.codeTtlMinutes ?? 15,
      });
      console.log(chalk.dim(`  agent:    ${agentId}`));
      console.log(chalk.dim(`  platform: ${platform}`));
      console.log(chalk.dim(`  expires:  ${claim.expires_at}`));
      console.log();
      if (claim.join_url) {
        console.log(
          chalk.dim(
            `  1. Join the hosted Lobu ${platform} workspace: ${chalk.underline(claim.join_url)}`
          )
        );
        console.log(
          chalk.dim(`  2. DM @Lobu there: ${chalk.bold(claim.command)}`)
        );
      } else {
        console.log(
          chalk.dim(
            `  In the hosted Lobu ${platform} workspace, DM @Lobu: ${chalk.bold(claim.command)}`
          )
        );
      }
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

function resolveLogLevel(options: DevOptions): string | undefined {
  if (options.logLevel) return options.logLevel;
  if (options.quiet) return "warn";
  if (options.verbose) return "debug";
  return undefined;
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
