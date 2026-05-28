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

// Vendor the precomputed catalog manifest the server build emits next to its
// own bundled connectors (.catalog-manifest.json). With it, `lobu run` serves
// the connector picker without compiling every connector on demand. CI builds
// the server first, so it's present; if absent (local CLI build without
// build:server) the runtime falls back to on-demand compilation — no regression.
const catalogManifestSrc = "../server/dist/connectors/.catalog-manifest.json";
if (fs.existsSync(catalogManifestSrc) && fs.existsSync("dist/connectors")) {
  fs.cpSync(catalogManifestSrc, "dist/connectors/.catalog-manifest.json");
}

// Copy database migrations for the bundled embedded-Postgres local server.
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

// Vendor @lobu/pgvector-embedded into the CLI tarball. It's `private` (never
// published) but the bundled server needs it at runtime for embedded Postgres
// + pgvector. esbuild can't inline its prebuilt native binaries, so we ship
// the package's dist + prebuilt under dist/vendor/ (NOT node_modules, which
// npm strips from tarballs). embedded-runtime.ts loads this copy by path when
// the bare specifier isn't resolvable (i.e. in the published CLI). The `bun`
// export condition is stripped so a bun runtime resolves dist/index.js rather
// than the src/ that doesn't ship.
const pgvSrc = "../pgvector-embedded";
const pgvDest = "dist/vendor/pgvector-embedded";
function vendorPgvector() {
  if (
    !fs.existsSync(`${pgvSrc}/dist`) ||
    !fs.existsSync(`${pgvSrc}/prebuilt`)
  ) {
    return false;
  }
  copyDirIfExists(`${pgvSrc}/dist`, `${pgvDest}/dist`);
  copyDirIfExists(`${pgvSrc}/prebuilt`, `${pgvDest}/prebuilt`);
  const pgvPkg = JSON.parse(fs.readFileSync(`${pgvSrc}/package.json`, "utf8"));
  if (pgvPkg.exports?.["."]?.bun) {
    delete pgvPkg.exports["."].bun;
  }
  fs.mkdirSync(pgvDest, { recursive: true });
  fs.writeFileSync(
    `${pgvDest}/package.json`,
    `${JSON.stringify(pgvPkg, null, 2)}\n`
  );
  return true;
}
if (!vendorPgvector()) {
  // Fail HARD (don't warn-and-skip): the package is `private` (never
  // published), so a CLI shipped without the vendored copy silently breaks
  // `lobu run` embedded Postgres — exactly the 9.1.0 regression this guards.
  // pgvector-embedded is built by `bun run build:packages` (and
  // `make build-packages`) before the CLI; build it first if you hit this.
  throw new Error(
    `[cli build] could not vendor @lobu/pgvector-embedded: dist/prebuilt missing at ${pgvSrc}. ` +
      "Run `bun run build:packages` (it builds pgvector-embedded before the CLI). " +
      "The published CLI needs it for `lobu run` embedded Postgres and it is not on npm."
  );
}
