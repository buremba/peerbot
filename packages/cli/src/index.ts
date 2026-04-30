import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import { Command } from "commander";
import { GATEWAY_DEFAULT_URL } from "./internal/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getPackageVersion(): Promise<string> {
  const pkgPath = join(__dirname, "..", "package.json");
  const pkgContent = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function handleCliError(error: unknown): void {
  const exitCode =
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
      ? (error as { exitCode: number }).exitCode
      : 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red("\n  Error:"), message);
  process.exitCode = exitCode;
}

export async function runCli(
  argv: readonly string[] = process.argv
): Promise<void> {
  const program = new Command();
  const version = await getPackageVersion();

  program
    .name("lobu")
    .description("CLI for deploying and managing AI agents on Lobu")
    .version(version);

  // ─── init ───────────────────────────────────────────────────────────
  program
    .command("init [name]")
    .description(
      "Scaffold a new agent project (lobu.toml + agent files + .env)"
    )
    .action(async (name?: string) => {
      try {
        const { initCommand } = await import("./commands/init.js");
        await initCommand(process.cwd(), name);
      } catch (error) {
        console.error(chalk.red("\n  Error:"), error);
        process.exit(1);
      }
    });

  // ─── chat ──────────────────────────────────────────────────────────
  program
    .command("chat <prompt>")
    .description("Send a prompt to an agent and stream the response")
    .option("-a, --agent <id>", "Agent ID (defaults to first in lobu.toml)")
    .option("-u, --user <id>", "User ID to impersonate (e.g. telegram:12345)")
    .option("-t, --thread <id>", "Thread/conversation ID for multi-turn")
    .option(
      "-g, --gateway <url>",
      `Gateway URL (default: ${GATEWAY_DEFAULT_URL})`
    )
    .option("--dry-run", "Process without persisting history")
    .option("--new", "Force new session (ignore existing)")
    .option("-c, --context <name>", "Use a named context")
    .action(
      async (
        prompt: string,
        options: {
          agent?: string;
          gateway?: string;
          user?: string;
          thread?: string;
          dryRun?: boolean;
          new?: boolean;
          context?: string;
        }
      ) => {
        const { chatCommand } = await import("./commands/chat.js");
        await chatCommand(process.cwd(), prompt, options);
      }
    );

  // ─── eval ──────────────────────────────────────────────────────────
  program
    .command("eval [name]")
    .description("Run agent evaluations")
    .option("-a, --agent <id>", "Agent ID (defaults to first in lobu.toml)")
    .option(
      "-g, --gateway <url>",
      `Gateway URL (default: ${GATEWAY_DEFAULT_URL})`
    )
    .option(
      "-m, --model <model>",
      "Model to eval (e.g. claude/sonnet, openai/gpt-4.1)"
    )
    .option("--trials <n>", "Override trial count", parseInt)
    .option("--list", "List available evals without running them")
    .option("--ci", "CI mode: JSON output, non-zero exit on failure")
    .option("--output <file>", "Write results to JSON file")
    .action(
      async (
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
      ) => {
        const { evalCommand } = await import("./commands/eval.js");
        await evalCommand(process.cwd(), name, options);
      }
    );

  // ─── validate ───────────────────────────────────────────────────────
  program
    .command("validate")
    .description("Validate lobu.toml schema, skill IDs, and provider config")
    .action(async () => {
      const { validateCommand } = await import("./commands/validate.js");
      const valid = await validateCommand(process.cwd());
      if (!valid) process.exit(1);
    });

  // ─── apply ──────────────────────────────────────────────────────────
  // One-way `lobu.toml` → cloud org converger. GETs current state, renders
  // a diff, prompts to confirm, then loops over the existing CRUD endpoints
  // in dependency order. Re-running converges on partial failure.
  program
    .command("apply")
    .description(
      "Sync lobu.toml + agent dirs to your Lobu Cloud org (idempotent)"
    )
    .option("--dry-run", "Show the plan and exit without mutating")
    .option("--yes", "Skip the confirmation prompt (CI mode)")
    .option(
      "--only <kind>",
      "Restrict to one resource family: 'agents' | 'memory'"
    )
    .option("--org <slug>", "Org slug override (defaults to active session)")
    .option("--url <url>", "Server URL override")
    .action(
      async (options: {
        dryRun?: boolean;
        yes?: boolean;
        only?: string;
        org?: string;
        url?: string;
      }) => {
        if (
          options.only !== undefined &&
          options.only !== "agents" &&
          options.only !== "memory"
        ) {
          console.error(
            chalk.red("\n  Error:"),
            `--only must be 'agents' or 'memory' (got: ${options.only})`
          );
          process.exit(2);
        }
        const { lobuApplyCommand } = await import("./commands/apply.js");
        await lobuApplyCommand({
          dryRun: options.dryRun,
          yes: options.yes,
          only: options.only as "agents" | "memory" | undefined,
          org: options.org,
          url: options.url,
        });
      }
    );

  // ─── run ────────────────────────────────────────────────────────────
  // Boots the embedded Lobu stack (gateway + workers + memory backend) as
  // a single Node process. Extra args are forwarded to the bundle entry.
  program
    .command("run")
    .description(
      "Run the embedded Lobu stack (gateway + workers in one Node process)"
    )
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (_opts: unknown, cmd: Command) => {
      const { devCommand } = await import("./commands/dev.js");
      await devCommand(process.cwd(), cmd.args);
    });

  // ─── login ──────────────────────────────────────────────────────────
  program
    .command("login")
    .description("Authenticate with Lobu Cloud")
    .option("--token <token>", "Use API token directly (CI/CD)")
    .option("-c, --context <name>", "Use a named context")
    .option("-f, --force", "Re-authenticate (revokes existing session)")
    .action(
      async (options: {
        token?: string;
        context?: string;
        force?: boolean;
      }) => {
        const { loginCommand } = await import("./commands/login.js");
        await loginCommand({ ...options, cliVersion: version });
      }
    );

  // ─── logout ─────────────────────────────────────────────────────────
  program
    .command("logout")
    .description("Clear stored credentials")
    .option("-c, --context <name>", "Use a named context")
    .action(async (options: { context?: string }) => {
      const { logoutCommand } = await import("./commands/logout.js");
      await logoutCommand(options);
    });

  // ─── whoami ─────────────────────────────────────────────────────────
  program
    .command("whoami")
    .description("Show current user and linked agent")
    .option("-c, --context <name>", "Use a named context")
    .action(async (options: { context?: string }) => {
      const { whoamiCommand } = await import("./commands/whoami.js");
      await whoamiCommand(options);
    });

  // ─── token ──────────────────────────────────────────────────────────
  program
    .command("token")
    .description("Print the current Lobu access token")
    .option("-c, --context <name>", "Use a named context")
    .option("--raw", "Print token only (no labels)")
    .action(async (options: { context?: string; raw?: boolean }) => {
      const { tokenCommand } = await import("./commands/token.js");
      await tokenCommand(options);
    });

  // ─── context ────────────────────────────────────────────────────────
  const context = program
    .command("context")
    .description("Manage Lobu API contexts");

  context
    .command("list")
    .description("List configured contexts")
    .action(async () => {
      const { contextListCommand } = await import("./commands/context.js");
      await contextListCommand();
    });

  context
    .command("current")
    .description("Show the active context")
    .action(async () => {
      const { contextCurrentCommand } = await import("./commands/context.js");
      await contextCurrentCommand();
    });

  context
    .command("add <name>")
    .description("Add a named context")
    .requiredOption("--api-url <url>", "API base URL for this context")
    .action(async (name: string, options: { apiUrl: string }) => {
      const { contextAddCommand } = await import("./commands/context.js");
      await contextAddCommand({ name, apiUrl: options.apiUrl });
    });

  context
    .command("use <name>")
    .description("Set the active context")
    .action(async (name: string) => {
      const { contextUseCommand } = await import("./commands/context.js");
      await contextUseCommand(name);
    });

  // ─── status ─────────────────────────────────────────────────────────
  program
    .command("status")
    .description("Agent health and version info")
    .action(async () => {
      const { statusCommand } = await import("./commands/status.js");
      await statusCommand(process.cwd());
    });

  // ─── secrets ────────────────────────────────────────────────────────
  const secrets = program
    .command("secrets")
    .description("Manage agent secrets");

  secrets
    .command("set <key> <value>")
    .description("Set a secret (stored in local .env for dev)")
    .action(async (key: string, value: string) => {
      const { secretsSetCommand } = await import("./commands/secrets.js");
      await secretsSetCommand(process.cwd(), key, value);
    });

  secrets
    .command("list")
    .description("List secrets (values redacted)")
    .action(async () => {
      const { secretsListCommand } = await import("./commands/secrets.js");
      await secretsListCommand(process.cwd());
    });

  secrets
    .command("delete <key>")
    .description("Remove a secret")
    .action(async (key: string) => {
      const { secretsDeleteCommand } = await import("./commands/secrets.js");
      await secretsDeleteCommand(process.cwd(), key);
    });

  // ─── providers ──────────────────────────────────────────────────────
  const providers = program
    .command("providers")
    .description("Browse and manage LLM providers");

  providers
    .command("list")
    .description("Browse available LLM providers")
    .action(async () => {
      const { providersListCommand } = await import(
        "./commands/providers/list.js"
      );
      await providersListCommand();
    });

  providers
    .command("add <id>")
    .description("Add a provider to lobu.toml")
    .action(async (id: string) => {
      const { providersAddCommand } = await import(
        "./commands/providers/add.js"
      );
      await providersAddCommand(process.cwd(), id);
    });

  // ─── skills ─────────────────────────────────────────────────────────
  const skills = program
    .command("skills")
    .description(
      "Install bundled starter skills into the local skills/ directory"
    );

  skills
    .command("list")
    .description("List bundled starter skills")
    .action(async () => {
      const { skillsListCommand } = await import("./commands/skills/list.js");
      await skillsListCommand();
    });

  skills
    .command("add <id>")
    .description("Install a bundled starter skill into skills/<id>")
    .option(
      "-d, --dir <path>",
      "Target directory (defaults to current working directory)"
    )
    .option("-f, --force", "Overwrite an existing skills/<id> directory")
    .action(async (id: string, options: { dir?: string; force?: boolean }) => {
      const { skillsAddCommand } = await import("./commands/skills/add.js");
      await skillsAddCommand(process.cwd(), id, options);
    });

  // ─── platforms ──────────────────────────────────────────────────────
  const platforms = program
    .command("platforms")
    .description("Manage chat platforms");

  platforms
    .command("list")
    .description("List configured platforms per agent")
    .action(async () => {
      const { platformsListCommand } = await import(
        "./commands/platforms/list.js"
      );
      await platformsListCommand(process.cwd());
    });

  platforms
    .command("add <platform>")
    .description(
      "Add a chat platform (telegram, slack, discord, whatsapp, teams, gchat)"
    )
    .action(async (platform: string) => {
      const { platformsAddCommand } = await import(
        "./commands/platforms/add.js"
      );
      await platformsAddCommand(process.cwd(), platform);
    });

  // ─── doctor ─────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Health checks (system deps, memory MCP)")
    .option("--memory-only", "Only check memory MCP connectivity + auth")
    .action(async (options: { memoryOnly?: boolean }) => {
      const { doctorCommand } = await import("./commands/doctor.js");
      await doctorCommand(options);
    });

  // ─── memory ─────────────────────────────────────────────────────────
  // Memory operations live under the Lobu CLI. Auth is top-level (`lobu login`);
  // memory subcommands only configure endpoints and call tools.
  const memory = program
    .command("memory")
    .description("Lobu memory MCP — tools, seeding, and client configuration");

  const memoryOrg = memory
    .command("org")
    .description("Manage active organization for memory MCP");
  memoryOrg
    .command("current")
    .description("Show the active org")
    .action(async () => {
      const { memoryOrgCurrentCommand } = await import(
        "./commands/memory/org.js"
      );
      memoryOrgCurrentCommand();
    });
  memoryOrg
    .command("set <slug>")
    .description("Set the active org slug")
    .action(async (slug: string) => {
      const { memoryOrgSetCommand } = await import("./commands/memory/org.js");
      memoryOrgSetCommand(slug);
    });

  memory
    .command("run [tool] [params]")
    .description("Invoke an MCP tool (or list tools when called bare)")
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .action(
      async (
        tool: string | undefined,
        params: string | undefined,
        options: { url?: string; org?: string }
      ) => {
        const { memoryRunCommand } = await import("./commands/memory/run.js");
        await memoryRunCommand(tool, params, options);
      }
    );

  memory
    .command("health")
    .description("Validate Lobu login + MCP connectivity")
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .action(async (options: { url?: string; org?: string }) => {
      const { memoryHealthCommand } = await import(
        "./commands/memory/health.js"
      );
      await memoryHealthCommand(options);
    });

  memory
    .command("configure")
    .description(
      "Write OpenClaw plugin config pointing at the active memory MCP"
    )
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .option(
      "--config-path <path>",
      "OpenClaw config path (defaults to ~/.openclaw/openclaw.json)"
    )
    .option(
      "--token-command <cmd>",
      "Override the plugin's token retrieval command"
    )
    .action(
      async (options: {
        url?: string;
        org?: string;
        configPath?: string;
        tokenCommand?: string;
      }) => {
        const { memoryConfigureCommand } = await import(
          "./commands/memory/configure.js"
        );
        memoryConfigureCommand(options);
      }
    );

  memory
    .command("seed [path]")
    .description(
      "Provision a Lobu memory workspace from [memory.owletto] in lobu.toml + ./models + optional ./data"
    )
    .option("--dry-run", "Log what would be created without mutating")
    .option(
      "--org <slug>",
      "Org slug override (defaults to [memory.owletto].org)"
    )
    .option("--url <url>", "Server URL override")
    .action(
      async (
        pathArg: string | undefined,
        options: {
          dryRun?: boolean;
          org?: string;
          url?: string;
        }
      ) => {
        const { memorySeedCommand } = await import("./commands/memory/seed.js");
        await memorySeedCommand(pathArg, options);
      }
    );

  memory
    .command("init")
    .description("Wire an existing project's agents to a memory MCP endpoint")
    .option("--url <url>", "MCP server URL (skips the picker)")
    .option("--agent <id>", "Configure a specific agent only")
    .option("--skip-auth", "Skip the authentication step")
    .action(
      async (options: { url?: string; agent?: string; skipAuth?: boolean }) => {
        const { memoryInitCommand } = await import("./commands/memory/init.js");
        await memoryInitCommand(options);
      }
    );

  memory
    .command("browser-auth")
    .description(
      "Capture cookies from your local Chrome browser for a connector"
    )
    .requiredOption("--connector <key>", 'Connector key (e.g. "x")')
    .option("--domains <list>", "Comma-separated cookie domains override")
    .option(
      "--chrome-profile <name>",
      "Chrome profile name (interactive prompt if not specified)"
    )
    .option(
      "--auth-profile-slug <slug>",
      "Browser auth profile slug to store cookies on"
    )
    .option(
      "--launch-cdp",
      "Launch a dedicated Chrome user-data-dir with remote debugging enabled"
    )
    .option(
      "--remote-debug-port <port>",
      "Remote debugging port for --launch-cdp",
      "9222"
    )
    .option(
      "--dedicated-profile <name>",
      "Dedicated Chrome profile dir name for --launch-cdp"
    )
    .option(
      "--check",
      "Check if stored cookies for a browser auth profile are still valid"
    )
    .action(
      async (options: {
        connector: string;
        domains?: string;
        chromeProfile?: string;
        authProfileSlug?: string;
        launchCdp?: boolean;
        remoteDebugPort?: string;
        dedicatedProfile?: string;
        check?: boolean;
      }) => {
        const { memoryBrowserAuthCommand } = await import(
          "./commands/memory/browser-auth.js"
        );
        await memoryBrowserAuthCommand(options);
      }
    );

  try {
    await program.parseAsync(argv);
  } catch (error) {
    handleCliError(error);
  }
}
