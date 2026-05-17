import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";

interface AgentCommandOptions {
  context?: string;
  org?: string;
  json?: boolean;
}

interface AgentItem {
  agentId: string;
  name: string;
  description?: string;
  connectionCount?: number;
  activeConnectionCount?: number;
  clientCount?: number;
  status?: string;
}

export async function agentListCommand(
  options: AgentCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const data = await client.get<{ agents?: AgentItem[] }>(
    `/api/${orgSlug}/agents`
  );
  const agents = data.agents ?? [];

  if (options.json) {
    printJson(agents);
    return;
  }

  if (agents.length === 0) {
    console.log(chalk.dim(`\n  No agents in org ${orgSlug}.\n`));
    return;
  }

  console.log(chalk.bold(`\n  Agents in ${orgSlug}`));
  for (const agent of agents) {
    const status = agent.status ? chalk.dim(`  ${agent.status}`) : "";
    const description = agent.description
      ? chalk.dim(` — ${agent.description}`)
      : "";
    const counts = chalk.dim(
      `connections:${agent.connectionCount ?? 0} active:${agent.activeConnectionCount ?? 0} clients:${agent.clientCount ?? 0}`
    );
    console.log(
      `  ${chalk.green("●")} ${chalk.bold(agent.agentId)} ${counts}${status}${description}`
    );
  }
  console.log();
}

export async function agentGetCommand(
  agentId: string,
  options: AgentCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const agent = await client.get<unknown>(
    `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`
  );
  printJson(agent);
}

export async function agentCreateCommand(
  agentId: string,
  options: AgentCommandOptions & { name?: string; description?: string } = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const name = options.name?.trim() || agentId;
  const agent = await client.post<unknown>(`/api/${orgSlug}/agents`, {
    agentId,
    name,
    ...(options.description ? { description: options.description } : {}),
  });

  if (options.json) {
    printJson(agent);
    return;
  }
  console.log(chalk.green(`\n  Created agent ${agentId} in ${orgSlug}.\n`));
}

export async function agentUpdateCommand(
  agentId: string,
  options: AgentCommandOptions & { name?: string; description?: string } = {}
): Promise<void> {
  const updates: { name?: string; description?: string } = {};
  if (options.name !== undefined) updates.name = options.name;
  if (options.description !== undefined)
    updates.description = options.description;
  if (Object.keys(updates).length === 0) {
    console.error(
      chalk.red("\n  Pass at least one of --name or --description.\n")
    );
    process.exit(1);
  }

  const { client, orgSlug } = await resolveApiClient(options);
  const result = await client.patch<unknown>(
    `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`,
    updates
  );

  if (options.json) {
    printJson(result);
    return;
  }
  console.log(chalk.green(`\n  Updated agent ${agentId}.\n`));
}

export async function agentDeleteCommand(
  agentId: string,
  options: AgentCommandOptions & { yes?: boolean } = {}
): Promise<void> {
  if (!options.yes) {
    console.error(chalk.red("\n  Refusing to delete without --yes.\n"));
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  await client.delete(`/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`);
  console.log(chalk.green(`\n  Deleted agent ${agentId}.\n`));
}

export async function agentConfigGetCommand(
  agentId: string,
  options: AgentCommandOptions & { output?: string } = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const config = await client.get<unknown>(
    `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}/config`
  );

  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, json);
    console.log(chalk.green(`\n  Wrote ${options.output}\n`));
    return;
  }
  process.stdout.write(json);
}

export async function agentConfigPatchCommand(
  agentId: string,
  options: AgentCommandOptions & { file: string; json?: boolean }
): Promise<void> {
  if (!options.file) throw new Error("--file is required.");
  const raw = await readFile(options.file, "utf-8");
  let updates: unknown;
  try {
    updates = JSON.parse(raw) as unknown;
  } catch (error) {
    console.error(
      chalk.red(
        `\n  Failed to parse ${options.file}: ${error instanceof Error ? error.message : String(error)}\n`
      )
    );
    process.exit(1);
  }
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    console.error(
      chalk.red("\n  Config patch file must contain a JSON object.\n")
    );
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  const result = await client.patch<unknown>(
    `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}/config`,
    updates
  );

  if (options.json) {
    printJson(result);
    return;
  }
  console.log(chalk.green(`\n  Updated config for ${agentId}.\n`));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AgentScaffoldOptions {
  cwd?: string;
  name?: string;
  description?: string;
}

const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Add a new local agent + a `[agents.<id>]` block to an existing lobu.toml. */
export async function agentScaffoldCommand(
  agentId: string,
  options: AgentScaffoldOptions = {}
): Promise<void> {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    console.error(
      chalk.red(
        `\n  Invalid agent id "${agentId}". Use lowercase alphanumeric + hyphens.\n`
      )
    );
    process.exit(1);
  }

  const cwd = options.cwd ?? process.cwd();
  const lobuTomlPath = join(cwd, "lobu.toml");
  if (!(await pathExists(lobuTomlPath))) {
    console.error(
      chalk.red(
        "\n  No lobu.toml in the current directory. Run `lobu init` first or `cd` into a Lobu project.\n"
      )
    );
    process.exit(1);
  }

  const agentDir = join(cwd, "agents", agentId);
  if (await pathExists(agentDir)) {
    console.error(
      chalk.red(
        `\n  Directory ${agentDir} already exists. Pick a different agent id.\n`
      )
    );
    process.exit(1);
  }

  const displayName = options.name ?? agentId;
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "IDENTITY.md"),
    `# Identity\n\nYou are ${displayName}, a helpful AI assistant.\n`
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

  const description = options.description ?? "";
  const tomlBlock = [
    "",
    `[agents.${agentId}]`,
    `name = ${JSON.stringify(displayName)}`,
    `description = ${JSON.stringify(description)}`,
    `dir = "./agents/${agentId}"`,
    "",
    `[agents.${agentId}.skills]`,
    "",
    `[agents.${agentId}.network]`,
    "allowed = []",
    "",
  ].join("\n");

  const existing = await readFile(lobuTomlPath, "utf-8");
  const sep = existing.endsWith("\n") ? "" : "\n";
  await writeFile(lobuTomlPath, `${existing}${sep}${tomlBlock}`);

  console.log(chalk.green(`\n  Scaffolded agent "${agentId}".`));
  console.log(chalk.dim(`  - agents/${agentId}/IDENTITY.md`));
  console.log(chalk.dim(`  - agents/${agentId}/SOUL.md`));
  console.log(chalk.dim(`  - agents/${agentId}/USER.md`));
  console.log(chalk.dim(`  - agents/${agentId}/skills/`));
  console.log(chalk.dim(`  - agents/${agentId}/evals/`));
  console.log(chalk.dim(`  - lobu.toml: appended [agents.${agentId}]\n`));
}
