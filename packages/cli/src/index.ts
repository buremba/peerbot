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
    .option("-c, --context <name>", "Use a named context")
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
          context?: string;
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
        const { applyCommand } = await import(
          "./commands/_lib/apply/apply-cmd.js"
        );
        await applyCommand({
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
  const token = program
    .command("token")
    .description("Print or create Lobu access tokens")
    .option("-c, --context <name>", "Use a named context")
    .option("--raw", "Print token only (no labels)")
    .action(async (options: { context?: string; raw?: boolean }) => {
      const { tokenCommand } = await import("./commands/token.js");
      await tokenCommand(options);
    });

  token
    .command("create")
    .description("Create an org-scoped personal access token for servers/CI")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .option("--name <name>", "Token name (default: lobu-cli-YYYY-MM-DD)")
    .option("--description <text>", "Token description")
    .option(
      "--scope <scope>",
      "Space-separated scopes (default: mcp:read mcp:write)"
    )
    .option(
      "--expires-in-days <days>",
      "Expire token after N days",
      (value) => {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 1) {
          throw new Error("--expires-in-days must be a positive integer");
        }
        return days;
      }
    )
    .option("--raw", "Print token only")
    .option("--json", "Print JSON response")
    .action(
      async (options: {
        context?: string;
        org?: string;
        name?: string;
        description?: string;
        scope?: string;
        expiresInDays?: number;
        raw?: boolean;
        json?: boolean;
      }) => {
        const { tokenCreateCommand } = await import("./commands/token.js");
        await tokenCreateCommand(options);
      }
    );

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
    .description("Show agent status from the active org")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .action(async (options: { context?: string; org?: string }) => {
      const { statusCommand } = await import("./commands/status.js");
      await statusCommand(options);
    });

  // ─── org ────────────────────────────────────────────────────────────
  const org = program.command("org").description("Manage active Lobu org");

  org
    .command("list")
    .description("List organizations available to the current login")
    .option("-c, --context <name>", "Use a named context")
    .action(async (options: { context?: string }) => {
      const { orgListCommand } = await import("./commands/org.js");
      await orgListCommand(options);
    });

  org
    .command("current")
    .description("Show the active org")
    .option("-c, --context <name>", "Use a named context")
    .action(async (options: { context?: string }) => {
      const { orgCurrentCommand } = await import("./commands/org.js");
      await orgCurrentCommand(options);
    });

  org
    .command("set <slug>")
    .description("Set the active org slug")
    .option("-c, --context <name>", "Use a named context")
    .action(async (slug: string, options: { context?: string }) => {
      const { orgSetCommand } = await import("./commands/org.js");
      await orgSetCommand(slug, options);
    });

  // ─── agent ──────────────────────────────────────────────────────────
  const agent = program
    .command("agent")
    .description("Manage agents via the same REST API as the web app");

  agent
    .command("list")
    .description("List agents")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .option("--json", "Print JSON")
    .action(
      async (options: { context?: string; org?: string; json?: boolean }) => {
        const { agentListCommand } = await import("./commands/agent.js");
        await agentListCommand(options);
      }
    );

  agent
    .command("get <agentId>")
    .description("Get an agent")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .action(
      async (agentId: string, options: { context?: string; org?: string }) => {
        const { agentGetCommand } = await import("./commands/agent.js");
        await agentGetCommand(agentId, options);
      }
    );

  agent
    .command("create <agentId>")
    .description("Create an agent")
    .option("--name <name>", "Display name")
    .option("--description <text>", "Description")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .option("--json", "Print JSON")
    .action(
      async (
        agentId: string,
        options: {
          name?: string;
          description?: string;
          context?: string;
          org?: string;
          json?: boolean;
        }
      ) => {
        const { agentCreateCommand } = await import("./commands/agent.js");
        await agentCreateCommand(agentId, options);
      }
    );

  agent
    .command("update <agentId>")
    .description("Update agent metadata")
    .option("--name <name>", "Display name")
    .option("--description <text>", "Description")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .option("--json", "Print JSON")
    .action(
      async (
        agentId: string,
        options: {
          name?: string;
          description?: string;
          context?: string;
          org?: string;
          json?: boolean;
        }
      ) => {
        const { agentUpdateCommand } = await import("./commands/agent.js");
        await agentUpdateCommand(agentId, options);
      }
    );

  agent
    .command("delete <agentId>")
    .description("Delete an agent")
    .option("--yes", "Confirm deletion")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .action(
      async (
        agentId: string,
        options: { yes?: boolean; context?: string; org?: string }
      ) => {
        const { agentDeleteCommand } = await import("./commands/agent.js");
        await agentDeleteCommand(agentId, options);
      }
    );

  const agentConfig = agent
    .command("config")
    .description("Read or patch agent config");

  agentConfig
    .command("get <agentId>")
    .description("Print agent config JSON")
    .option("--output <file>", "Write JSON to a file")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .action(
      async (
        agentId: string,
        options: { output?: string; context?: string; org?: string }
      ) => {
        const { agentConfigGetCommand } = await import("./commands/agent.js");
        await agentConfigGetCommand(agentId, options);
      }
    );

  agentConfig
    .command("patch <agentId>")
    .description("Patch agent config from a JSON file")
    .requiredOption("--file <file>", "JSON file with config fields to update")
    .option("-c, --context <name>", "Use a named context")
    .option("--org <slug>", "Org slug override")
    .option("--json", "Print JSON")
    .action(
      async (
        agentId: string,
        options: {
          file: string;
          context?: string;
          org?: string;
          json?: boolean;
        }
      ) => {
        const { agentConfigPatchCommand } = await import("./commands/agent.js");
        await agentConfigPatchCommand(agentId, options);
      }
    );

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
    .option("-c, --context <name>", "Use a named context")
    .action(async (options: { context?: string }) => {
      const { memoryOrgCurrentCommand } = await import(
        "./commands/memory/org.js"
      );
      await memoryOrgCurrentCommand(options);
    });
  memoryOrg
    .command("set <slug>")
    .description("Set the active org slug")
    .option("-c, --context <name>", "Use a named context")
    .action(async (slug: string, options: { context?: string }) => {
      const { memoryOrgSetCommand } = await import("./commands/memory/org.js");
      await memoryOrgSetCommand(slug, options);
    });

  memory
    .command("run [tool] [params]")
    .description("Invoke an MCP tool (or list tools when called bare)")
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .option("-c, --context <name>", "Use a named context")
    .action(
      async (
        tool: string | undefined,
        params: string | undefined,
        options: { url?: string; org?: string; context?: string }
      ) => {
        const { memoryRunCommand } = await import("./commands/memory/run.js");
        await memoryRunCommand(tool, params, options);
      }
    );

  memory
    .command("exec <script>")
    .description("Run a TypeScript ClientSDK script via the memory MCP")
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .option("-c, --context <name>", "Use a named context")
    .action(
      async (
        script: string,
        options: { url?: string; org?: string; context?: string }
      ) => {
        const { memoryRunCommand } = await import("./commands/memory/run.js");
        await memoryRunCommand("run", JSON.stringify({ script }), options);
      }
    );

  memory
    .command("health")
    .description("Validate Lobu login + MCP connectivity")
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .option("-c, --context <name>", "Use a named context")
    .action(
      async (options: { url?: string; org?: string; context?: string }) => {
        const { memoryHealthCommand } = await import(
          "./commands/memory/health.js"
        );
        await memoryHealthCommand(options);
      }
    );

  memory
    .command("configure")
    .description(
      "Write OpenClaw plugin config pointing at the active memory MCP"
    )
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .option("-c, --context <name>", "Use a named context")
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
        context?: string;
        configPath?: string;
        tokenCommand?: string;
      }) => {
        const { memoryConfigureCommand } = await import(
          "./commands/memory/configure.js"
        );
        await memoryConfigureCommand(options);
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
    .option("-c, --context <name>", "Use a named context")
    .action(
      async (
        pathArg: string | undefined,
        options: {
          dryRun?: boolean;
          org?: string;
          url?: string;
          context?: string;
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
