#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PACKAGES = [
  "packages/core",
  "packages/plugin-api",
  "packages/plugin-host",
  "packages/agent-worker",
  "packages/cli",
  "packages/connector-sdk",
  "packages/client",
  "packages/connector-worker",
  "packages/embeddings",
];

async function main() {
  const bump = process.argv[2]; // "patch", "minor", "major", or explicit like "3.1.0"
  const root = process.cwd();
  const rootPkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  );
  let version = rootPkg.version;

  if (bump) {
    const [major, minor, patch] = version.split(".").map(Number);
    if (bump === "patch") version = `${major}.${minor}.${patch + 1}`;
    else if (bump === "minor") version = `${major}.${minor + 1}.0`;
    else if (bump === "major") version = `${major + 1}.0.0`;
    else {
      // Explicit version — validate before writing. Anything unrecognized used
      // to be accepted verbatim, so a stray flag (`--help`) or typo silently
      // rewrote every package.json to a nonsense version across the workspace.
      if (
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(bump)
      ) {
        throw new Error(
          `Invalid version "${bump}". Expected patch | minor | major, or an explicit semver like 3.1.0 / 3.1.0-beta.1.`
        );
      }
      version = bump;
    }
  }

  // Update root
  rootPkg.version = version;
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(rootPkg, null, 2)}\n`
  );
  console.log(`root: ${version}`);

  // Update all workspace packages
  for (const pkg of PACKAGES) {
    const pkgPath = path.join(root, pkg, "package.json");
    const pkgJson = JSON.parse(await readFile(pkgPath, "utf8"));
    pkgJson.version = version;
    await writeFile(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    console.log(`${pkg}: ${version}`);
  }

  console.log(`\nAll packages bumped to ${version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
