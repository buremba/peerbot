/**
 * Shared helpers for the `lobu {providers,skills,connections} add` commands.
 * All three follow the same pattern: read lobu.toml, locate the first agent,
 * apply a mutation, write the updated file, and optionally set secrets.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { parse as parseToml } from "smol-toml";
import { secretsSetCommand } from "../commands/secrets.js";
import { CONFIG_FILENAME } from "./loader.js";

interface AgentContext {
  /** Absolute path to lobu.toml */
  configPath: string;
  /** Raw TOML text */
  raw: string;
  /** Parsed TOML object */
  parsed: Record<string, unknown>;
  /** ID of the first agent (Lobu assumes one agent per project today) */
  agentId: string;
  /** The first agent's config object */
  agent: Record<string, unknown>;
  /** All agents keyed by ID */
  agents: Record<string, Record<string, unknown>>;
}

/**
 * Load lobu.toml and return the first agent's context.
 * Prints a red error message and returns null if the file or agent is missing.
 */
export async function loadAgentContext(
  cwd: string
): Promise<AgentContext | null> {
  const configPath = join(cwd, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    console.log(
      chalk.red(`\n  No ${CONFIG_FILENAME} found. Run \`lobu init\` first.\n`)
    );
    return null;
  }

  const parsed = parseToml(raw) as Record<string, unknown>;
  const agents = parsed.agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!agents || Object.keys(agents).length === 0) {
    console.log(chalk.red(`\n  No agents found in ${CONFIG_FILENAME}.\n`));
    return null;
  }

  const agentId = Object.keys(agents)[0]!;
  return {
    configPath,
    raw,
    parsed,
    agentId,
    agent: agents[agentId]!,
    agents,
  };
}

/**
 * Append a block of TOML lines to the end of lobu.toml.
 * Preserves existing comments/formatting by editing the raw text.
 */
export async function appendTomlBlock(
  ctx: AgentContext,
  lines: string[]
): Promise<void> {
  const block = lines.join("\n");
  await writeFile(ctx.configPath, `${ctx.raw.trimEnd()}\n${block}\n`);
}

/**
 * Write multiple secrets to .env via the secrets command.
 */
export async function setSecrets(
  cwd: string,
  secrets: Array<{ envVar: string; value: string }>
): Promise<void> {
  for (const secret of secrets) {
    await secretsSetCommand(cwd, secret.envVar, secret.value);
  }
}
