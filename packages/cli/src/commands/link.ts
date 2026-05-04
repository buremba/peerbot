import chalk from "chalk";
import {
  getActiveOrg,
  getCurrentContextName,
  resolveContext,
} from "../internal/index.js";
import { loadProjectLink, saveProjectLink } from "../internal/project-link.js";

interface LinkOptions {
  context?: string;
  org?: string;
  cwd?: string;
}

/**
 * `lobu link` — bind the current project directory to a (context, org)
 * pair so that `lobu apply` and `lobu chat` refuse to run against the
 * wrong cloud target. Mirrors `vercel link` / `convex dev`'s `.convex/`.
 */
export async function linkCommand(options: LinkOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const target = await resolveContext(options.context);
  const org = options.org?.trim() || (await getActiveOrg(target.name)) || "";
  if (!org) {
    console.error(
      chalk.red(
        "\n  No org selected. Run `lobu org set <slug>` or pass `--org <slug>`.\n"
      )
    );
    process.exit(1);
  }

  const link = await saveProjectLink(cwd, { context: target.name, org });
  console.log(chalk.green("\n  Project linked."));
  console.log(chalk.dim(`  Context: ${link.context}`));
  console.log(chalk.dim(`  Org:     ${link.org}`));
  console.log(chalk.dim(`  Path:    ${cwd}/.lobu/project.json\n`));
}

export async function unlinkCommand(
  options: { cwd?: string } = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const existing = await loadProjectLink(cwd);
  if (!existing) {
    console.log(chalk.dim("\n  No project link found.\n"));
    return;
  }
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await rm(join(cwd, ".lobu", "project.json"), { force: true });
  console.log(chalk.green("\n  Project unlinked.\n"));
}

export async function linkStatusCommand(
  options: { cwd?: string } = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const link = await loadProjectLink(cwd);
  if (!link) {
    const ctx = await getCurrentContextName();
    console.log(chalk.dim("\n  Project not linked."));
    console.log(
      chalk.dim(
        `  Run \`lobu link\` to bind this directory to context "${ctx}".\n`
      )
    );
    return;
  }
  console.log(chalk.bold("\n  Lobu project link"));
  console.log(chalk.dim(`  Context: ${link.context}`));
  console.log(chalk.dim(`  Org:     ${link.org}`));
  console.log(chalk.dim(`  Linked:  ${link.linkedAt}\n`));
}
