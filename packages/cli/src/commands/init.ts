import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { isPortFree } from "./dev.js";
import { promptPlatformConfig } from "../commands/platforms/platform-prompts.js";
import { setLocalEnvValue } from "../internal/local-env.js";
import {
  getProviderById,
  loadProviderRegistry,
  type RegistryProvider,
} from "../commands/providers/registry.js";
import { renderTemplate } from "../utils/template.js";

const DEFAULT_LOBU_MCP_URL = "https://lobu.ai/mcp";

const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;
const PLATFORM_CHOICES = [
  "telegram",
  "slack",
  "discord",
  "whatsapp",
  "teams",
  "gchat",
] as const;
type PlatformChoice = (typeof PLATFORM_CHOICES)[number];
const NETWORK_CHOICES = ["restricted", "open", "isolated"] as const;
type NetworkChoice = (typeof NETWORK_CHOICES)[number];
const MEMORY_CHOICES = ["none", "lobu-cloud", "lobu-custom"] as const;
type MemoryChoice = (typeof MEMORY_CHOICES)[number];

export interface InitOptions {
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
  noSentry?: boolean;
  slackPreview?: boolean;
  listProviders?: boolean;
}

async function pickFreePort(
  start: number,
  opts: { max?: number; avoid?: number[] } = {}
): Promise<number> {
  const max = opts.max ?? 100;
  const avoid = new Set(opts.avoid ?? []);
  for (let i = 0; i < max; i++) {
    const candidate = start + i;
    if (candidate > 65535) break;
    if (avoid.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  // Fall back to the starting port — the user can resolve the collision at
  // `lobu run` time.
  return start;
}

/**
 * The hardcoded `ClaudeOAuthModule` (providerId="claude") on the gateway
 * already handles both Anthropic OAuth tokens AND raw ANTHROPIC_API_KEY via
 * the same upstream slug. We surface it as a synthetic `--provider claude`
 * choice (with `anthropic` accepted as an alias) so scaffold users can pick
 * Claude without having to know about openrouter or the OAuth flow.
 */
const SYNTHETIC_CLAUDE_PROVIDER: RegistryProvider = {
  id: "claude",
  name: "Claude (Anthropic)",
  description: "Claude models via the native Anthropic API",
  providers: [
    {
      displayName: "Claude (Anthropic)",
      envVarName: "ANTHROPIC_API_KEY",
      upstreamBaseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-4-20250514",
      apiKeyInstructions:
        "Get your API key from https://console.anthropic.com/settings/keys",
    },
  ],
};

const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "claude",
};

function resolveProviderAlias(id: string): string {
  return PROVIDER_ALIASES[id] ?? id;
}

function getAllProviders(): RegistryProvider[] {
  return [SYNTHETIC_CLAUDE_PROVIDER, ...loadProviderRegistry()];
}

function getProviderByIdWithSynth(id: string): RegistryProvider | undefined {
  const resolved = resolveProviderAlias(id);
  if (resolved === SYNTHETIC_CLAUDE_PROVIDER.id) {
    return SYNTHETIC_CLAUDE_PROVIDER;
  }
  return getProviderById(resolved);
}

function printProviderList(): void {
  const providers = getAllProviders();
  if (providers.length === 0) {
    console.log(
      chalk.yellow(
        "No providers registered. Check that config/providers.json is reachable."
      )
    );
    return;
  }
  console.log(chalk.bold("\nAvailable providers:\n"));
  const idCol = Math.max(...providers.map((p) => p.id.length));
  for (const p of providers) {
    const first = p.providers?.[0];
    const env = first?.envVarName ?? "";
    const model = first?.defaultModel ? ` — ${first.defaultModel}` : "";
    const aliases = Object.entries(PROVIDER_ALIASES)
      .filter(([, target]) => target === p.id)
      .map(([alias]) => alias);
    const aliasSuffix =
      aliases.length > 0 ? chalk.dim(`  (alias: ${aliases.join(", ")})`) : "";
    console.log(
      `  ${chalk.cyan(p.id.padEnd(idCol))}  ${chalk.dim(env)}${chalk.dim(model)}${aliasSuffix}`
    );
  }
  console.log(
    chalk.dim(
      "\nPass to scaffold: lobu init <name> --provider <id> [--provider-key <key>]\n"
    )
  );
}

export async function initCommand(
  cwd: string = process.cwd(),
  projectNameArg?: string,
  options: InitOptions = {}
): Promise<void> {
  const cliVersion = await getCliVersion();
  const useDefaults = options.yes === true;

  if (options.listProviders) {
    printProviderList();
    return;
  }

  // Catch flag combos that can't satisfy a prompt before we mkdir anything.
  if (useDefaults && options.memory === "lobu-custom" && !options.memoryUrl) {
    console.error(
      chalk.red("\n✗ --memory lobu-custom requires --memory-url <url>.\n")
    );
    process.exit(1);
  }

  const here = options.here || projectNameArg === ".";
  let projectName: string;
  let projectDir: string;

  if (here) {
    projectDir = cwd;
    projectName = basename(resolve(cwd));
    if (!PROJECT_NAME_PATTERN.test(projectName)) {
      // Common when cwd is e.g. "My Project". Force user to pick a slug.
      projectName =
        projectNameArg && projectNameArg !== "."
          ? projectNameArg
          : await promptOrDefault({
              flag: undefined,
              useDefaults,
              defaultValue: slugify(basename(resolve(cwd))) || "my-lobu",
              prompt: () =>
                input({
                  message: "Project slug?",
                  default: slugify(basename(resolve(cwd))) || "my-lobu",
                  validate: validateProjectName,
                }),
            });
    }
    const entries = await readdir(projectDir).catch(() => [] as string[]);
    const conflict = entries.some(
      (n) => n === "lobu.toml" || n === "agents" || n === ".env"
    );
    if (conflict) {
      console.log(
        chalk.red(
          `\n✗ ${projectDir} already contains a Lobu project (lobu.toml / agents/ / .env).\n  Remove them or pick another directory.\n`
        )
      );
      process.exit(1);
    }
    console.log(
      chalk.dim(
        `\nScaffolding into current directory: ${chalk.cyan(projectDir)}\n`
      )
    );
  } else {
    if (projectNameArg && !PROJECT_NAME_PATTERN.test(projectNameArg)) {
      console.log(
        chalk.red(
          `\n✗ Project name must be lowercase alphanumeric with hyphens only (got: ${projectNameArg}).\n`
        )
      );
      process.exit(1);
    }
    projectName =
      projectNameArg ??
      (await promptOrDefault({
        flag: undefined,
        useDefaults,
        defaultValue: "my-lobu",
        prompt: () =>
          input({
            message: "Project name?",
            default: "my-lobu",
            validate: validateProjectName,
          }),
      }));
    projectDir = join(cwd, projectName);
    try {
      await access(projectDir, constants.F_OK);
      console.log(
        chalk.red(
          `\n✗ Directory "${projectName}" already exists. Pick a different name, remove it, or pass \`--here\` to scaffold into the current directory.\n`
        )
      );
      process.exit(1);
    } catch {
      await mkdir(projectDir, { recursive: true });
      console.log(
        chalk.dim(`\nCreating project in: ${chalk.cyan(projectDir)}\n`)
      );
    }
  }

  // Pick free ports at scaffold time so two `lobu run`s on the same machine
  // don't collide on the default 8787 / 8118. The flag / env value wins.
  const gatewayPortDefault = String(await pickFreePort(8787));
  const gatewayPort = await promptOrDefault({
    flag: options.port,
    useDefaults,
    defaultValue: gatewayPortDefault,
    validate: (value: string) => {
      const p = Number(value);
      return Number.isInteger(p) && p >= 1 && p <= 65535
        ? true
        : "Please enter a valid port (1-65535)";
    },
    prompt: () =>
      input({
        message: "Gateway port?",
        default: gatewayPortDefault,
        validate: (value: string) => {
          const p = Number(value);
          if (!Number.isInteger(p) || p < 1 || p > 65535) {
            return "Please enter a valid port number (1-65535)";
          }
          return true;
        },
      }),
  });

  // WORKER_PROXY_PORT is the gateway's outbound HTTP proxy that workers route
  // through (default 8118). Scaffold a non-colliding port so co-resident
  // projects don't fight over it. Avoid the gateway port too — if the user
  // passed `--port 8118` we don't want both vars pointing at the same number.
  const gatewayPortNum = Number(gatewayPort);
  const workerProxyPort = String(
    await pickFreePort(8118, {
      avoid: Number.isFinite(gatewayPortNum) ? [gatewayPortNum] : [],
    })
  );

  const publicGatewayUrl = await promptOrDefault({
    flag: options.publicUrl,
    useDefaults,
    defaultValue: "",
    prompt: () =>
      input({
        message:
          "Public gateway URL? (leave empty for local dev, set for OAuth/webhooks)",
        default: "",
      }),
  });

  const networkPolicy = (await promptOrDefault({
    flag: options.network,
    useDefaults,
    defaultValue: "restricted",
    validate: (v: string) =>
      (NETWORK_CHOICES as readonly string[]).includes(v)
        ? true
        : `Must be one of: ${NETWORK_CHOICES.join(", ")}`,
    prompt: () =>
      select<NetworkChoice>({
        message: "Worker network access?",
        choices: [
          {
            name: "Restricted (recommended) — common registries only (npm, GitHub, PyPI)",
            value: "restricted",
          },
          { name: "Open — workers can access any domain", value: "open" },
          {
            name: "Isolated — workers have no internet access",
            value: "isolated",
          },
        ],
        default: "restricted",
      }),
  })) as NetworkChoice;

  const providerSkills = getAllProviders();
  const providerChoices = [
    { name: "Skip — I'll add a provider later", value: "" },
    ...providerSkills.map((s) => ({
      name: `${s.providers![0]!.displayName}${s.providers![0]!.defaultModel ? ` (${s.providers![0]!.defaultModel})` : ""}`,
      value: s.id,
    })),
  ];
  const validProviderIds = new Set([
    ...providerChoices.map((c) => c.value),
    ...Object.keys(PROVIDER_ALIASES),
  ]);

  const providerIdRaw = await promptOrDefault({
    flag: options.provider,
    useDefaults,
    defaultValue: "",
    validate: (v: string) =>
      v === "" || validProviderIds.has(v)
        ? true
        : `Unknown provider "${v}". Run \`lobu init --list-providers\` to see the full list (also at config/providers.json).`,
    prompt: () =>
      select<string>({
        message: "AI provider?",
        choices: providerChoices,
        default: "",
      }),
  });
  // Resolve aliases (e.g. `--provider anthropic` → "claude") before any
  // downstream use so the synthesized lobu.toml references the real id.
  const providerId = providerIdRaw ? resolveProviderAlias(providerIdRaw) : "";

  let providerApiKey = "";
  let selectedProvider: RegistryProvider | undefined;
  if (providerId) {
    selectedProvider = getProviderByIdWithSynth(providerId);
    const p = selectedProvider?.providers?.[0];
    if (p) {
      if (options.providerKey) {
        providerApiKey = options.providerKey;
      } else if (process.env[p.envVarName]) {
        // Inherit from env so `--yes` can pick up keys set in the shell.
        providerApiKey = process.env[p.envVarName] ?? "";
      } else if (!useDefaults) {
        providerApiKey = await password({
          message: `${p.displayName} API key:`,
          mask: true,
        });
      }
    }
  }

  const platformChoices = [
    { name: "Skip — I'll connect a platform later", value: "" },
    { name: "Telegram", value: "telegram" },
    { name: "Slack", value: "slack" },
    { name: "Discord", value: "discord" },
    { name: "WhatsApp", value: "whatsapp" },
    { name: "Microsoft Teams", value: "teams" },
    { name: "Google Chat", value: "gchat" },
  ];

  const platformType = await promptOrDefault({
    flag: options.platform,
    useDefaults,
    defaultValue: "",
    validate: (v: string) =>
      v === "" || (PLATFORM_CHOICES as readonly string[]).includes(v)
        ? true
        : `Unknown platform "${v}". Available: ${PLATFORM_CHOICES.join(", ")}`,
    prompt: () =>
      select<string>({
        message: "Connect a chat platform?",
        choices: platformChoices,
        default: "",
      }),
  });

  // Interactive: prompt for real secrets. --yes: write placeholder env-var
  // refs into lobu.toml; the user fills .env afterwards.
  let platformConfig: Record<string, string> = {};
  let platformSecrets: Array<{ envVar: string; value: string }> = [];
  if (platformType) {
    if (useDefaults) {
      platformConfig = PLATFORM_PLACEHOLDERS[platformType as PlatformChoice];
    } else {
      ({ platformConfig, platformSecrets } =
        await promptPlatformConfig(platformType));
    }
  }

  const enableSlackPreview = await promptBooleanOrDefault({
    flag: options.slackPreview,
    useDefaults,
    defaultValue: false,
    prompt: () =>
      confirm({
        message:
          "Enable Slack Preview with the public Lobu Developer Slack bot?",
        default: false,
      }),
  });

  const memoryChoice = (await promptOrDefault({
    flag: options.memory,
    useDefaults,
    defaultValue: "none",
    validate: (v: string) =>
      (MEMORY_CHOICES as readonly string[]).includes(v)
        ? true
        : `Must be one of: ${MEMORY_CHOICES.join(", ")}`,
    prompt: () =>
      select<MemoryChoice>({
        message: "Memory:",
        choices: [
          { name: "None (filesystem memory)", value: "none" },
          { name: "Lobu Cloud (app.lobu.ai)", value: "lobu-cloud" },
          { name: "Custom Lobu memory URL", value: "lobu-custom" },
        ],
        default: "none",
      }),
  })) as MemoryChoice;

  const envSecrets: Array<{ envVar: string; value: string }> = [];
  const includeLobuMemory = memoryChoice !== "none";
  let lobuUrl = "";

  if (memoryChoice === "lobu-cloud") {
    lobuUrl = DEFAULT_LOBU_MCP_URL;
  } else if (memoryChoice === "lobu-custom") {
    lobuUrl =
      options.memoryUrl ??
      (await input({
        message: "Lobu memory MCP URL:",
        validate: (v: string) => (v ? true : "URL is required"),
      }));
    envSecrets.push({ envVar: "MEMORY_URL", value: lobuUrl });
  }

  const otelEndpoint = await promptOrDefault({
    flag: options.otelEndpoint,
    useDefaults,
    defaultValue: "",
    prompt: () =>
      input({
        message:
          "OpenTelemetry collector endpoint? (leave empty to disable tracing)",
        default: "",
      }),
  });

  if (otelEndpoint) {
    envSecrets.push({
      envVar: "OTEL_EXPORTER_OTLP_ENDPOINT",
      value: otelEndpoint,
    });
  }

  let enableSentry = false;
  if (options.sentry === true) {
    enableSentry = true;
  } else if (options.noSentry === true) {
    enableSentry = false;
  } else if (!useDefaults) {
    enableSentry = await confirm({
      message:
        "Share anonymous error reports with Sentry to help improve Lobu?",
      default: false,
    });
  }

  if (enableSentry) {
    envSecrets.push({
      envVar: "SENTRY_DSN",
      value:
        "https://c5910e58d1a134d64ff93a95a9c535bb@o4507291398897664.ingest.us.sentry.io/4511097466781696",
    });
  }

  let allowedDomains: string;
  let disallowedDomains: string;
  if (networkPolicy === "open") {
    allowedDomains = "*";
    disallowedDomains = "";
  } else if (networkPolicy === "isolated") {
    allowedDomains = "";
    disallowedDomains = "";
  } else {
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
    encryptionKey,
    allowedDomains,
    disallowedDomains,
  };

  const spinner = ora("Creating Lobu project...").start();

  try {
    await mkdir(join(projectDir, "data"), { recursive: true });

    if (includeLobuMemory) {
      await mkdir(join(projectDir, "models"), { recursive: true });
      await mkdir(join(projectDir, "data", "entities"), { recursive: true });
      await mkdir(join(projectDir, "data", "relationships"), {
        recursive: true,
      });
      await writeFile(join(projectDir, "models", ".gitkeep"), "");
      await writeFile(join(projectDir, "data", "entities", ".gitkeep"), "");
      await writeFile(
        join(projectDir, "data", "relationships", ".gitkeep"),
        ""
      );
    }

    await generateLobuToml(projectDir, {
      agentName: projectName,
      allowedDomains: answers.allowedDomains,
      providerId: providerId || undefined,
      providerEnvVar: selectedProvider?.providers?.[0]?.envVarName,
      providerModel: selectedProvider?.providers?.[0]?.defaultModel,
      platformType: platformType || undefined,
      platformConfig:
        Object.keys(platformConfig).length > 0 ? platformConfig : undefined,
      includeLobuMemory,
      enableSlackPreview,
      lobuOrg: includeLobuMemory ? projectName : undefined,
      lobuName: includeLobuMemory ? humanizeSlug(projectName) : undefined,
    });

    const variables = {
      PROJECT_NAME: projectName,
      CLI_VERSION: cliVersion,
      ENCRYPTION_KEY: answers.encryptionKey,
      GATEWAY_PORT: gatewayPort,
      WORKER_PROXY_PORT: workerProxyPort,
      WORKER_ALLOWED_DOMAINS: answers.allowedDomains,
      WORKER_DISALLOWED_DOMAINS: answers.disallowedDomains,
    };

    await renderTemplate(".env.tmpl", variables, join(projectDir, ".env"));

    // Pin Node 22 for nvm / fnm / mise / asdf / volta — Lobu refuses to boot
    // on Node 25+ (isolated-vm has no prebuilt). Homebrew's `node` now
    // resolves to 26, so without these files a fresh `lobu run` fails.
    await writeFile(join(projectDir, ".nvmrc"), "22\n");
    await writeFile(join(projectDir, ".node-version"), "22\n");
    // `.env` carries ENCRYPTION_KEY + provider API keys / OAuth tokens
    // appended via setLocalEnvValue below. Tighten now so the initial
    // write isn't world-readable on multi-user hosts (default umask 022).
    await chmod(join(projectDir, ".env"), 0o600).catch(() => undefined);

    const envVarsToFill = new Set<string>();
    if (selectedProvider?.providers?.[0]?.envVarName) {
      envVarsToFill.add(selectedProvider.providers[0].envVarName);
    }
    for (const value of Object.values(platformConfig)) {
      const envVar = extractEnvVarRef(value);
      if (envVar) envVarsToFill.add(envVar);
    }
    for (const envVar of envVarsToFill) {
      await setLocalEnvValue(projectDir, envVar, "");
    }

    if (publicGatewayUrl) {
      await setLocalEnvValue(
        projectDir,
        "PUBLIC_GATEWAY_URL",
        publicGatewayUrl
      );
    }

    if (providerApiKey && selectedProvider?.providers?.[0]?.envVarName) {
      await setLocalEnvValue(
        projectDir,
        selectedProvider.providers[0].envVarName,
        providerApiKey
      );
    }

    for (const secret of platformSecrets) {
      await setLocalEnvValue(projectDir, secret.envVar, secret.value);
    }

    for (const secret of envSecrets) {
      await setLocalEnvValue(projectDir, secret.envVar, secret.value);
    }

    await renderTemplate(".gitignore.tmpl", {}, join(projectDir, ".gitignore"));
    await renderTemplate(
      "README.md.tmpl",
      variables,
      join(projectDir, "README.md")
    );

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

    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", ".gitkeep"), "");

    await mkdir(join(agentDir, "evals"), { recursive: true });
    await writeFile(join(agentDir, "evals", "ping.yaml"), DEFAULT_EVAL_YAML);

    await mkdir(join(projectDir, "skills"), { recursive: true });
    await writeFile(join(projectDir, "skills", ".gitkeep"), "");

    await renderTemplate(
      "AGENTS.md.tmpl",
      variables,
      join(projectDir, "AGENTS.md")
    );
    await renderTemplate(
      "TESTING.md.tmpl",
      variables,
      join(projectDir, "TESTING.md")
    );

    spinner.succeed("Project created successfully!");

    const gatewayUrl = `http://localhost:${gatewayPort}`;
    console.log(chalk.green("\n✓ Lobu initialized!\n"));
    console.log(chalk.bold("Next steps:\n"));
    let n = 1;
    if (!here) {
      console.log(chalk.cyan(`  ${n++}. cd ${projectName}`));
    }
    console.log(
      chalk.cyan(
        `  ${n++}. Start the local stack: lobu run (uses PGlite by default)`
      )
    );
    console.log(
      chalk.dim(
        "       Optional: set DATABASE_URL in .env to use external Postgres instead."
      )
    );
    if (lobuUrl) {
      console.log(
        chalk.cyan(`  ${n++}. Wire memory clients: lobu memory init`)
      );
    }
    if (enableSlackPreview) {
      console.log(
        chalk.cyan(
          `  ${n++}. Link the project to Lobu Cloud and register it: lobu login && lobu org set <slug> && lobu apply`
        )
      );
      console.log(
        chalk.dim(
          "       Then `lobu run` will print a short-lived Slack Preview link code."
        )
      );
    }
    console.log(chalk.cyan(`  ${n++}. API docs: ${gatewayUrl}/api/docs`));
    console.log(
      chalk.dim(
        "\n  See README.md for layout, AGENTS.md for the agent contract.\n"
      )
    );
  } catch (error) {
    spinner.fail("Failed to create project");
    throw error;
  }
}

const DEFAULT_EVAL_YAML = `version: 1
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
`;

function validateProjectName(value: string): string | true {
  if (!PROJECT_NAME_PATTERN.test(value)) {
    return "Project name must be lowercase alphanumeric with hyphens only";
  }
  return true;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface PromptOrDefaultOptions<T> {
  flag: string | undefined;
  useDefaults: boolean;
  defaultValue: T;
  prompt: () => Promise<T>;
  validate?: (value: string) => true | string;
}

async function promptOrDefault<T extends string>(
  opts: PromptOrDefaultOptions<T>
): Promise<T> {
  if (opts.flag !== undefined) {
    if (opts.validate) {
      const result = opts.validate(opts.flag);
      if (result !== true) {
        throw new Error(result);
      }
    }
    return opts.flag as T;
  }
  if (opts.useDefaults) return opts.defaultValue;
  return opts.prompt();
}

async function promptBooleanOrDefault(opts: {
  flag: boolean | undefined;
  useDefaults: boolean;
  defaultValue: boolean;
  prompt: () => Promise<boolean>;
}): Promise<boolean> {
  if (opts.flag !== undefined) return opts.flag;
  if (opts.useDefaults) return opts.defaultValue;
  return opts.prompt();
}

// Placeholder env-var refs for `--yes` mode; the user fills the values into .env.
const PLATFORM_PLACEHOLDERS: Record<PlatformChoice, Record<string, string>> = {
  telegram: { botToken: "$TELEGRAM_BOT_TOKEN" },
  slack: {
    botToken: "$SLACK_BOT_TOKEN",
    signingSecret: "$SLACK_SIGNING_SECRET",
  },
  discord: {
    botToken: "$DISCORD_BOT_TOKEN",
    applicationId: "$DISCORD_APPLICATION_ID",
    publicKey: "$DISCORD_PUBLIC_KEY",
  },
  whatsapp: {
    accessToken: "$WHATSAPP_ACCESS_TOKEN",
    phoneNumberId: "$WHATSAPP_PHONE_NUMBER_ID",
    verifyToken: "$WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    appSecret: "$WHATSAPP_APP_SECRET",
  },
  teams: {
    appId: "$TEAMS_APP_ID",
    appPassword: "$TEAMS_APP_PASSWORD",
    appType: "MultiTenant",
  },
  gchat: { credentials: "$GOOGLE_CHAT_CREDENTIALS" },
};

function extractEnvVarRef(value: string): string | null {
  const match = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  return match?.[1] ?? null;
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generateLobuToml(
  projectDir: string,
  options: {
    agentName: string;
    allowedDomains: string;
    providerId?: string;
    providerEnvVar?: string;
    providerModel?: string;
    platformType?: string;
    platformConfig?: Record<string, string>;
    includeLobuMemory?: boolean;
    lobuOrg?: string;
    lobuName?: string;
    lobuDescription?: string;
    enableSlackPreview?: boolean;
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
      '# id = "openrouter"',
      '# key = "$OPENROUTER_API_KEY"'
    );
  }

  lines.push("");

  if (options.platformType && options.platformConfig) {
    lines.push(
      `[[agents.${id}.platforms]]`,
      `type = "${options.platformType}"`
    );
    lines.push(`[agents.${id}.platforms.config]`);
    for (const [key, value] of Object.entries(options.platformConfig)) {
      lines.push(`${key} = "${value}"`);
    }
  } else {
    lines.push(
      "# Chat platform (add via the gateway configuration APIs or uncomment below):",
      `# [[agents.${id}.platforms]]`,
      '# type = "telegram"',
      `# [agents.${id}.platforms.config]`,
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

  if (options.enableSlackPreview) {
    lines.push(
      "",
      "# Hosted preview — `lobu run` prints a `/lobu link <code>` you redeem by",
      "# DMing the hosted Lobu Slack bot. The block key is the chat platform;",
      "# `[agents.<id>.preview.telegram]` works the same way (redeem with `/link <code>`).",
      `[agents.${id}.preview.slack]`,
      "enabled = true",
      'surfaces = ["dm"]',
      "code_ttl_minutes = 15"
    );
  }

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

  if (options.includeLobuMemory) {
    const org = options.lobuOrg ?? options.agentName;
    const name = options.lobuName ?? humanizeSlug(options.agentName);
    lines.push(
      "",
      "# Project-scoped Lobu memory",
      `[memory]`,
      "enabled = true",
      `org = ${JSON.stringify(org)}`,
      `name = ${JSON.stringify(name)}`,
      ...(options.lobuDescription
        ? [`description = ${JSON.stringify(options.lobuDescription)}`]
        : []),
      'models = "./models"',
      'data = "./data"'
    );
  }

  lines.push("");
  await writeFile(join(projectDir, "lobu.toml"), lines.join("\n"));
}

async function getCliVersion(): Promise<string> {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkgContent = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent);
  return pkg.version || "0.1.0";
}
