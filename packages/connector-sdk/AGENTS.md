# Connector SDK package agent rules

Read root `AGENTS.md` first. This package is the contract every connector compiles against: `ConnectorRuntime`, the source primitives (`file-source`, `acl-source`, `http-client`), identity normalization, pagination/retry/scoring helpers, and the browser automation layer. Built-in connector *implementations* live in `packages/connectors`; user-authored ones are compiled from project directories. Keep this package generic — it serves both.

## Boundaries
- This is a published contract consumed by external connectors. A breaking change to an exported type or runtime method breaks compiled connectors in the wild — additive changes only unless a migration is planned.
- `playwright` is a **peer** dependency aliased to patchright, and it is optional. Never make a top-level import of it a hard requirement of the package entrypoint; browser code must stay reachable only from the browser paths.
- Egress helpers enforce SSRF guards and domain allowlists (`url-guards.ts`). Route new outbound-fetch surfaces through them rather than calling `fetch` directly.

## Browser automation
- The stealth layer exists to look like a real browser; patchright (not vanilla playwright) is deliberate. Do not "fix" the alias in `package.json` — install revision and runtime revision must match, or Chromium fails to launch.
- `launcher.ts` distinguishes two failure modes: a `PLAYWRIGHT_BROWSERS_PATH` mismatch versus an unresolvable package. When a launch fails, read which error you got before debugging — see `docs/GOTCHAS.md`, "Browser & connectors", for the Docker/install invariants behind it.
- CDP (`cdp.ts`, `cdp-page.ts`) and the extension scrape paths (`extension-dom-scrape.ts`, `extension-network.ts`) are different backends with different auth stories. Extension paths reach the user's real logged-in sessions; local Playwright/CDP does not.

## Package-specific traps
- This package is **biome-excluded** (`config/biome.config.json`). Never run biome on it — edit surgically, matching each file's existing style. See `docs/GOTCHAS.md`, "Formatting & lint".
- Adding this package to another package's imports means adding it to all three build lists — see `docs/GOTCHAS.md`, "Build & typecheck".

## Validation
- Validation: the root gates (`make pre-pr` + `make review`, see root `AGENTS.md`) plus targeted SDK tests. Browser changes need a real connector run, not just a unit test — a green mock proves nothing about Chromium launch.
