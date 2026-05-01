#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PACKAGES = [
  "packages/core",
  "packages/agent-worker",
  "packages/cli",
  "packages/connector-sdk",
  "packages/openclaw-plugin",
  "packages/connectors",
  "packages/connector-worker",
  "packages/embeddings",
  "packages/owletto-sdk",
  "packages/owletto-connectors",
  "packages/owletto-worker",
  "packages/owletto-embeddings",
  "packages/owletto-openclaw",
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
    else version = bump; // explicit version
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
