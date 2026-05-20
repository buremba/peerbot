// ─────────────────────────────────────────────────────────────────────────────
// AGENTS.md allow-list entry: the subcommand handlers below are lazy-loaded
// via `await import("./commands/...")` rather than static imports. See the
// AGENTS.md allow-list (Agent Rules → "No new dynamic imports outside the
// documented allow-list") for the documented exceptions and rationale —
// sibling entries cover the connector / apply / browser-auth codepaths and
// test files. This comment only documents the specific reason this file
// qualifies.
//
// Why: the CLI's command graph pulls in `postgres`, `playwright`, every
// `@chat-adapter/*`, the bundled server, etc. Measured boot times on a 2026
// macOS host:
//
//   lazy (current)   `lobu --help` / `--version` : ~60ms
//   static import    same invocations           : ~470-540ms (8x slower)
//
// `lobu --help` runs every time a user TAB-completes or pokes the CLI; the
// 400ms penalty is paid on every shell hit even when the user never runs the
// subcommand whose module would have been loaded. Dynamic import keeps the
// hot path (commander parses argv, prints help) free of any module the user
// didn't actually invoke. The measurement was redone after the round-2 audit
// (REPORT.md → "CLI dynamic-imports rule conflict") so future contributors
// have a fresh data point before re-litigating the rule.
//
// Rules for adding a new subcommand:
//   1. Put the handler in `./commands/<name>.ts`.
//   2. Register it with `.command(...).action(async (...) => { … })`.
//   3. Inside the action, do `const { fooCommand } = await import("./commands/foo.js");`
//      then call `fooCommand(...)`.
//   4. Do NOT hoist the import to the top of this file.
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Options shared by most cloud subcommands. `--context` is always present;
 * `--org` / `--json` are opt-in. Descriptions here are the canonical ones —
 * commands needing a different wording (e.g. "Org slug override (defaults to
 * [memory].org)") keep their own explicit `.option(...)` call.
 */
export interface CommonActionOpts {
  context?: string;
  org?: string;
  json?: boolean;
}

function withCommonOpts(
  cmd: Command,
  opts: { org?: boolean; json?: boolean } = {}
): Command {
  cmd.option("-c, --context <name>", "Use a named context");
  if (opts.org) cmd.option("--org <slug>", "Org slug override");
  if (opts.json) cmd.option("--json", "Print JSON");
  return cmd;
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

  // Group commands in --help output. Commander v14 has no native grouping,
  // so we override the help formatter via addHelpText to print our own
  // categorized list. The flat command list is still available.
  program.addHelpText(
    "after",
    `
Local dev:
  init [name]              Scaffold a new agent project
  run | dev | start        Boot the embedded Lobu stack
  chat <prompt>            Send a prompt to an agent and stream the response
  validate                 Validate lobu.toml
  doctor                   Health checks (deps, DB, pgvector, ports, keys)
  telemetry                Show / toggle anonymous error reporting

Cloud:
  login | logout           OAuth device-code login (or --token for CI)
  whoami | status          Show user / agent state
  context <subcmd>         Manage API contexts
  org <subcmd>             Manage active org slug
  link | unlink            Bind this directory to a (context, org)
  apply | deploy           Sync lobu.toml to cloud (idempotent)
  agent <subcmd>           CRUD agents via REST
  call [tool]              Invoke an admin REST tool by name (--list to discover)
  token [create]           Print or mint personal access tokens

Memory:
  memory run [tool]        Invoke a memory MCP tool
  memory exec <script>     Run a ClientSDK script
  memory health            Validate login + MCP connectivity
  memory configure         Wire OpenClaw config
  memory seed [path]       Provision a memory workspace
  memory init              Wire agents to a memory MCP endpoint
`
  );

  // ─── init ───────────────────────────────────────────────────────────
  program
    .command("init [name]")
    .description(
      "Scaffold a new agent project (lobu.toml + agent files + .env)"
    )
    .option("-y, --yes", "Skip prompts; use defaults / flag values")
    .option(
      "--here",
      "Scaffold into the current directory (alias for `init .`)"
    )
    .option("--port <port>", "Gateway port (default 8787)")
    .option("--public-url <url>", "Public gateway URL (OAuth/webhooks)")
    .option(
      "--network <policy>",
      "Worker network policy: restricted | open | isolated"
    )
    .option("--provider <id>", "Provider id from `config/providers.json`")
    .option("--provider-key <key>", "Provider API key (else read from env)")
    .option(
      "--platform <type>",
      "Chat platform: telegram | slack | discord | whatsapp | teams | gchat"
    )
    .option(
      "--memory <choice>",
      "Memory backend: none | lobu-cloud | lobu-custom"
    )
    .option(
      "--memory-url <url>",
      "Custom memory MCP URL (with --memory lobu-custom)"
    )
    .option("--otel-endpoint <url>", "OpenTelemetry collector endpoint")
    .option("--sentry", "Enable Sentry error reporting")
    .option("--no-sentry", "Disable Sentry without prompting")
    .option(
      "--slack-preview",
      "Enable public Lobu Developer Slack Preview in lobu.toml"
    )
    .option("--no-slack-preview", "Disable Slack Preview without prompting")
    .option(
      "--list-providers",
      "Print available provider ids from config/providers.json and exit"
    )
    .action(
      async (
        name: string | undefined,
        options: {
          yes?: boolean;
          here?: boolean;
          port?: string;
          publicUrl?: string;
          network?: string;
          provider?: string;
          providerKey?: string;
          platform?: string;
          memory?: string;
          memoryUrl?: string;
          otelEndpoint?: string;
          sentry?: boolean;
          slackPreview?: boolean;
          listProviders?: boolean;
        }
      ) => {
        try {
          const { initCommand } = await import("./commands/init.js");
          // Commander gives a tristate: true for --sentry, false for
          // --no-sentry, undefined for neither.
          await initCommand(process.cwd(), name, {
            yes: options.yes,
            here: options.here,
            port: options.port,
            publicUrl: options.publicUrl,
            network: options.network,
            provider: options.provider,
            providerKey: options.providerKey,
            platform: options.platform,
            memory: options.memory,
            memoryUrl: options.memoryUrl,
            otelEndpoint: options.otelEndpoint,
            sentry: options.sentry === true,
            noSentry: options.sentry === false,
            slackPreview: options.slackPreview,
            listProviders: options.listProviders,
          });
        } catch (error) {
          console.error(chalk.red("\n  Error:"), error);
          process.exit(1);
        }
      }
    );

  // ─── chat ──────────────────────────────────────────────────────────
  program
    .command("chat <prompt>")
    .description(
      "Send a prompt to an agent and stream the response. With --user, routes through Telegram/Slack."
    )
    .option("-a, --agent <id>", "Agent ID (defaults to first in lobu.toml)")
    .option("-u, --user <id>", "User ID to impersonate (e.g. telegram:12345)")
    .option("-t, --thread <id>", "Thread/conversation ID for multi-turn")
    .option(
      "-g, --gateway <url>",
      `Gateway URL (default: ${GATEWAY_DEFAULT_URL})`
    )
    .option("--dry-run", "Process without persisting history")
    .option("--new", "Force new session (ignore existing)")
    .option(
      "-C, --continue",
      "Resume the last thread for this (context, agent)"
    )
    .option(
      "--auto-approve",
      "Auto-approve every tool call (use only in trusted environments)"
    )
    .option("--json", "Emit raw SSE events as JSON lines instead of text")
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
          continue?: boolean;
          context?: string;
          autoApprove?: boolean;
          json?: boolean;
        }
      ) => {
        const { chatCommand } = await import("./commands/chat.js");
        await chatCommand(process.cwd(), prompt, options);
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

  // ─── apply / deploy ─────────────────────────────────────────────────
  program
    .command("apply")
    .alias("deploy")
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
    .option(
      "--force",
      "Bypass the project-link guard if context/org don't match"
    )
    .action(
      async (options: {
        dryRun?: boolean;
        yes?: boolean;
        only?: string;
        org?: string;
        url?: string;
        force?: boolean;
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
          force: options.force,
        });
      }
    );

  // ─── export ─────────────────────────────────────────────────────────
  program
    .command("export")
    .description(
      "Pull memory schema + connectors from the org into apply-compatible files"
    )
    .option(
      "--out <dir>",
      "Destination directory (defaults to cwd; creates models/, connectors/)"
    )
    .option("--force", "Overwrite existing models/connectors files")
    .option("--org <slug>", "Org slug override (defaults to active session)")
    .option("--url <url>", "Server URL override")
    .option(
      "--only <kind>",
      "Restrict to one resource family: 'models' | 'connectors'"
    )
    .action(
      async (options: {
        out?: string;
        force?: boolean;
        org?: string;
        url?: string;
        only?: string;
      }) => {
        if (
          options.only !== undefined &&
          options.only !== "models" &&
          options.only !== "connectors"
        ) {
          console.error(
            chalk.red("\n  Error:"),
            `--only must be 'models' or 'connectors' (got: ${options.only})`
          );
          process.exit(2);
        }
        const { exportCommand } = await import(
          "./commands/_lib/export/export-cmd.js"
        );
        await exportCommand({
          out: options.out,
          force: options.force,
          org: options.org,
          url: options.url,
          only: options.only as "models" | "connectors" | undefined,
        });
      }
    );

  // ─── run / dev / start ──────────────────────────────────────────────
  program
    .command("run")
    .aliases(["dev", "start"])
    .description(
      "Run the embedded Lobu stack (gateway + workers in one Node process)"
    )
    .option("--port <port>", "Gateway port (overrides GATEWAY_PORT in .env)")
    .option("--quiet", "Suppress startup banner; raise log level to warn")
    .option("--verbose", "Lower log level to debug")
    .option("--log-level <level>", "Forwarded as LOG_LEVEL to the bundle")
    .option(
      "--unsafe-shared-db",
      "Allow running against a non-loopback DATABASE_URL inherited from the shell"
    )
    .action(
      async (options: {
        port?: string;
        quiet?: boolean;
        verbose?: boolean;
        logLevel?: string;
        unsafeSharedDb?: boolean;
      }) => {
        const { devCommand } = await import("./commands/dev.js");
        await devCommand(process.cwd(), options);
      }
    );

  // ─── login ──────────────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("login")
      .description("Authenticate with Lobu Cloud")
      .option("--token <token>", "Use API token directly (CI/CD)")
  )
    .option("-f, --force", "Re-authenticate (revokes existing session)")
    .option(
      "-q, --quiet",
      "Suppress spinner; bail immediately if non-interactive (CI / backgrounded shells)"
    )
    .action(
      async (options: {
        token?: string;
        context?: string;
        force?: boolean;
        quiet?: boolean;
      }) => {
        const { loginCommand } = await import("./commands/login.js");
        await loginCommand({ ...options, cliVersion: version });
      }
    );

  // ─── logout ─────────────────────────────────────────────────────────
  withCommonOpts(
    program.command("logout").description("Clear stored credentials")
  ).action(async (options: { context?: string }) => {
    const { logoutCommand } = await import("./commands/logout.js");
    await logoutCommand(options);
  });

  // ─── whoami ─────────────────────────────────────────────────────────
  withCommonOpts(
    program.command("whoami").description("Show current user and linked agent")
  ).action(async (options: { context?: string }) => {
    const { whoamiCommand } = await import("./commands/whoami.js");
    await whoamiCommand(options);
  });

  // ─── token ──────────────────────────────────────────────────────────
  const token = withCommonOpts(
    program.command("token").description("Print or create Lobu access tokens")
  )
    .option("--raw", "Print token only (no labels)")
    .action(async (options: { context?: string; raw?: boolean }) => {
      const { tokenCommand } = await import("./commands/token.js");
      await tokenCommand(options);
    });

  withCommonOpts(
    token
      .command("create")
      .description("Create an org-scoped personal access token for servers/CI"),
    { org: true }
  )
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

  token
    .command("revoke <jti>")
    .description("Revoke a worker/settings token by its jti (kill switch)")
    .option(
      "--expires-at <iso>",
      "Original token expiry (ISO 8601); the revocation row is GC'd past it. Defaults to 24h from now."
    )
    .action(async (jti: string, options: { expiresAt?: string }) => {
      const { tokenRevokeCommand } = await import("./commands/token.js");
      await tokenRevokeCommand(jti, options);
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
    .requiredOption("--url <url>", "Base URL for this context")
    .option(
      "--cwd <path>",
      "Working directory the lifecycle owner cd's into before spawning `lobu run` (used by per-worktree contexts)"
    )
    .option(
      "--lifecycle <mode>",
      "managed | external — managed means the menubar spawns `lobu run`",
      (value: string) => {
        if (value !== "managed" && value !== "external") {
          throw new Error(`--lifecycle must be 'managed' or 'external'`);
        }
        return value;
      }
    )
    .action(
      async (
        name: string,
        options: {
          url: string;
          cwd?: string;
          lifecycle?: "managed" | "external";
        }
      ) => {
        const { contextAddCommand } = await import("./commands/context.js");
        await contextAddCommand({
          name,
          url: options.url,
          cwd: options.cwd,
          lifecycle: options.lifecycle,
        });
      }
    );

  context
    .command("use <name>")
    .description("Set the active context")
    .action(async (name: string) => {
      const { contextUseCommand } = await import("./commands/context.js");
      await contextUseCommand(name);
    });

  context
    .command("rm <name>")
    .description("Remove a named context (idempotent)")
    .action(async (name: string) => {
      const { contextRmCommand } = await import("./commands/context.js");
      await contextRmCommand(name);
    });

  // ─── status ─────────────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("status")
      .description("Show agent status from the active org"),
    { org: true }
  ).action(async (options: { context?: string; org?: string }) => {
    const { statusCommand } = await import("./commands/status.js");
    await statusCommand(options);
  });

  // ─── org ────────────────────────────────────────────────────────────
  const org = program.command("org").description("Manage active Lobu org");

  withCommonOpts(
    org
      .command("list")
      .description("List organizations available to the current login")
  ).action(async (options: { context?: string }) => {
    const { orgListCommand } = await import("./commands/org.js");
    await orgListCommand(options);
  });

  withCommonOpts(
    org.command("current").description("Show the active org")
  ).action(async (options: { context?: string }) => {
    const { orgCurrentCommand } = await import("./commands/org.js");
    await orgCurrentCommand(options);
  });

  withCommonOpts(
    org.command("set <slug>").description("Set the active org slug")
  ).action(async (slug: string, options: { context?: string }) => {
    const { orgSetCommand } = await import("./commands/org.js");
    await orgSetCommand(slug, options);
  });

  withCommonOpts(
    org
      .command("create <slug>")
      .description(
        "Open the browser to create an organization (slug pre-filled)"
      )
      .option("-n, --name <name>", "Organization display name")
  ).action(
    async (slug: string, options: { name?: string; context?: string }) => {
      const { orgCreateCommand } = await import("./commands/org.js");
      await orgCreateCommand(slug, options);
    }
  );

  // ─── link / unlink ──────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("link")
      .description(
        "Bind the current directory to a (context, org). Stored at .lobu/project.json."
      )
      .option("--org <slug>", "Org slug to link (defaults to active)")
  ).action(async (options: { context?: string; org?: string }) => {
    const { linkCommand } = await import("./commands/link.js");
    await linkCommand(options);
  });

  program
    .command("unlink")
    .description("Remove the project link file")
    .action(async () => {
      const { unlinkCommand } = await import("./commands/link.js");
      await unlinkCommand();
    });

  // ─── agent ──────────────────────────────────────────────────────────
  const agent = program
    .command("agent")
    .description("Manage agents via the same REST API as the web app");

  withCommonOpts(agent.command("list").description("List agents"), {
    org: true,
    json: true,
  }).action(
    async (options: { context?: string; org?: string; json?: boolean }) => {
      const { agentListCommand } = await import("./commands/agent.js");
      await agentListCommand(options);
    }
  );

  withCommonOpts(agent.command("get <agentId>").description("Get an agent"), {
    org: true,
  }).action(
    async (agentId: string, options: { context?: string; org?: string }) => {
      const { agentGetCommand } = await import("./commands/agent.js");
      await agentGetCommand(agentId, options);
    }
  );

  withCommonOpts(
    agent
      .command("create <agentId>")
      .description("Create an agent")
      .option("--name <name>", "Display name")
      .option("--description <text>", "Description"),
    { org: true, json: true }
  ).action(
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
    .command("scaffold <agentId>")
    .description(
      "Add a new local agent (agents/<id>/* + lobu.toml entry) without overwriting existing ones"
    )
    .option("--name <name>", "Display name")
    .option("--description <text>", "Description")
    .action(
      async (
        agentId: string,
        options: { name?: string; description?: string }
      ) => {
        const { agentScaffoldCommand } = await import("./commands/agent.js");
        await agentScaffoldCommand(agentId, options);
      }
    );

  withCommonOpts(
    agent
      .command("update <agentId>")
      .description("Update agent metadata")
      .option("--name <name>", "Display name")
      .option("--description <text>", "Description"),
    { org: true, json: true }
  ).action(
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

  withCommonOpts(
    agent
      .command("delete <agentId>")
      .description("Delete an agent")
      .option("--yes", "Confirm deletion"),
    { org: true }
  ).action(
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

  withCommonOpts(
    agentConfig
      .command("get <agentId>")
      .description("Print agent config JSON")
      .option("--output <file>", "Write JSON to a file"),
    { org: true }
  ).action(
    async (
      agentId: string,
      options: { output?: string; context?: string; org?: string }
    ) => {
      const { agentConfigGetCommand } = await import("./commands/agent.js");
      await agentConfigGetCommand(agentId, options);
    }
  );

  withCommonOpts(
    agentConfig
      .command("patch <agentId>")
      .description("Patch agent config from a JSON file")
      .requiredOption(
        "--file <file>",
        "JSON file with config fields to update"
      ),
    { org: true, json: true }
  ).action(
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

  // ─── call ───────────────────────────────────────────────────────────
  // Generic dispatcher over the admin REST tool surface
  // (`POST /api/<org>/<tool>`). Replaces the urge to add bespoke
  // per-action commands (`lobu sync`, `lobu retry-feed`, ...) by exposing
  // every UI-callable tool through one entry point. `lobu memory run` is
  // kept alongside intentionally — it routes via MCP JSON-RPC, this one via
  // the REST proxy. See packages/cli/src/commands/call.ts for the arg shape.
  const call = withCommonOpts(
    program
      .command("call [tool]")
      .description(
        "Invoke an admin REST tool by name (POST /api/<org>/<tool>). Run with --list or no args to discover."
      )
      .option(
        "--list",
        "List tools available to the current token (default when called bare)"
      )
      .option("--all", "Include internal/admin-only tools in --list output")
      .option(
        "--input-file <path>",
        "Read the JSON args body from a file (top-level object)"
      )
      .option(
        "--arg <entry>",
        "Add a top-level arg as key=string or key:=<json> (repeatable)",
        (value: string, previous: string[] | undefined) =>
          previous ? [...previous, value] : [value]
      )
      .option("--raw", "Emit compact JSON (default is pretty-printed)")
      .option("--url <url>", "Server URL override"),
    { org: true, json: true }
  ).action(
    async (
      tool: string | undefined,
      options: {
        org?: string;
        context?: string;
        json?: boolean;
        list?: boolean;
        all?: boolean;
        inputFile?: string;
        arg?: string[];
        raw?: boolean;
        url?: string;
      }
    ) => {
      const { callCommand } = await import("./commands/call.js");
      await callCommand(tool, options);
    }
  );
  // Silence unused-variable lint — `call` is the Commander handle, retained
  // for symmetry with sibling command groups in case subcommands are added.
  void call;

  // ─── connector ──────────────────────────────────────────────────────
  const connector = program
    .command("connector")
    .description(
      "Run connectors locally against an auth profile (no feed required)"
    );
  connector
    .command("run [connector_key]")
    .description(
      "Execute a connector locally; events stream to stdout, nothing is persisted"
    )
    .option(
      "--auth-profile <slug>",
      "Auth profile slug (browser_session only in v1)"
    )
    .option(
      "--config <json>",
      'Feed config as JSON object (e.g. \'{"start_url":"https://..."}\')'
    )
    .option(
      "--checkpoint-from-feed <id>",
      "Borrow checkpoint state from this feed id"
    )
    .option(
      "--from-feed <id>",
      "Resolve connector + auth + config + checkpoint from this feed id"
    )
    .option("--max-items <n>", "Cap pagination to this many items")
    .option("--check", "Resolve + validate without executing the connector")
    .option("--json", "Emit machine-readable JSON to stdout (artifact-shaped)")
    .option("-c, --context <name>", "Use a named context")
    .option("--url <url>", "Server URL override")
    .option("--org <slug>", "Org slug override")
    .action(async (connectorKey: string | undefined, options) => {
      const { connectorRunCommand } = await import("./commands/connector.js");
      await connectorRunCommand(connectorKey, options);
    });

  // ─── doctor ─────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Health checks (deps, DB, pgvector, ports, provider keys)")
    .option("--memory-only", "Only check memory MCP connectivity + auth")
    .action(async (options: { memoryOnly?: boolean }) => {
      const { doctorCommand } = await import("./commands/doctor.js");
      await doctorCommand(options);
    });

  // ─── telemetry ──────────────────────────────────────────────────────
  const telemetry = program
    .command("telemetry")
    .description("Show or toggle anonymous error reporting (Sentry)");
  telemetry
    .command("status", { isDefault: true })
    .description("Show whether telemetry is on or off")
    .action(async () => {
      const { telemetryStatusCommand } = await import(
        "./commands/telemetry.js"
      );
      await telemetryStatusCommand();
    });
  telemetry
    .command("on")
    .description("Enable telemetry (writes SENTRY_DSN to .env)")
    .option("--dsn <dsn>", "Custom Sentry DSN (defaults to Lobu's)")
    .action(async (options: { dsn?: string }) => {
      const { telemetryOnCommand } = await import("./commands/telemetry.js");
      await telemetryOnCommand(options);
    });
  telemetry
    .command("off")
    .description("Disable telemetry (removes SENTRY_DSN from .env)")
    .action(async () => {
      const { telemetryOffCommand } = await import("./commands/telemetry.js");
      await telemetryOffCommand();
    });

  // ─── memory ─────────────────────────────────────────────────────────
  const memory = program
    .command("memory")
    .description("Lobu memory MCP — tools, seeding, and client configuration");

  const memoryOrg = memory
    .command("org")
    .description("Manage active organization for memory MCP");
  withCommonOpts(
    memoryOrg.command("current").description("Show the active org")
  ).action(async (options: { context?: string }) => {
    const { memoryOrgCurrentCommand } = await import(
      "./commands/memory/org.js"
    );
    await memoryOrgCurrentCommand(options);
  });
  withCommonOpts(
    memoryOrg.command("set <slug>").description("Set the active org slug")
  ).action(async (slug: string, options: { context?: string }) => {
    const { memoryOrgSetCommand } = await import("./commands/memory/org.js");
    await memoryOrgSetCommand(slug, options);
  });

  withCommonOpts(
    memory
      .command("run [tool] [params]")
      .description("Invoke an MCP tool (or list tools when called bare)")
      .option("--url <url>", "Server URL override"),
    { org: true }
  ).action(
    async (
      tool: string | undefined,
      params: string | undefined,
      options: { url?: string; org?: string; context?: string }
    ) => {
      const { memoryRunCommand } = await import("./commands/memory/run.js");
      await memoryRunCommand(tool, params, options);
    }
  );

  withCommonOpts(
    memory
      .command("exec <script>")
      .description("Run a TypeScript ClientSDK script via the memory MCP")
      .option("--url <url>", "Server URL override"),
    { org: true }
  ).action(
    async (
      script: string,
      options: { url?: string; org?: string; context?: string }
    ) => {
      const { memoryRunCommand } = await import("./commands/memory/run.js");
      await memoryRunCommand("run_sdk", JSON.stringify({ script }), options);
    }
  );

  withCommonOpts(
    memory
      .command("health")
      .description("Validate Lobu login + MCP connectivity")
      .option("--url <url>", "Server URL override"),
    { org: true }
  ).action(
    async (options: { url?: string; org?: string; context?: string }) => {
      const { memoryHealthCommand } = await import(
        "./commands/memory/health.js"
      );
      await memoryHealthCommand(options);
    }
  );

  withCommonOpts(
    memory
      .command("configure")
      .description(
        "Write OpenClaw plugin config pointing at the active memory MCP"
      )
      .option("--url <url>", "Server URL override"),
    { org: true }
  )
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
      "Provision a Lobu memory workspace from [memory] in lobu.toml + ./models + optional ./data"
    )
    .option("--dry-run", "Log what would be created without mutating")
    .option("--org <slug>", "Org slug override (defaults to [memory].org)")
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
