import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LINK_DIR = ".lobu";
const LINK_FILE = "project.json";

interface ProjectLink {
  context: string;
  org: string;
  /** ISO timestamp the link was written. */
  linkedAt: string;
}

function linkPath(cwd: string): string {
  return join(cwd, LINK_DIR, LINK_FILE);
}

export async function loadProjectLink(
  cwd: string
): Promise<ProjectLink | null> {
  try {
    const raw = await readFile(linkPath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProjectLink>;
    if (
      typeof parsed.context !== "string" ||
      typeof parsed.org !== "string" ||
      typeof parsed.linkedAt !== "string"
    ) {
      return null;
    }
    return {
      context: parsed.context,
      org: parsed.org,
      linkedAt: parsed.linkedAt,
    };
  } catch {
    return null;
  }
}

export async function saveProjectLink(
  cwd: string,
  link: Omit<ProjectLink, "linkedAt">
): Promise<ProjectLink> {
  await mkdir(join(cwd, LINK_DIR), { recursive: true });
  const full: ProjectLink = { ...link, linkedAt: new Date().toISOString() };
  await writeFile(linkPath(cwd), `${JSON.stringify(full, null, 2)}\n`);

  // Keep the link file out of version control by default.
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const existing = await readFile(gitignorePath, "utf-8");
    if (!/^\.lobu\/?$/m.test(existing)) {
      const sep = existing.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, `${existing}${sep}.lobu/\n`);
    }
  } catch {
    // No .gitignore — init writes one during scaffolding.
  }

  return full;
}

export async function removeProjectLink(cwd: string): Promise<void> {
  await rm(linkPath(cwd), { force: true });
}
