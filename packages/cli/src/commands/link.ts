import chalk from "chalk";
import { getActiveOrg, resolveContext } from "../internal/index.js";
import {
  loadProjectLink,
  removeProjectLink,
  saveProjectLink,
} from "../internal/project-link.js";

interface LinkOptions {
  context?: string;
  org?: string;
  cwd?: string;
}

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
  await removeProjectLink(cwd);
  console.log(chalk.green("\n  Project unlinked.\n"));
}
