import fs from "node:fs";

/**
 * Scan a directory tree and find all project directories
 * A project directory is one that contains a build config file
 * (Makefile, package.json, pyproject.toml, etc.)
 *
 * Generic utility that works for any AI agent
 */
export function listAppDirectories(rootDirectory: string): string[] {
  const foundDirectories: string[] = [];
  const ignored = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "vendor",
    "target",
    ".venv",
    "venv",
  ]);

  const buildConfigFiles = new Set([
    "Makefile",
    "makefile",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "CMakeLists.txt",
    "go.mod",
  ]);

  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if current directory has any build config files
    const hasConfigFile = entries.some(
      (entry) => entry.isFile() && buildConfigFiles.has(entry.name)
    );

    if (hasConfigFile) {
      foundDirectories.push(dir);
    }

    // Recursively walk subdirectories
    for (const entry of entries) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !ignored.has(entry.name)) {
        walk(p);
      }
    }
  };

  walk(rootDirectory);
  return foundDirectories;
}
