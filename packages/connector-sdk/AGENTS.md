# Connector SDK package agent rules

Read root `AGENTS.md` first. This package is the contract every connector compiles against: `ConnectorRuntime`, the source primitives (`file-source`, `acl-source`, `http-client`), identity normalization, pagination/retry/scoring helpers, and the browser automation layer. Built-in connector *implementations* live in `packages/connectors`; user-authored ones are compiled from project directories. Keep this package generic — it serves both.

## Boundaries
- This is a published contract consumed by external connectors. A breaking change to an exported type or runtime method breaks compiled connectors in the wild — additive changes only unless a migration is planned.
- `playwright` is a **peer** dependency aliased to patchright, and it is optional. Never make a top-level import of it a hard requirement of the package entrypoint; browser code must stay reachable only from the browser paths.
- The **package root must stay loadable inside a V8 isolate**: no `node:` import and no `@lobu/core` root import anywhere in its graph (core's index drags winston, Sentry and OpenTelemetry into every connector bundle; core *subpaths* such as `@lobu/core/contracts/...` are fine). Node-only code lives behind the `./browser`, `./sources` and `./device-manifest-hash` subpaths. `packages/server/src/__tests__/integration/sandbox/connector-isolate-lane.test.ts` bundles the root and every bundled connector with the isolate lane's compile config and fails on the first builtin.
- `url-guards.ts` provides SSRF and domain checks; call them before outbound requests whose URL is caller- or content-controlled. `createHttpClient` handles auth and retries, but it does not validate URLs.
- `egress-policy.ts` (`@lobu/connector-sdk/egress-policy`) is the ONE egress pattern grammar and decision order for host-mediated egress: the gateway proxy, the grant and policy stores, the remote runtime provider and the connector isolate lane (`fetch` and `socketOpen`) all match hosts through it. It is pure (no `node:`, no `@lobu/core`) so the same code runs on the Node host, inside an isolate, and on workerd. Change the grammar here or nowhere; configured patterns are normalized once by `@lobu/core`'s `normalizeDomainPattern`. The address axis (`EgressAddressPolicy` / `isBlockedIp` in `ip-reachability.ts`) is the same story: `block-private` vs `allow-private`, with cloud metadata refused under both, defined once and read by the transport.

## Browser automation
- The stealth layer exists to look like a real browser; patchright (not vanilla playwright) is deliberate. Do not "fix" the alias in `package.json` — install revision and runtime revision must match, or Chromium fails to launch.
- `launcher.ts` distinguishes two failure modes: a `PLAYWRIGHT_BROWSERS_PATH` mismatch versus an unresolvable package. When a launch fails, read which error you got before debugging — see `docs/GOTCHAS.md`, "Browser & connectors", for the Docker/install invariants behind it.
- CDP (`cdp.ts`, `cdp-page.ts`) and the extension scrape paths (`extension-dom-scrape.ts`, `extension-network.ts`) are different backends with different auth stories. Extension paths reach the user's real logged-in sessions; local Playwright/CDP does not.

## Package-specific traps
- This package is **biome-excluded** (`config/biome.config.json`). Never run biome on it — edit surgically, matching each file's existing style. See `docs/GOTCHAS.md`, "Formatting & lint".
- A new workspace package that imports this SDK must appear after connector-sdk in all three build lists — see `docs/GOTCHAS.md`, "Build & typecheck".

## Validation
- Validation: the root gates (see root `AGENTS.md`) plus targeted SDK tests. Browser changes need a real connector run, not just a unit test — a green mock proves nothing about Chromium launch.
