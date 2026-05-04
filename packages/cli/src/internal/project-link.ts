import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROJECT_LINK_DIR = ".lobu";
export const PROJECT_LINK_FILE = "project.json";

export interface ProjectLink {
  /** Named context the project is bound to (matches `lobu context list`). */
  context: string;
  /** Active org slug at link time. */
  org: string;
  /** ISO timestamp the link was written. */
  linkedAt: string;
}

export async function loadProjectLink(
  cwd: string
): Promise<ProjectLink | null> {
  try {
    const raw = await readFile(
      join(cwd, PROJECT_LINK_DIR, PROJECT_LINK_FILE),
      "utf-8"
    );
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
  const dir = join(cwd, PROJECT_LINK_DIR);
  await mkdir(dir, { recursive: true });
  const full: ProjectLink = {
    ...link,
    linkedAt: new Date().toISOString(),
  };
  await writeFile(
    join(dir, PROJECT_LINK_FILE),
    `${JSON.stringify(full, null, 2)}\n`
  );

  // Add .lobu/ to .gitignore so the link file (and any future per-project
  // CLI state) stays out of version control by default.
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const existing = await readFile(gitignorePath, "utf-8");
    if (!/^\.lobu\/?$/m.test(existing)) {
      const sep = existing.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, `${existing}${sep}.lobu/\n`);
    }
  } catch {
    // No .gitignore — don't create one here; init writes it during scaffolding.
  }

  return full;
}
