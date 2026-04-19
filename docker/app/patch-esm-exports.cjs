/**
 * Patch ESM-only packages for CJS compatibility.
 *
 * The lobu gateway compiles to CJS (dynamic import() becomes require()),
 * but some dependencies only export ESM. Adding a "default" export
 * condition allows Node's CJS require() to resolve them.
 *
 * Run at build time AND at startup (for lazy-installed packages).
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

try {
  const files = execSync(
    "find node_modules -follow -name package.json -maxdepth 6 2>/dev/null",
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  let patched = 0;
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(f, "utf8"));
      const x = p.exports?.["."];
      if (x?.import && !x.default && !x.require) {
        x.default = x.import;
        fs.writeFileSync(f, JSON.stringify(p, null, 2));
        patched++;
      }
    } catch {
      // skip malformed package.json
    }
  }
  console.log(`ESM export patch: ${patched} packages patched`);
} catch (e) {
  console.log("ESM export patch: skipped (find failed)");
}
