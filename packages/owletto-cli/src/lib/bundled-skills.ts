import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const PUBLIC_SKILL_IDS = ['owletto', 'owletto-openclaw'] as const;

type PublicSkillId = (typeof PUBLIC_SKILL_IDS)[number];

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

export interface BundledSkill {
  id: PublicSkillId;
  name: string;
  description: string;
  sourceDir: string;
  files: string[];
}

function findSkillDir(id: PublicSkillId): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packaged = join(dir, 'bundled-skills', id, 'SKILL.md');
    if (existsSync(packaged)) return join(dir, 'bundled-skills', id);

    const repoSkill = join(dir, 'skills', id, 'SKILL.md');
    if (existsSync(repoSkill)) return join(dir, 'skills', id);

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseFrontmatter(skillDir: string): SkillFrontmatter {
  const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match?.[1]) return {};
  return (YAML.parse(match[1]) as SkillFrontmatter | null) ?? {};
}

function listFilesRecursive(root: string, dir = root): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(root, fullPath));
      continue;
    }
    files.push(relative(root, fullPath));
  }

  return files.sort();
}

export function listBundledSkills(): BundledSkill[] {
  return PUBLIC_SKILL_IDS.map((id) => {
    const sourceDir = findSkillDir(id);
    if (!sourceDir) {
      throw new Error(`Bundled skill \"${id}\" is not available in this build.`);
    }

    const frontmatter = parseFrontmatter(sourceDir);
    return {
      id,
      name: frontmatter.name?.trim() || id,
      description: frontmatter.description?.trim() || '',
      sourceDir,
      files: listFilesRecursive(sourceDir),
    } satisfies BundledSkill;
  });
}

export function getBundledSkill(id: string): BundledSkill | undefined {
  return listBundledSkills().find((skill) => skill.id === id);
}

export interface InstallBundledSkillResult {
  skill: BundledSkill;
  destinationDir: string;
}

export function installBundledSkill(
  id: string,
  targetRoot: string,
  options?: { force?: boolean }
): InstallBundledSkillResult {
  const skill = getBundledSkill(id);
  if (!skill) {
    throw new Error(`Bundled skill \"${id}\" not found.`);
  }

  const destinationDir = resolve(targetRoot, 'skills', skill.id);
  if (existsSync(destinationDir)) {
    if (!options?.force) {
      throw new Error(
        `Target already exists: ${destinationDir}. Re-run with --force to overwrite it.`
      );
    }
    rmSync(destinationDir, { recursive: true, force: true });
  }

  mkdirSync(dirname(destinationDir), { recursive: true });
  cpSync(skill.sourceDir, destinationDir, { recursive: true, force: true });

  return { skill, destinationDir };
}
