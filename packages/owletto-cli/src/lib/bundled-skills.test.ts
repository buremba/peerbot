import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBundledSkill, listBundledSkills } from './bundled-skills.ts';

describe('bundled Owletto starter skills', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lists the public Owletto starter skills', () => {
    const skills = listBundledSkills();
    expect(skills.map((skill) => skill.id)).toEqual(['owletto', 'owletto-openclaw']);
  });

  test('installs the Owletto starter skill into skills/<id>', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'owletto-skill-install-'));
    tempDirs.push(cwd);

    const { destinationDir } = installBundledSkill('owletto', cwd);

    expect(destinationDir).toBe(join(cwd, 'skills', 'owletto'));
    expect(existsSync(join(destinationDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(destinationDir, 'references', 'client-install.md'))).toBe(true);

    const content = readFileSync(join(destinationDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('# Owletto');
  });
});
