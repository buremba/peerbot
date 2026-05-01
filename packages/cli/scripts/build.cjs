const fs = require("node:fs");
const path = require("node:path");

function copyDirIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// Copy templates
copyDirIfExists("src/templates", "dist/templates");

// Copy the single bundled Lobu starter skill (includes memory guidance).
copyDirIfExists("../../skills/lobu", "dist/bundled-skills/lobu");

// Copy mcp-servers.json
const jsonSrc = "src/mcp-servers.json";
const jsonDest = "dist/mcp-servers.json";
if (fs.existsSync(jsonSrc)) {
  fs.cpSync(jsonSrc, jsonDest);
}

// Copy providers.json from monorepo config
const providersSrc = "../../config/providers.json";
const providersDest = "dist/providers.json";
if (fs.existsSync(providersSrc)) {
  fs.cpSync(providersSrc, providersDest);
}

// Copy the server server bundle so `lobu run` is self-contained.
// @lobu/server is private (`private: true` in its package.json),
// so `npx @lobu/cli` users can never resolve it via npm — they only get
// what ships inside the CLI tarball. CI's publish flow builds the bundle
// (`build:server`) before this script runs; if it's missing locally, run
// `bun run --filter '@lobu/server' build:server` first.
const bundleSrc = "../server/dist/server.bundle.mjs";
const bundleDest = "dist/server.bundle.mjs";
if (fs.existsSync(bundleSrc)) {
  fs.cpSync(bundleSrc, bundleDest);
} else {
  console.warn(
    `[cli build] server bundle missing at ${bundleSrc}; ` +
      "`lobu run` will fall back to monorepo-relative lookup. Run " +
      "`bun run --filter '@lobu/server' build:server` to bundle it."
  );
}
