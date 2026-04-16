import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { promptPlatformConfig } from "../commands/connections/platforms.js";
import { secretsSetCommand } from "../commands/secrets.js";
import {
  getProviderById,
  loadProviderRegistry,
  type RegistryProvider,
} from "../commands/providers/registry.js";
import { renderTemplate } from "../utils/template.js";

const DEFAULT_OWLETTO_MCP_URL = "https://owletto.com/mcp";
const LOCAL_OWLETTO_MCP_URL = "http://owletto:8787/mcp";

export async function initCommand(
  cwd: string = process.cwd(),
  projectNameArg?: string
): Promise<void> {
  console.log(chalk.bold.cyan("\n🤖 Welcome to Lobu!\n"));

  // Get CLI version
  const cliVersion = await getCliVersion();

  // Validate project name if provided as argument
  if (projectNameArg && !/^[a-z0-9-]+$/.test(projectNameArg)) {
    console.log(
      chalk.red(
        "\n✗ Project name must be lowercase alphanumeric with hyphens only\n"
      )
    );
    process.exit(1);
  }

  // Interactive prompts - basic setup
  const baseAnswers = await inquirer.prompt([
    {
      type: "input",
      name: "projectName",
      message: "Project name?",
      default: projectNameArg || "my-lobu",
      validate: (input: string) => {
        if (!/^[a-z0-9-]+$/.test(input)) {
          return "Project name must be lowercase alphanumeric with hyphens only";
        }
        return true;
      },
      when: !projectNameArg, // Skip prompt if project name provided as argument
    },
  ]);

  // Use project name from argument or prompt
  const projectName = projectNameArg || baseAnswers.projectName;
  const projectDir = join(cwd, projectName);
  try {
    await access(projectDir, constants.F_OK);
    console.log(
      chalk.red(
        `\n✗ Directory "${projectName}" already exists. Please choose a different project name or remove the existing directory.\n`
      )
    );
    process.exit(1);
  } catch {
    // Directory doesn't exist - good to proceed
    await mkdir(projectDir, { recursive: true });
    console.log(
      chalk.dim(`\nCreating project in: ${chalk.cyan(projectDir)}\n`)
    );
  }

  // Deployment mode selection
  const { deploymentMode } = await inquirer.prompt([
    {
      type: "list",
      name: "deploymentMode",
      message: "How should workers run?",
      choices: [
        {
          name: "Embedded — virtual bash & filesystem, no package installs, lower resource usage",
          value: "embedded",
        },
        {
          name: "Docker — isolated containers per user, full OS access, heavier but more capable",
          value: "docker",
        },
      ],
      default: "embedded",
    },
  ]);

  // Gateway port selection
  const { gatewayPort } = await inquirer.prompt([
    {
      type: "input",
      name: "gatewayPort",
      message: "Gateway port?",
      default: "8080",
      validate: (input: string) => {
        const port = Number(input);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return "Please enter a valid port number (1-65535)";
        }
        return true;
      },
    },
  ]);

  // Public gateway URL (optional — only needed for OAuth callbacks and external webhooks)
  const { publicGatewayUrl } = await inquirer.prompt([
    {
      type: "input",
      name: "publicGatewayUrl",
      message:
        "Public gateway URL? (leave empty for local dev, set for OAuth/webhooks)",
      default: "",
    },
  ]);

  // Admin password
  const { adminPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "adminPassword",
      message: "Admin password?",
      mask: "*",
      validate: (input: string) => {
        if (!input || input.length < 4) {
          return "Password must be at least 4 characters";
        }
        return true;
      },
    },
  ]);

  // Worker network access policy
  const { networkPolicy } = await inquirer.prompt([
    {
      type: "list",
      name: "networkPolicy",
      message: "Worker network access?",
      choices: [
        {
          name: "Restricted (recommended) — common registries only (npm, GitHub, PyPI)",
          value: "restricted",
        },
        {
          name: "Open — workers can access any domain",
          value: "open",
        },
        {
          name: "Isolated — workers have no internet access",
          value: "isolated",
        },
      ],
      default: "restricted",
    },
  ]);

  // Provider selection (from the bundled providers registry)
  const providerSkills = loadProviderRegistry();
  const providerChoices = [
    { name: "Skip — I'll add a provider later", value: "" },
    ...providerSkills.map((s) => ({
      name: `${s.providers![0]!.displayName}${s.providers![0]!.defaultModel ? ` (${s.providers![0]!.defaultModel})` : ""}`,
      value: s.id,
    })),
  ];

  const { providerId } = await inquirer.prompt([
    {
      type: "list",
      name: "providerId",
      message: "AI provider?",
      choices: providerChoices,
      default: "",
    },
  ]);

  let providerApiKey = "";
  let selectedProvider: RegistryProvider | undefined;
  if (providerId) {
    selectedProvider = getProviderById(providerId);
    const p = selectedProvider?.providers?.[0];
    if (p) {
      const { apiKey } = await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message: `${p.displayName} API key:`,
          mask: "*",
        },
      ]);
      providerApiKey = apiKey || "";
    }
  }

  // Define skills locally via skills/<name>/SKILL.md or
  // agents/<id>/skills/<name>/SKILL.md.

  // Connection (messaging platform) selection
  const platformChoices = [
    { name: "Skip — I'll connect a platform later", value: "" },
    { name: "Telegram", value: "telegram" },
    { name: "Slack", value: "slack" },
    { name: "Discord", value: "discord" },
    { name: "WhatsApp", value: "whatsapp" },
    { name: "Microsoft Teams", value: "teams" },
    { name: "Google Chat", value: "gchat" },
  ];

  const { platformType } = await inquirer.prompt([
    {
      type: "list",
      name: "platformType",
      message: "Connect a messaging platform?",
      choices: platformChoices,
      default: "",
    },
  ]);

  const { connectionConfig, connectionSecrets } = platformType
    ? await promptPlatformConfig(platformType)
    : { connectionConfig: {}, connectionSecrets: [] };

  // Memory
  const { memoryChoice } = await inquirer.prompt([
    {
      type: "list",
      name: "memoryChoice",
      message: "Memory:",
      choices: [
        { name: "None (filesystem memory)", value: "none" },
        { name: "Owletto Cloud (owletto.com)", value: "owletto-cloud" },
        {
          name: "Owletto Local (runs alongside gateway)",
          value: "owletto-local",
        },
        { name: "Custom Owletto URL", value: "owletto-custom" },
      ],
      default: "none",
    },
  ]);

  const envSecrets: Array<{ envVar: string; value: string }> = [];
  const includeOwlettoMemory = memoryChoice !== "none";
  let includeOwlettoLocal = false;
  let owlettoUrl = "";

  if (memoryChoice === "owletto-cloud") {
    owlettoUrl = DEFAULT_OWLETTO_MCP_URL;
  } else if (memoryChoice === "owletto-local") {
    includeOwlettoLocal = true;
    owlettoUrl = LOCAL_OWLETTO_MCP_URL;
    envSecrets.push({ envVar: "MEMORY_URL", value: owlettoUrl });
    envSecrets.push({
      envVar: "OWLETTO_AUTH_SECRET",
      value: randomBytes(32).toString("hex"),
    });
    envSecrets.push({
      envVar: "OWLETTO_DB_PASSWORD",
      value: randomBytes(16).toString("hex"),
    });
  } else if (memoryChoice === "owletto-custom") {
    const { customOwlettoUrl } = await inquirer.prompt([
      {
        type: "input",
        name: "customOwlettoUrl",
        message: "Owletto MCP URL:",
        validate: (v: string) => (v ? true : "URL is required"),
      },
    ]);
    owlettoUrl = customOwlettoUrl;
    envSecrets.push({ envVar: "MEMORY_URL", value: owlettoUrl });
  }
  // "none" — no Owletto scaffold, gateway defaults to filesystem memory

  // Observability — OTEL tracing endpoint
  const { otelEndpoint } = await inquirer.prompt([
    {
      type: "input",
      name: "otelEndpoint",
      message:
        "OpenTelemetry collector endpoint? (leave empty to disable tracing)",
      default: "",
    },
  ]);

  if (otelEndpoint) {
    envSecrets.push({
      envVar: "OTEL_EXPORTER_OTLP_ENDPOINT",
      value: otelEndpoint,
    });
  }

  // Observability — Sentry error reporting
  const { enableSentry } = await inquirer.prompt([
    {
      type: "confirm",
      name: "enableSentry",
      message:
        "Help improve Lobu by sharing anonymous error reports with Sentry?",
      default: true,
    },
  ]);

  if (enableSentry) {
    envSecrets.push({
      envVar: "SENTRY_DSN",
      value:
        "https://c5910e58d1a134d64ff93a95a9c535bb@o4507291398897664.ingest.us.sentry.io/4511097466781696",
    });
  }

  // Compute network domains from selected policy
  let allowedDomains: string;
  let disallowedDomains: string;
  if (networkPolicy === "open") {
    allowedDomains = "*";
    disallowedDomains = "";
  } else if (networkPolicy === "isolated") {
    allowedDomains = "";
    disallowedDomains = "";
  } else {
    // restricted (default)
    allowedDomains = [
      "registry.npmjs.org",
      ".npmjs.org",
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "cdn.jsdelivr.net",
      "unpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
    ].join(",");
    disallowedDomains = "";
  }
  const encryptionKey = randomBytes(32).toString("hex");

  const answers = {
    ...baseAnswers,
    deploymentMode: deploymentMode as "embedded" | "docker",
    encryptionKey,
    allowedDomains,
    disallowedDomains,
  };

  // docker-compose.yml will be created in new directory, no need to check
  const composeFilename = "docker-compose.yml";

  const spinner = ora("Creating Lobu project...").start();

  try {
    // Create data directory in project directory
    await mkdir(join(projectDir, "data"), { recursive: true });

    if (includeOwlettoMemory) {
      await generateOwlettoProjectLayout(projectDir, {
        org: projectName,
        name: humanizeSlug(projectName),
      });
    }

    // Generate lobu.toml
    await generateLobuToml(projectDir, {
      agentName: projectName,
      allowedDomains: answers.allowedDomains,
      providerId: providerId || undefined,
      providerEnvVar: selectedProvider?.providers?.[0]?.envVarName,
      providerModel: selectedProvider?.providers?.[0]?.defaultModel,
      connectionType: platformType || undefined,
      connectionConfig:
        Object.keys(connectionConfig).length > 0 ? connectionConfig : undefined,
      includeOwlettoMemory,
    });

    const variables = {
      PROJECT_NAME: projectName,
      CLI_VERSION: cliVersion,
      DEPLOYMENT_MODE: answers.deploymentMode,
      ADMIN_PASSWORD: adminPassword,
      ENCRYPTION_KEY: answers.encryptionKey,
      GATEWAY_PORT: gatewayPort,
      WORKER_ALLOWED_DOMAINS: answers.allowedDomains,
      WORKER_DISALLOWED_DOMAINS: answers.disallowedDomains,
    };

    // Create .env file
    await renderTemplate(".env.tmpl", variables, join(projectDir, ".env"));

    // Save public gateway URL if explicitly set
    if (publicGatewayUrl) {
      await secretsSetCommand(
        projectDir,
        "PUBLIC_GATEWAY_URL",
        publicGatewayUrl
      );
    }

    // Save provider API key to .env
    if (providerApiKey && selectedProvider?.providers?.[0]?.envVarName) {
      await secretsSetCommand(
        projectDir,
        selectedProvider.providers[0].envVarName,
        providerApiKey
      );
    }

    // Save connection secrets to .env
    for (const secret of connectionSecrets) {
      await secretsSetCommand(projectDir, secret.envVar, secret.value);
    }

    // Save OAuth secrets to .env
    for (const secret of envSecrets) {
      await secretsSetCommand(projectDir, secret.envVar, secret.value);
    }

    // Create .gitignore
    await renderTemplate(".gitignore.tmpl", {}, join(projectDir, ".gitignore"));

    // Create README
    await renderTemplate(
      "README.md.tmpl",
      variables,
      join(projectDir, "README.md")
    );

    // Create agent directory with instruction files
    const agentDir = join(projectDir, "agents", projectName);
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "IDENTITY.md"),
      `# Identity\n\nYou are ${projectName}, a helpful AI assistant.\n`
    );
    await writeFile(
      join(agentDir, "SOUL.md"),
      `# Instructions\n\nBe concise and helpful. Ask clarifying questions when the request is ambiguous.\n`
    );
    await writeFile(
      join(agentDir, "USER.md"),
      `# User Context\n\n<!-- Add user-specific preferences, timezone, environment details here -->\n`
    );

    // Create agent-specific skills directory
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", ".gitkeep"), "");

    // Create evals directory with sample eval
    await mkdir(join(agentDir, "evals"), { recursive: true });
    await writeFile(
      join(agentDir, "evals", "ping.yaml"),
      `version: 1
name: ping
description: Agent responds to a simple greeting
trials: 3
timeout: 30
tags: [smoke, fast]

turns:
  - content: "Hello, are you there?"
    assert:
      - type: contains
        value: "hello"
        options: { case_insensitive: true }
        weight: 0.3
      - type: llm-rubric
        value: "Response is friendly and acknowledges the greeting"
        weight: 0.7
`
    );

    // Create shared skills directory
    await mkdir(join(projectDir, "skills"), { recursive: true });
    await writeFile(join(projectDir, "skills", ".gitkeep"), "");

    // Create AGENTS.md
    await renderTemplate(
      "AGENTS.md.tmpl",
      variables,
      join(projectDir, "AGENTS.md")
    );

    // Create TESTING.md
    await renderTemplate(
      "TESTING.md.tmpl",
      variables,
      join(projectDir, "TESTING.md")
    );

    if (answers.deploymentMode === "docker") {
      // Create Dockerfile.worker for docker mode
      await renderTemplate(
        "Dockerfile.worker.tmpl",
        variables,
        join(projectDir, "Dockerfile.worker")
      );
    }

    // Always generate docker-compose.yml (Redis is needed for all modes)
    const composeContent = generateDockerCompose({
      projectName,
      gatewayPort,
      dockerfilePath: "./Dockerfile.worker",
      deploymentMode: answers.deploymentMode,
      includeOwlettoLocal,
    });
    await writeFile(join(projectDir, composeFilename), composeContent);

    spinner.succeed("Project created successfully!");

    // Print next steps
    console.log(chalk.green("\n✓ Lobu initialized!\n"));
    console.log(chalk.bold("Next steps:\n"));
    console.log(chalk.cyan("  1. Navigate to your project:"));
    console.log(chalk.dim(`     cd ${projectName}\n`));
    console.log(chalk.cyan("  2. Review your configuration:"));
    console.log(
      chalk.dim(
        "     - lobu.toml                    (agents, providers, skills, network)"
      )
    );
    console.log(
      chalk.dim(
        `     - agents/${projectName}/   (IDENTITY.md, SOUL.md, USER.md, skills/)`
      )
    );
    console.log(
      chalk.dim(
        "     - skills/                      (shared skills — all agents)"
      )
    );
    if (includeOwlettoMemory) {
      console.log(
        chalk.dim(
          "     - owletto.yaml                 (Owletto project config)"
        )
      );
      console.log(
        chalk.dim("     - models/                      (Owletto model files)")
      );
      console.log(
        chalk.dim("     - data/                        (Owletto seed data)")
      );
    }
    console.log(chalk.dim("     - .env                         (secrets)"));
    console.log(chalk.dim(`     - ${composeFilename}`));
    if (answers.deploymentMode === "docker") {
      console.log(chalk.dim("     - Dockerfile.worker"));
    }
    console.log();

    const gatewayUrl = `http://localhost:${gatewayPort}`;
    if (owlettoUrl) {
      const displayUrl = includeOwlettoLocal
        ? "http://localhost:8787"
        : owlettoUrl;
      console.log(chalk.cyan("  Owletto:"));
      console.log(chalk.dim(`     ${displayUrl}\n`));
    }
    console.log(chalk.cyan("  3. Start the services:"));
    console.log(chalk.dim("     npx @lobu/cli@latest run -d\n"));
    if (includeOwlettoLocal) {
      console.log(chalk.cyan("  4. Set up Owletto (first run):"));
      console.log(
        chalk.dim("     Visit http://localhost:8787 to create your account\n")
      );
    }
    console.log(
      chalk.cyan(`  ${includeOwlettoLocal ? "5" : "4"}. Open the API docs:`)
    );
    console.log(chalk.dim(`     ${gatewayUrl}/api/docs\n`));
    console.log(
      chalk.cyan(
        `  ${includeOwlettoLocal ? "6" : "5"}. Build with a coding agent:`
      )
    );
    console.log(
      chalk.dim(
        "     Ask Codex or Claude Code to read AGENTS.md, lobu.toml, and agents/*/{IDENTITY,SOUL,USER}.md"
      )
    );
    console.log(chalk.dim("     Optional external skill: lobu-builder\n"));
    console.log(chalk.cyan(`  ${includeOwlettoLocal ? "7" : "6"}. View logs:`));
    console.log(chalk.dim("     docker compose logs -f\n"));
    console.log(
      chalk.cyan(`  ${includeOwlettoLocal ? "8" : "7"}. Stop the services:`)
    );
    console.log(chalk.dim("     docker compose down\n"));
  } catch (error) {
    spinner.fail("Failed to create project");
    throw error;
  }
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generateOwlettoProjectLayout(
  projectDir: string,
  options: {
    org: string;
    name: string;
    description?: string;
  }
): Promise<void> {
  await mkdir(join(projectDir, "models"), { recursive: true });
  await mkdir(join(projectDir, "data", "entities"), { recursive: true });
  await mkdir(join(projectDir, "data", "relationships"), {
    recursive: true,
  });

  await writeFile(
    join(projectDir, "owletto.yaml"),
    [
      "version: 1",
      `org: ${options.org}`,
      `name: ${JSON.stringify(options.name)}`,
      ...(options.description
        ? [`description: ${JSON.stringify(options.description)}`]
        : []),
      "",
    ].join("\n")
  );

  await writeFile(join(projectDir, "models", ".gitkeep"), "");
  await writeFile(join(projectDir, "data", "entities", ".gitkeep"), "");
  await writeFile(join(projectDir, "data", "relationships", ".gitkeep"), "");
}

export async function generateLobuToml(
  projectDir: string,
  options: {
    agentName: string;
    allowedDomains: string;
    providerId?: string;
    providerEnvVar?: string;
    providerModel?: string;
    connectionType?: string;
    connectionConfig?: Record<string, string>;
    includeOwlettoMemory?: boolean;
  }
): Promise<void> {
  const id = options.agentName;
  const lines: string[] = [
    "# lobu.toml — Agent configuration",
    "# Docs: https://lobu.ai/docs/getting-started",
    "#",
    "# Each [agents.{id}] defines an agent. The dir field points to a directory",
    "# containing IDENTITY.md, SOUL.md, USER.md, and optionally skills/.",
    "# Shared skills in the root skills/ directory are available to all agents.",
    "",
    `[agents.${id}]`,
    `name = "${id}"`,
    `description = ""`,
    `dir = "./agents/${id}"`,
    "",
    "# LLM providers (order = priority, key = API key or $ENV_VAR)",
  ];

  if (options.providerId && options.providerEnvVar) {
    lines.push(
      `[[agents.${id}.providers]]`,
      `id = "${options.providerId}"`,
      ...(options.providerModel ? [`model = "${options.providerModel}"`] : []),
      `key = "$${options.providerEnvVar}"`
    );
  } else {
    lines.push(
      "# Add providers via the gateway configuration APIs or uncomment below:",
      `# [[agents.${id}.providers]]`,
      '# id = "anthropic"',
      '# key = "$ANTHROPIC_API_KEY"'
    );
  }

  lines.push("");

  if (options.connectionType && options.connectionConfig) {
    lines.push(
      `[[agents.${id}.connections]]`,
      `type = "${options.connectionType}"`
    );
    lines.push(`[agents.${id}.connections.config]`);
    for (const [key, value] of Object.entries(options.connectionConfig)) {
      lines.push(`${key} = "${value}"`);
    }
  } else {
    lines.push(
      "# Messaging platform (add via the gateway configuration APIs or uncomment below):",
      `# [[agents.${id}.connections]]`,
      '# type = "telegram"',
      `# [agents.${id}.connections.config]`,
      '# botToken = "$TELEGRAM_BOT_TOKEN"'
    );
  }

  lines.push(
    "",
    "# Local skills live in skills/<name>/SKILL.md or agents/<id>/skills/<name>/SKILL.md",
    `[agents.${id}.skills]`,
    "",
    "# MCP servers (add custom tool servers with optional OAuth):",
    `# [agents.${id}.skills.mcp.my-mcp]`,
    '# url = "https://my-mcp.example.com"',
    `# [agents.${id}.skills.mcp.my-mcp.oauth]`,
    '# auth_url = "https://auth.example.com/authorize"',
    '# token_url = "https://auth.example.com/token"',
    '# client_id = "$MY_MCP_CLIENT_ID"'
  );

  // Network
  lines.push("", `[agents.${id}.network]`);
  if (options.allowedDomains) {
    const domains = options.allowedDomains
      .split(",")
      .map((d) => `"${d.trim()}"`)
      .join(", ");
    lines.push(`allowed = [${domains}]`);
  } else {
    lines.push("allowed = []");
  }

  if (options.includeOwlettoMemory) {
    lines.push(
      "",
      "# Project-scoped Owletto memory",
      `[memory.owletto]`,
      "enabled = true",
      'config = "./owletto.yaml"',
      'models = "./models"',
      'data = "./data"'
    );
  }

  lines.push(""); // trailing newline
  await writeFile(join(projectDir, "lobu.toml"), lines.join("\n"));
}

async function getCliVersion(): Promise<string> {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkgContent = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent);
  return pkg.version || "0.1.0";
}

export function generateDockerCompose(options: {
  projectName: string;
  gatewayPort: string;
  dockerfilePath: string;
  deploymentMode: "embedded" | "docker";
  includeOwlettoLocal?: boolean;
}): string {
  const { projectName, gatewayPort, deploymentMode, includeOwlettoLocal } =
    options;
  const gatewayImage = `ghcr.io/lobu-ai/lobu-gateway:latest`;
  const workerImage = `ghcr.io/lobu-ai/lobu-worker-base:latest`;

  const dockerSocketMount =
    deploymentMode === "docker"
      ? `
      - /var/run/docker.sock:/var/run/docker.sock`
      : "";

  const workerImageEnv =
    deploymentMode === "docker"
      ? `
      WORKER_IMAGE: ${workerImage}`
      : "";

  const proxyPort =
    deploymentMode === "docker"
      ? `
      - "127.0.0.1:8118:8118" # HTTP proxy for workers`
      : "";

  const owlettoServices = includeOwlettoLocal
    ? `
  owletto-postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: owletto
      POSTGRES_PASSWORD: \${OWLETTO_DB_PASSWORD}
      POSTGRES_DB: owletto
    volumes:
      - owletto-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U owletto -d owletto"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks:
      - lobu-internal
    restart: unless-stopped

  owletto:
    image: ghcr.io/lobu-ai/owletto-app:latest
    pull_policy: always
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      DATABASE_URL: postgresql://owletto:\${OWLETTO_DB_PASSWORD}@owletto-postgres:5432/owletto
      BETTER_AUTH_SECRET: \${OWLETTO_AUTH_SECRET}
      PORT: "8787"
      HOST: 0.0.0.0
    networks:
      - lobu-internal
    depends_on:
      owletto-postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://127.0.0.1:8787/health || exit 1"]
      interval: 10s
      timeout: 10s
      retries: 10
      start_period: 20s
    restart: unless-stopped
`
    : "";

  const owlettoDependsOn = includeOwlettoLocal
    ? `
      owletto:
        condition: service_healthy`
    : "";

  const owlettoVolumes = includeOwlettoLocal
    ? `
volumes:
  owletto-pgdata:
`
    : "";

  return `# Generated by @lobu/cli
# Deployment mode: ${deploymentMode}

name: ${projectName}

services:
  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy noeviction --save 60 1 --dir /data
    working_dir: /tmp
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3
    networks:
      - lobu-internal
    restart: unless-stopped
${owlettoServices}
  gateway:
    image: ${gatewayImage}
    pull_policy: always
    ports:
      - "127.0.0.1:\${GATEWAY_PORT:-${gatewayPort}}:8080"${proxyPort}
    environment:
      DEPLOYMENT_MODE: ${deploymentMode}${workerImageEnv}
      QUEUE_URL: redis://redis:6379/0
      PUBLIC_GATEWAY_URL: \${PUBLIC_GATEWAY_URL:-}
      GATEWAY_PORT: \${GATEWAY_PORT:-${gatewayPort}}
      NODE_ENV: production
      COMPOSE_PROJECT_NAME: ${projectName}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      ENCRYPTION_KEY: \${ENCRYPTION_KEY}
      WORKER_ALLOWED_DOMAINS: \${WORKER_ALLOWED_DOMAINS:-}
      WORKER_DISALLOWED_DOMAINS: \${WORKER_DISALLOWED_DOMAINS:-}
      # Optional Owletto base MCP URL override. File-first projects derive scoped
      # memory from [memory.owletto] in lobu.toml and owletto.yaml.
      MEMORY_URL: \${MEMORY_URL:-}
      LOBU_WORKSPACE_ROOT: /workspace/project
      # Provider API keys — passthrough any that are set in the host env so
      # agents can reference them as \`$VAR\` in lobu.toml. Unset vars expand
      # to empty strings and are ignored by the agent runtime.
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
      GEMINI_API_KEY: \${GEMINI_API_KEY:-}
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      OPENROUTER_API_KEY: \${OPENROUTER_API_KEY:-}
      Z_AI_API_KEY: \${Z_AI_API_KEY:-}
      # Platform credentials — same pattern: set only the ones your agents use.
      SLACK_BOT_TOKEN: \${SLACK_BOT_TOKEN:-}
      SLACK_SIGNING_SECRET: \${SLACK_SIGNING_SECRET:-}
      TELEGRAM_BOT_TOKEN: \${TELEGRAM_BOT_TOKEN:-}
    volumes:${dockerSocketMount}
      - .:/workspace/project:ro
    networks:
      - lobu-public
      - lobu-internal
    depends_on:
      redis:
        condition: service_healthy${owlettoDependsOn}
    restart: unless-stopped

networks:
  lobu-public:
    driver: bridge
  lobu-internal:
    internal: true
    driver: bridge
${owlettoVolumes}
`;
}
