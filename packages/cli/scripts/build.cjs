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

// Copy bundled connector source files next to the embedded server bundle.
// The server lists these runtime code-based connectors for picker UIs and
// compiles them on demand when a workspace installs or runs one.
copyDirIfExists("../connectors/src", "dist/connectors");

// Copy database migrations for the bundled PGlite local server.
copyDirIfExists("../../db/migrations", "dist/db/migrations");

// Copy the built owletto web UI (admin/console SPA) next to the server bundle
// so `lobu run` serves it — OAuth, MCP-client setup, and connection CRUD have
// no surface without it. owletto is a private submodule (`private: true`);
// only its compiled `dist/` ships in the CLI tarball, never the source. CI's
// publish flow builds it (`bun run build` in packages/owletto, gated on the
// submodule being present) before this script runs. Missing locally (fork or
// uninitialised submodule) → the copy is skipped and `lobu run` boots headless
// (API only), matching prior behaviour. `dev.ts` points WEB_DIST_DIR here.
copyDirIfExists("../owletto/dist", "dist/owletto/dist");

// Copy server bundles so `lobu run` is self-contained.
// @lobu/server is private (`private: true` in its package.json),
// so `npx @lobu/cli` users can never resolve it via npm — they only get
// what ships inside the CLI tarball. CI's publish flow builds the bundles
// (`build:server`) before this script runs; if they're missing locally, run
// `bun run --filter '@lobu/server' build:server` first.
for (const bundleName of ["server.bundle.mjs"]) {
  const bundleSrc = `../server/dist/${bundleName}`;
  const bundleDest = `dist/${bundleName}`;
  if (fs.existsSync(bundleSrc)) {
    fs.cpSync(bundleSrc, bundleDest);
  } else {
    console.warn(
      `[cli build] server bundle missing at ${bundleSrc}; ` +
        "`lobu run` may fall back to monorepo-relative lookup. Run " +
        "`bun run --filter '@lobu/server' build:server` to bundle it."
    );
  }
}
