import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installBundledSkill,
  listBundledSkills,
} from "../commands/skills/registry.js";

describe("bundled starter skills", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lists the public Lobu starter skill", () => {
    const skills = listBundledSkills();
    expect(skills.map((skill) => skill.id)).toContain("lobu");

    const lobu = skills.find((skill) => skill.id === "lobu");
    expect(lobu?.files).toContain("SKILL.md");
    expect(lobu?.description.length).toBeGreaterThan(0);
  });

  test("installs the Lobu starter skill into skills/<id>", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lobu-skill-install-"));
    tempDirs.push(cwd);

    const { destinationDir } = installBundledSkill("lobu", cwd);

    expect(destinationDir).toBe(join(cwd, "skills", "lobu"));
    expect(existsSync(join(destinationDir, "SKILL.md"))).toBe(true);

    const content = readFileSync(join(destinationDir, "SKILL.md"), "utf-8");
    expect(content).toContain("# Lobu");
    expect(content).toContain("Owletto");
  });
});
